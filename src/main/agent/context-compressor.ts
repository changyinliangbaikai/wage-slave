/**
 * Agent 上下文压缩器
 *
 * 目的：在每轮 LLM 调用前，把过长的 history 压缩到合理大小，
 *      避免 token 爆炸 / API 报错 / 费用失控。
 *
 * 三阶段策略（都是本地确定性算法，不再额外调 LLM）：
 *   阶段 0：早期工具结果"指纹化"——保留最近 keepRecentTools 条 tool 消息完整内容，
 *           更早的 tool 消息只保留一行摘要（参考 Claude Code 的 Function Result Clearing）
 *           效果：连续读 10 个文件时只保留最近 4 个的完整内容，前 6 个折叠为引用
 *   阶段 1：单条 tool message 超过 maxToolChars 时做"头部 + 省略 + 尾部"裁剪
 *           （单次 read_file / run_command 的几万字超大输出需要切掉）
 *   阶段 2：消息条数 / 总字符数超过阈值时，折叠最早的若干条为一条"摘要消息"
 *           （保留最近 keepRecent 条作为近期上下文，保留首条 user 作为任务起点）
 *
 * 分层触发（按总字符量逐级升级压缩力度）：
 *   Level 1（chars > triggerLevel1Chars）：仅启用阶段 0（工具结果分层清理）
 *   Level 2（chars > triggerLevel2Chars）：阶段 0 + 阶段 1 + 阶段 2 （keepRecent 条）
 *   Level 3（chars > triggerLevel3Chars）：阶段 0 + 阶段 1 + 阶段 2 + 更激进的折叠（keepRecent 减半）
 *
 * 关键不变量：
 *   - 不破坏 tool_call ↔ tool_result 配对：role=tool 消息必须紧跟一条带 tool_calls
 *     的 assistant，否则 OpenAI API 会报 400。切点 cutSafe 一定落在非 tool 角色上。
 *   - 不修改原 history 数组（this.history 仍保留完整历史用于会话持久化）；
 *     本函数返回新的数组，仅供 LLM 调用本轮使用。
 */

import log from 'electron-log/main'
import type { AgentMessage } from '@shared/types'
import { getConfig } from '../store'
import { detectModelFamily, type ModelFamily } from './model-info'

/** 压缩配置 */
export interface CompressConfig {
  /** 至少保留最近多少条原始消息 */
  keepRecent: number
  /** 单条 tool message 内容最大字符数（超过则头尾截断） */
  maxToolChars: number
  /** 阶段 0：保留最近多少条 tool 结果完整内容 */
  keepRecentTools: number
  /** 阶段 0 触发的字符阈值（最轻量压缩） */
  triggerLevel1Chars: number
  /** 阶段 2 触发的字符阈值（标准压缩） */
  triggerLevel2Chars: number
  /** 激进压缩触发的字符阈值 */
  triggerLevel3Chars: number
  /** 消息条数触发整体折叠的阈值（不分层级，触发即用 Level 2 压缩） */
  triggerCount: number
}

/**
 * 默认配置（16k 上下文模型安全配置）
 * - triggerLevel1Chars = 12000 字 ≈ 3000 tokens（清理工具结果）
 * - triggerLevel2Chars = 24000 字 ≈ 6000 tokens（折叠早期消息）
 * - triggerLevel3Chars = 40000 字 ≈ 10000 tokens（激进折叠）
 */
const DEFAULT_CONFIG: CompressConfig = {
  keepRecent: 12,
  maxToolChars: 4000,
  keepRecentTools: 4,
  triggerLevel1Chars: 12000,
  triggerLevel2Chars: 24000,
  triggerLevel3Chars: 40000,
  triggerCount: 30,
}

/**
 * 自适应配置：根据当前模型推断合适的压缩参数
 *
 * 设计依据：不同模型的上下文窗口与价格不同，可以按比例放大保留预算
 *   - DeepSeek v4 等：64k+ 窗口，保留 48000 字
 *   - GPT-4o 等：128k 窗口，保留 64000 字
 *   - 默认（保守）：16k 窗口
 *
 * 模型族识别统一收敛到 agent/model-info.ts，避免与 orchestrator 漂移
 */
export function getCompressConfig(): CompressConfig {
  const cfg = getConfig()
  // agent_llm_model 为空时回退到 llm_model（主聊天模型）
  const model = cfg.agent_llm_model || cfg.llm_model
  const family = detectModelFamily(model)

  // 大窗口模型族（128k+ 上下文）：GPT-4o / Claude / Gemini / Qwen-Max / Moonshot
  const LARGE_WINDOW_FAMILIES: ReadonlySet<ModelFamily> = new Set<ModelFamily>([
    'gpt4o', 'claude', 'gemini', 'qwen-max', 'moonshot',
  ])

  if (family === 'deepseek') {
    return {
      keepRecent: 20,
      maxToolChars: 8000,
      keepRecentTools: 6,
      triggerLevel1Chars: 24000,
      triggerLevel2Chars: 48000,
      triggerLevel3Chars: 80000,
      triggerCount: 50,
    }
  }

  if (LARGE_WINDOW_FAMILIES.has(family)) {
    return {
      keepRecent: 24,
      maxToolChars: 12000,
      keepRecentTools: 8,
      triggerLevel1Chars: 36000,
      triggerLevel2Chars: 64000,
      triggerLevel3Chars: 96000,
      triggerCount: 60,
    }
  }

  return DEFAULT_CONFIG
}

/**
 * 压缩 history 用于一次 LLM 调用
 *
 * @returns 处理后的消息数组；如果未触发压缩，返回 [...history]（浅克隆）
 */
export function compressHistoryForLLM(
  history: AgentMessage[],
  config?: Partial<CompressConfig>,
): AgentMessage[] {
  const cfg: CompressConfig = { ...getCompressConfig(), ...config }
  if (history.length === 0) return []

  // 计算原始总字符数，用于决定触发哪个 Level
  const totalChars = history.reduce((s, m) => s + (m.content?.length ?? 0), 0)

  // 选择本次压缩 Level
  // Level 0 = 不压缩；Level 1 = 仅清理工具结果；Level 2 = 标准压缩；Level 3 = 激进压缩
  let level: 0 | 1 | 2 | 3 = 0
  if (totalChars > cfg.triggerLevel3Chars) level = 3
  else if (totalChars > cfg.triggerLevel2Chars || history.length > cfg.triggerCount) level = 2
  else if (totalChars > cfg.triggerLevel1Chars) level = 1

  if (level === 0) {
    return [...history]
  }
  log.info(`[CtxCompressor] 触发压缩 Level ${level}（${history.length} 条 / ${totalChars} 字）`)

  // ── 阶段 0：早期工具结果指纹化（所有 Level 都执行）──
  let processed = clearOldToolResults(history, cfg.keepRecentTools)

  // ── 阶段 1：单条 tool 输出超长 → 头尾截断（Level 2+ 执行）──
  if (level >= 2) {
    processed = processed.map(m => truncateLongToolMessage(m, cfg.maxToolChars))
  }

  // ── 阶段 2：整体折叠（Level 2+ 执行）──
  if (level >= 2) {
    // Level 3 用更激进的保留数（减半）
    const keepRecent = level === 3 ? Math.max(4, Math.floor(cfg.keepRecent / 2)) : cfg.keepRecent
    processed = collapseEarlyMessages(processed, keepRecent)
  }

  const newChars = processed.reduce((s, m) => s + (m.content?.length ?? 0), 0)
  log.info(
    `[CtxCompressor] 压缩完成 Level ${level}: ${history.length} 条 / ${totalChars} 字 → ${processed.length} 条 / ${newChars} 字`,
  )
  return processed
}

// ═══════════════════════════════════════════════════════════════
// 阶段 0：早期工具结果指纹化（Function Result Clearing）
// ═══════════════════════════════════════════════════════════════

/**
 * 保留最近 keepRecentTools 条 tool 结果完整内容，更早的清理为一行摘要
 *
 * 例子：
 *   原始：[user, asst(call_read_a), tool_a, asst(call_read_b), tool_b, asst(call_read_c), tool_c, asst]
 *   清理后（keepRecentTools=2）：[user, asst, tool_a(已清理), asst, tool_b, asst, tool_c, asst]
 *
 * 不修改 tool_call_id（保持配对），仅修改 content；同时保留工具名让 LLM 看到上下文
 */
function clearOldToolResults(history: AgentMessage[], keepRecentTools: number): AgentMessage[] {
  if (keepRecentTools <= 0) return history

  // 从后往前找出最近 keepRecentTools 条 tool 消息的索引
  const recentToolIdxs = new Set<number>()
  let foundCount = 0
  for (let i = history.length - 1; i >= 0 && foundCount < keepRecentTools; i--) {
    if (history[i].role === 'tool') {
      recentToolIdxs.add(i)
      foundCount++
    }
  }

  // 清理早期 tool 消息（不在最近列表的）
  let clearedCount = 0
  let clearedChars = 0
  const result = history.map((m, i) => {
    if (m.role === 'tool' && !recentToolIdxs.has(i) && m.content && m.content.length > 80) {
      clearedCount++
      clearedChars += m.content.length
      // 留首行作为"指纹"提示 LLM 这个 tool 调用做了什么；其余内容清理
      const firstLine = m.content.split('\n')[0].slice(0, 100)
      return {
        ...m,
        content: `[工具结果已清理 — ${m.tool_name ?? 'tool'}] ${firstLine}...\n（如需查看完整结果，请重新执行该工具调用）`,
      }
    }
    return m
  })
  if (clearedCount > 0) {
    log.info(`[CtxCompressor] 阶段 0: 清理了 ${clearedCount} 条早期工具结果，节省 ${clearedChars} 字`)
  }
  return result
}

// ═══════════════════════════════════════════════════════════════
// 阶段 1：单条 tool 输出超长 → 头尾截断
// ═══════════════════════════════════════════════════════════════

function truncateLongToolMessage(m: AgentMessage, maxToolChars: number): AgentMessage {
  if (m.role !== 'tool' || !m.content || m.content.length <= maxToolChars) return m
  const tailLen = 200
  const headLen = Math.max(200, maxToolChars - tailLen - 80)
  const omitted = m.content.length - headLen - tailLen
  const newContent =
    m.content.slice(0, headLen) +
    `\n\n...[已省略中间 ${omitted} 字以节省上下文]\n\n` +
    m.content.slice(-tailLen)
  log.info(`[CtxCompressor] 阶段 1: 截断 ${m.tool_name ?? 'tool'} ${m.content.length} → ${newContent.length} 字`)
  return { ...m, content: newContent }
}

// ═══════════════════════════════════════════════════════════════
// 阶段 2：折叠早期消息为一条摘要
// ═══════════════════════════════════════════════════════════════

function collapseEarlyMessages(
  history: AgentMessage[],
  keepRecent: number,
): AgentMessage[] {
  const totalChars = history.reduce((s, m) => s + (m.content?.length ?? 0), 0)

  // 找到一个安全切点：尾部 keepRecent 条之前；如果该位置是 role=tool 则继续往后挪
  // （因为 role=tool 必须紧跟带 tool_calls 的 assistant，否则配对断裂）
  let cutSafe = Math.max(0, history.length - keepRecent)
  while (cutSafe < history.length && history[cutSafe].role === 'tool') {
    cutSafe++
  }
  if (cutSafe >= history.length || cutSafe === 0) return history

  const folded = history.slice(0, cutSafe)
  const remaining = history.slice(cutSafe)

  // 统计工具调用次数（折叠区间内）
  const toolCounts = new Map<string, number>()
  for (const m of folded) {
    if (m.role === 'assistant' && m.tool_calls) {
      for (const tc of m.tool_calls) {
        toolCounts.set(tc.name, (toolCounts.get(tc.name) ?? 0) + 1)
      }
    }
  }
  const toolSummary = toolCounts.size > 0
    ? Array.from(toolCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([name, count]) => `${name}×${count}`)
        .join(', ')
    : '无'

  // 第一条 user：保留原始任务意图（截前 250 字）
  const firstUser = folded.find(m => m.role === 'user')
  const userIntent = firstUser ? trimOneline(firstUser.content, 250) : '(无)'

  // 最近一条"纯文本 assistant"（不带 tool_calls）：保留它的要点
  const lastAssistantText = [...folded].reverse().find(m =>
    m.role === 'assistant' && (!m.tool_calls || m.tool_calls.length === 0) && m.content,
  )
  const lastAssistText = lastAssistantText ? trimOneline(lastAssistantText.content, 300) : ''

  const summaryLines = [
    '[早期对话摘要]',
    `已折叠 ${folded.length} 条消息（共 ${totalChars} 字）以节省上下文。`,
    `用户原始诉求：${userIntent}`,
    `期间调用过的工具：${toolSummary}`,
  ]
  if (lastAssistText) {
    summaryLines.push(`折叠前最后一次助理输出要点：${lastAssistText}`)
  }

  // 用 user 角色塞摘要：相比 system，兼容性更好（部分兼容 API 只接受首条 system）
  // 用 assistant 角色又会被 LLM 当成自己的发言混淆。user 最自然。
  const summaryMsg: AgentMessage = {
    id: 'compressed-summary',
    role: 'user',
    content: summaryLines.join('\n'),
    createdAt: Date.now(),
  }

  return [summaryMsg, ...remaining]
}

/** 把多行字符串挤成单行并截到指定长度，便于放进摘要 */
function trimOneline(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  return flat.slice(0, max) + '...'
}

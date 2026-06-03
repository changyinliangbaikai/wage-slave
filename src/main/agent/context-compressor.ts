/**
 * Agent 上下文压缩器
 *
 * 目的：在每轮 LLM 调用前，把过长的 history 压缩到一个合理大小，
 *      避免 token 爆炸 / API 报错 / 费用失控。
 *
 * 两阶段策略（都是本地确定性算法，不再额外调 LLM）：
 *   阶段 1：单条 tool message 超过 maxToolChars 时做"头部 + 省略 + 尾部"裁剪
 *           （read_file、run_command、get_logs_range 等单次输出动辄上万字）
 *   阶段 2：消息条数 / 总字符数超过阈值时，折叠最早的若干条为一条"摘要消息"
 *           （保留最近 keepRecent 条作为近期上下文，保留首条 user 作为任务起点）
 *
 * 关键不变量：
 *   - 不破坏 tool_call ↔ tool_result 配对：role=tool 消息必须紧跟一条带 tool_calls
 *     的 assistant，否则 OpenAI API 会报 400。切点 cutSafe 一定落在非 tool 角色上。
 *   - 不修改原 history 数组（this.history 仍保留完整历史用于会话持久化）；
 *     本函数返回新的数组，仅供 LLM 调用本轮使用。
 */

import log from 'electron-log/main'
import type { AgentMessage } from '@shared/types'

/** 压缩配置 */
export interface CompressConfig {
  /** 至少保留最近多少条原始消息 */
  keepRecent: number
  /** 消息条数超过多少触发整体折叠 */
  triggerCount: number
  /** 总字符数超过多少触发整体折叠（粗略对应 token 数 / 4） */
  triggerChars: number
  /** 单条 tool message 内容最大字符数（超过则头尾截断） */
  maxToolChars: number
}

/**
 * 默认配置：在 16k 上下文模型上保留充分余量
 *  - 24000 字符 ≈ 6000-8000 tokens，加 system prompt(~1k) + 工具 schema 后远低于 16k 上限
 */
const DEFAULT_CONFIG: CompressConfig = {
  keepRecent: 12,
  triggerCount: 30,
  triggerChars: 24000,
  maxToolChars: 4000,
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
  const cfg: CompressConfig = { ...DEFAULT_CONFIG, ...config }
  if (history.length === 0) return []

  // ── 阶段 1：单条 tool 输出超长 → 头尾截断 ──
  // 即使整体没超阈值，单条 read_file 的几万字也要先切掉
  const truncated = history.map(m => {
    if (m.role === 'tool' && m.content.length > cfg.maxToolChars) {
      // 留头部 keep - 200，尾部 200，中间放省略提示
      const tailLen = 200
      const headLen = Math.max(200, cfg.maxToolChars - tailLen - 80)
      const omitted = m.content.length - headLen - tailLen
      const newContent =
        m.content.slice(0, headLen) +
        `\n\n...[已省略中间 ${omitted} 字以节省上下文]\n\n` +
        m.content.slice(-tailLen)
      log.info(`[CtxCompressor] 截断超长 tool 输出: ${m.tool_name ?? '?'} ${m.content.length} → ${newContent.length} 字`)
      return { ...m, content: newContent }
    }
    return m
  })

  // ── 阶段 2：判断是否需要整体折叠 ──
  const totalChars = truncated.reduce((s, m) => s + (m.content?.length ?? 0), 0)
  const triggered = truncated.length > cfg.triggerCount || totalChars > cfg.triggerChars

  if (!triggered) return truncated

  // 找到一个安全切点：尾部 keepRecent 条之前；如果该位置是 role=tool 则继续往后挪
  // （因为 role=tool 必须紧跟带 tool_calls 的 assistant，否则配对断裂）
  let cutSafe = Math.max(0, truncated.length - cfg.keepRecent)
  while (cutSafe < truncated.length && truncated[cutSafe].role === 'tool') {
    cutSafe++
  }
  // 兜底：找不到任何安全切点（理论上不会发生），原样返回
  if (cutSafe >= truncated.length || cutSafe === 0) return truncated

  const folded = truncated.slice(0, cutSafe)
  const remaining = truncated.slice(cutSafe)

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

  const compressed = [summaryMsg, ...remaining]
  const newChars = compressed.reduce((s, m) => s + (m.content?.length ?? 0), 0)
  log.info(
    `[CtxCompressor] 触发折叠: ${history.length} 条 / ${totalChars} 字 → ${compressed.length} 条 / ${newChars} 字 ` +
      `(保留最近 ${remaining.length} 条 + 1 摘要)`,
  )

  return compressed
}

/** 把多行字符串挤成单行并截到指定长度，便于放进摘要 */
function trimOneline(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  return flat.slice(0, max) + '...'
}

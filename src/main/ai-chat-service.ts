/**
 * 通用 LLM 流式调用服务（主进程，底层基础库）
 *
 * 历史背景：本文件曾承担「快速对话」窗口的流式 SSE 实现。该模式合并到 Agent
 * 后（见 plan/next-steps-optimization.md §1），快速对话已废弃。本模块继续作为
 * 无工具依赖的通用 LLM 调用基础库被复用：
 *   - 晨间复盘 / 晚间复盘 / 定时总结
 *   - 后续 /compact 永久摘要命令
 *
 * 能力：
 *  1. 基于 OpenAI 兼容接口的流式对话（SSE）
 *  2. 支持 thinking / reasoning：
 *      - OpenAI 风格 <think>...</think> 块 → 拆分到 reasoning
 *      - 部分服务商（DeepSeek、Qwen、MiniMax）通过 delta.reasoning_content 字段返回 → 直接合并到 reasoning
 *  3. Token 统计：
 *      - 优先使用 API 返回的 usage（stream_options: { include_usage: true }）
 *      - 未返回时用本地启发式估算（中文按字符、英文按 4 字符≈1 token）
 *      - 计算每秒 token 生成速度、首 token 延迟、总耗时
 *  4. 支持通过 AbortController 中断
 */

import { getConfig } from './store'
import type {
  AIChatRequest,
  AIChatStats,
  AIChatChunkPayload,
  AIChatDonePayload,
  AIChatErrorPayload,
} from '@shared/types'

/**
 * 启发式 token 估算（fallback）
 * 规则：CJK 字符 1:1，其它按 4 字符 ≈ 1 token
 */
function estimateTokens(text: string): number {
  if (!text) return 0
  let cjk = 0
  let other = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    // CJK 统一汉字、假名、韩文音节 等常用区间
    if (
      (code >= 0x3040 && code <= 0x9fff) ||
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0x20000 && code <= 0x2ffff)
    ) {
      cjk++
    } else {
      other++
    }
  }
  return cjk + Math.ceil(other / 4)
}

/** 将一组消息的文本合并估算 token 数 */
function estimatePromptTokens(messages: Array<{ role: string; content: string }>): number {
  // 每条消息加 4 token 的 overhead（OpenAI 官方公式近似）
  return messages.reduce((sum, m) => sum + estimateTokens(m.content) + 4, 2)
}

// ── 活跃请求登记表（用于中断） ─────────────────
const activeControllers = new Map<string, AbortController>()

export function abortChat(requestId: string): boolean {
  const ctrl = activeControllers.get(requestId)
  if (!ctrl) return false
  ctrl.abort()
  activeControllers.delete(requestId)
  return true
}

export interface AIChatCallbacks {
  onChunk: (payload: AIChatChunkPayload) => void
  onDone: (payload: AIChatDonePayload) => void
  onError: (payload: AIChatErrorPayload) => void
}

/**
 * 解析 <think>...</think> 边界的简易状态机
 * 每次追加 delta 后调用，将 delta 拆分到 reasoning / content 两个通道
 */
class ThinkSplitter {
  private inThink = false
  private buffer = ''

  /** 追加一个 delta，返回本次新增的 reasoning / content */
  push(delta: string): { reasoning: string; content: string } {
    let reasoning = ''
    let content = ''
    this.buffer += delta

    while (this.buffer.length > 0) {
      if (this.inThink) {
        const end = this.buffer.indexOf('</think>')
        if (end === -1) {
          // 未闭合但要防止 </think 标签被截断在 buffer 末尾：保留最后 8 字符
          const safeLen = Math.max(0, this.buffer.length - 8)
          reasoning += this.buffer.slice(0, safeLen)
          this.buffer = this.buffer.slice(safeLen)
          break
        }
        reasoning += this.buffer.slice(0, end)
        this.buffer = this.buffer.slice(end + '</think>'.length)
        this.inThink = false
      } else {
        const start = this.buffer.indexOf('<think>')
        if (start === -1) {
          // 同样防止 <think 被截断
          const safeLen = Math.max(0, this.buffer.length - 7)
          content += this.buffer.slice(0, safeLen)
          this.buffer = this.buffer.slice(safeLen)
          break
        }
        content += this.buffer.slice(0, start)
        this.buffer = this.buffer.slice(start + '<think>'.length)
        this.inThink = true
      }
    }

    return { reasoning, content }
  }

  /** 在流结束时强制刷新 buffer */
  flush(): { reasoning: string; content: string } {
    if (this.buffer.length === 0) return { reasoning: '', content: '' }
    const rest = this.buffer
    this.buffer = ''
    return this.inThink ? { reasoning: rest, content: '' } : { reasoning: '', content: rest }
  }
}

/**
 * 发起一次流式对话
 */
export async function startChat(
  req: AIChatRequest,
  apiKey: string,
  cb: AIChatCallbacks,
): Promise<void> {
  const config = getConfig()
  const baseUrl = config.llm_api_url.replace(/\/$/, '')
  const { requestId, messages } = req

  if (!apiKey) {
    cb.onError({ requestId, error: '未配置 API Key，请前往「设置」填写' })
    return
  }

  // 拼装最终要发送的消息列表（按需插入 system prompt）
  // 优先级：request 里的 system 消息（来自角色预设） > 全局 config.ai_chat_system_prompt
  const finalMessages: Array<{ role: string; content: string }> = []
  const reqHasSystem = messages.some(m => m.role === 'system')
  if (!reqHasSystem && config.ai_chat_system_prompt?.trim()) {
    finalMessages.push({ role: 'system', content: config.ai_chat_system_prompt.trim() })
  }
  for (const m of messages) {
    finalMessages.push({ role: m.role, content: m.content })
  }

  console.log(
    `[AIChat] 发起请求 requestId=${requestId}, 历史消息数=${finalMessages.length}, model=${config.llm_model}`,
  )

  const controller = new AbortController()
  activeControllers.set(requestId, controller)

  const startedAt = Date.now()
  let firstTokenAt = 0
  let fullContent = ''
  let fullReasoning = ''
  let usagePrompt = 0
  let usageCompletion = 0
  let usageFromApi = false
  const splitter = new ThinkSplitter()

  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: config.llm_model,
        messages: finalMessages,
        temperature: 0.7,
        stream: true,
        // 要求服务端在最后一个 chunk 中返回 usage（OpenAI / 多数兼容服务均支持）
        stream_options: { include_usage: true },
      }),
      signal: controller.signal,
    })

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      const err = `API 返回 ${res.status}: ${text.slice(0, 200)}`
      console.error('[AIChat]', err)
      cb.onError({ requestId, error: err })
      return
    }

    if (!res.body) {
      cb.onError({ requestId, error: '响应 body 为空' })
      return
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let sseBuffer = ''

    outer: while (true) {
      const { done, value } = await reader.read()
      if (done) break

      sseBuffer += decoder.decode(value, { stream: true })

      // SSE 以 \n\n 分隔事件；按行解析以兼容仅 \n 或 \r\n 的实现
      const lines = sseBuffer.split('\n')
      sseBuffer = lines.pop() ?? '' // 留下不完整行

      for (const rawLine of lines) {
        const line = rawLine.trimEnd()
        if (!line || line.startsWith(':')) continue // 空行或注释
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (data === '[DONE]') break outer

        let chunk: any
        try {
          chunk = JSON.parse(data)
        } catch {
          continue
        }

        // usage 块：可能在最后一个 chunk 中单独返回（choices 为空）
        if (chunk.usage && typeof chunk.usage.prompt_tokens === 'number') {
          usagePrompt = chunk.usage.prompt_tokens
          usageCompletion = chunk.usage.completion_tokens ?? usageCompletion
          usageFromApi = true
        }

        const delta = chunk.choices?.[0]?.delta
        if (!delta) continue

        // 1) reasoning_content（DeepSeek / Qwen / MiniMax 等）
        const reasoningDelta: string = delta.reasoning_content ?? delta.reasoning ?? ''
        if (reasoningDelta) {
          if (!firstTokenAt) firstTokenAt = Date.now()
          fullReasoning += reasoningDelta
        }

        // 2) 正式回复 content，通过 ThinkSplitter 自动拆出内嵌 <think> 块
        const contentDelta: string = delta.content ?? ''
        if (contentDelta) {
          if (!firstTokenAt) firstTokenAt = Date.now()
          const parts = splitter.push(contentDelta)
          if (parts.reasoning) fullReasoning += parts.reasoning
          if (parts.content) fullContent += parts.content
        }

        if (reasoningDelta || contentDelta) {
          cb.onChunk({ requestId, content: fullContent, reasoning: fullReasoning })
        }
      }
    }

    // flush 剩余 buffer
    const tail = splitter.flush()
    if (tail.reasoning) fullReasoning += tail.reasoning
    if (tail.content) fullContent += tail.content

    // ── 组装统计 ──────────────────────────────
    const endAt = Date.now()
    const totalDurationMs = endAt - startedAt
    const firstTokenLatency = firstTokenAt ? firstTokenAt - startedAt : totalDurationMs

    if (!usageFromApi) {
      usagePrompt = estimatePromptTokens(finalMessages)
      // 输出 token 也按启发式估算（包含 reasoning 文本更贴近真实计费）
      usageCompletion = estimateTokens(fullReasoning) + estimateTokens(fullContent)
    }

    // 生成阶段耗时（去掉首 token 前的排队/网络时延，更贴近"生成速度"语义）
    const genDurationMs = Math.max(1, endAt - (firstTokenAt || startedAt))
    const tokensPerSecond = +(usageCompletion / (genDurationMs / 1000)).toFixed(2)

    const stats: AIChatStats = {
      promptTokens: usagePrompt,
      completionTokens: usageCompletion,
      tokensPerSecond: isFinite(tokensPerSecond) ? tokensPerSecond : 0,
      firstTokenLatency,
      totalDurationMs,
      fromApiUsage: usageFromApi,
    }

    console.log(
      `[AIChat] 完成 requestId=${requestId}, in=${stats.promptTokens}, out=${stats.completionTokens}, ${stats.tokensPerSecond} tok/s, ttft=${firstTokenLatency}ms`,
    )

    cb.onDone({ requestId, content: fullContent, reasoning: fullReasoning, stats })
  } catch (e: unknown) {
    // AbortError：用户主动停止，按"完成"处理（带当前已累计数据 + 统计）
    if ((e as { name?: string } | undefined)?.name === 'AbortError') {
      const tail = splitter.flush()
      if (tail.reasoning) fullReasoning += tail.reasoning
      if (tail.content) fullContent += tail.content

      const endAt = Date.now()
      const totalDurationMs = endAt - startedAt
      const firstTokenLatency = firstTokenAt ? firstTokenAt - startedAt : totalDurationMs
      const genDurationMs = Math.max(1, endAt - (firstTokenAt || startedAt))
      if (!usageFromApi) {
        usagePrompt = estimatePromptTokens(finalMessages)
        usageCompletion = estimateTokens(fullReasoning) + estimateTokens(fullContent)
      }
      const tokensPerSecond = +(usageCompletion / (genDurationMs / 1000)).toFixed(2)

      console.log(`[AIChat] 用户中断 requestId=${requestId}`)
      cb.onDone({
        requestId,
        content: fullContent,
        reasoning: fullReasoning,
        stats: {
          promptTokens: usagePrompt,
          completionTokens: usageCompletion,
          tokensPerSecond: isFinite(tokensPerSecond) ? tokensPerSecond : 0,
          firstTokenLatency,
          totalDurationMs,
          fromApiUsage: usageFromApi,
        },
      })
      return
    }
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[AIChat] 请求失败:', msg)
    cb.onError({ requestId, error: msg })
  } finally {
    activeControllers.delete(requestId)
  }
}

/**
 * 非流式快速 LLM 调用（用于 /compact 摘要等场景）
 * 与 startChat 共用底层配置，但只返回最终文本，不做事件推送
 */
export async function summarizeOnce(opts: {
  apiKey: string
  systemPrompt: string
  userPrompt: string
  maxTokens?: number
  temperature?: number
}): Promise<string> {
  const { apiKey, systemPrompt, userPrompt, maxTokens = 800, temperature = 0.3 } = opts
  const config = getConfig()
  const baseUrl = config.llm_api_url.replace(/\/$/, '')
  if (!apiKey) throw new Error('未配置 API Key')

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: config.llm_model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature,
      max_tokens: maxTokens,
    }),
    signal: AbortSignal.timeout(60_000),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`API ${res.status}: ${text.slice(0, 200)}`)
  }
  const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> }
  const raw = data.choices?.[0]?.message?.content ?? ''
  // 复用前端 strip 思路：去掉 <think>...</think> 推理块
  return raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
}

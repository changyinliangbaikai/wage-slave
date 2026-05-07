/**
 * 错别字检查工具
 * - 文件读取（txt/md/docx/doc）
 * - 调用 LLM API 检查错别字
 */

import * as fs from 'fs'
import * as path from 'path'
import mammoth from 'mammoth'
import type { FileReadResult, SpellCheckError } from '@shared/types'
import { getConfig } from '../store'

// ── 尝试加载 keytar（安全存储 API Key）──────────
let keytar: typeof import('keytar') | null = null
try {
  keytar = require('keytar')
} catch {
  console.warn('[SpellCheck] keytar 未安装')
}

const KEYTAR_SERVICE = 'xiao-niu-ma'
const KEYTAR_ACCOUNT = 'llm-api-key'

/**
 * 获取 API Key
 */
async function getAPIKey(): Promise<string> {
  if (keytar) {
    return (await keytar.getPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT)) ?? ''
  }
  return ''
}

const SPELL_CHECK_SYSTEM = `你是一个专业的文字校对助手。

你的任务是检查用户输入的中文文本，找出其中的错别字和词语错误问题。

输出格式（严格按 JSON 数组返回）：
[
  {
    "start": 0,           // 错误文字在原文中的起始位置（字符索引，从0开始）
    "end": 2,             // 错误文字在原文中的结束位置（不含该位置）
    "original": "错字",   // 原文中的错误部分
    "correction": "错词", // 建议的修正
    "reason": "错字应改为..." // 修正理由（简短）
  }
]

规则：
1. 只返回确实错误的内容，不要过度纠正
2. 如果文本没有错误，返回空数组 []
3. 注意区分同音字错误、形近字错误、词语搭配错误
4. start 和 end 必须是准确的字符索引，用于高亮显示
5. 只输出 JSON 数组，不要任何其他文字`

/**
 * 根据文件扩展名判断文件类型
 */
function getFileType(filePath: string): 'txt' | 'md' | 'docx' | 'doc' {
  const ext = path.extname(filePath).toLowerCase()
  switch (ext) {
    case '.txt':
      return 'txt'
    case '.md':
      return 'md'
    case '.docx':
      return 'docx'
    case '.doc':
      return 'doc'
    default:
      return 'txt'
  }
}

/**
 * 读取文件内容
 */
export async function readFileContent(filePath: string): Promise<FileReadResult> {
  const fileType = getFileType(filePath)
  const fileName = path.basename(filePath)

  let content: string

  if (fileType === 'txt' || fileType === 'md') {
    // 文本文件直接读取
    content = fs.readFileSync(filePath, 'utf-8')
  } else if (fileType === 'docx') {
    // docx 使用 mammoth 解析
    const result = await mammoth.extractRawText({ path: filePath })
    content = result.value
  } else if (fileType === 'doc') {
    // doc 格式也使用 mammoth（需要 antiy 格式支持）
    const result = await mammoth.extractRawText({ path: filePath })
    content = result.value
  } else {
    throw new Error(`不支持的文件类型: ${fileType}`)
  }

  return {
    fileName,
    content,
    fileType,
  }
}

/**
 * 错别字检查
 *
 * - 调用主进程内的 LLM `chat/completions`，支持流式（onChunk 推送已累计 content/reasoning）。
 * - 兼容带 thinking 的模型（DeepSeek-R1 / Qwen-Thinking / MiniMax-M1）：
 *     - delta.reasoning_content 累计到 reasoning 通道
 *     - delta.content 走 content 通道
 * - 全量日志通过 `console.*` 经 electron-log 写入应用日志文件，便于"卡在检查中..."时排查。
 * - 通过 `externalSignal` 支持用户中途取消。
 */
const SPELL_CHECK_TIMEOUT_MS = 300000 // 5 分钟兜底超时

/** 流式回调：分别返回当前累计的正文与思考过程文本 */
export interface SpellCheckStreamPayload {
  content: string
  reasoning: string
}

export async function spellCheck(
  text: string,
  onChunk?: (payload: SpellCheckStreamPayload) => void,
  externalSignal?: AbortSignal,
): Promise<{ errors: SpellCheckError[]; error?: string }> {
  const config = getConfig()
  const apiKey = await getAPIKey()
  const startedAt = Date.now()
  const useStream = onChunk !== undefined

  if (!apiKey) {
    console.warn('[SpellCheck] 未配置 API Key')
    return { errors: [], error: '未配置 API Key，请在设置中配置' }
  }

  const baseUrl = config.llm_api_url.replace(/\/$/, '')
  console.log(
    `[SpellCheck] 开始检查 | model=${config.llm_model} | url=${baseUrl}/chat/completions | stream=${useStream} | textLen=${text.length}`,
  )

  // ── 合并外部取消信号 + 超时 ───────────────────
  const ctrl = new AbortController()
  const timer = setTimeout(() => {
    console.warn(`[SpellCheck] 触发本地超时 ${SPELL_CHECK_TIMEOUT_MS}ms，主动 abort`)
    ctrl.abort()
  }, SPELL_CHECK_TIMEOUT_MS)
  const onExternalAbort = () => {
    console.log('[SpellCheck] 收到外部取消请求')
    ctrl.abort()
  }
  if (externalSignal) {
    if (externalSignal.aborted) ctrl.abort()
    else externalSignal.addEventListener('abort', onExternalAbort, { once: true })
  }

  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: config.llm_model,
        messages: [
          { role: 'system', content: SPELL_CHECK_SYSTEM },
          { role: 'user', content: text },
        ],
        temperature: 0.1,
        max_tokens: 20000,
        stream: useStream,
      }),
      signal: ctrl.signal,
    })

    console.log(`[SpellCheck] HTTP ${res.status} ${res.statusText} | 耗时 ${Date.now() - startedAt}ms`)

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      console.error('[SpellCheck] API 错误响应:', body.slice(0, 500))
      return { errors: [], error: `API 返回 ${res.status}: ${body.slice(0, 120)}` }
    }

    if (useStream) {
      // ── 流式处理（OpenAI 兼容 SSE） ───────────
      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      // sseBuffer：用于跨 read() 拼接被截断的 SSE 行；之前每个 chunk 单独 split 会丢数据
      let sseBuffer = ''
      let content = ''
      let reasoning = ''
      let chunkCount = 0
      let firstTokenAt = 0
      let lastLogAt = Date.now()

      outer: while (true) {
        const { done, value } = await reader.read()
        if (done) break

        sseBuffer += decoder.decode(value, { stream: true })
        // 按行切分，最后一行可能不完整 → 留回 buffer
        const lines = sseBuffer.split('\n')
        sseBuffer = lines.pop() ?? ''

        for (const rawLine of lines) {
          const line = rawLine.trimEnd()
          if (!line || line.startsWith(':')) continue
          if (!line.startsWith('data:')) continue
          const json = line.slice(5).trim()
          if (json === '[DONE]') break outer

          let parsed: { choices?: Array<{ delta?: Record<string, unknown> }> }
          try {
            parsed = JSON.parse(json)
          } catch {
            continue
          }

          const delta = parsed.choices?.[0]?.delta
          if (!delta) continue

          // 1) 推理通道（DeepSeek/Qwen/MiniMax 等带 thinking 的模型）
          const reasoningDelta = (delta.reasoning_content ?? delta.reasoning ?? '') as string
          if (reasoningDelta) {
            if (!firstTokenAt) firstTokenAt = Date.now()
            reasoning += reasoningDelta
            chunkCount += 1
          }

          // 2) 正文通道
          const contentDelta = (delta.content ?? '') as string
          if (contentDelta) {
            if (!firstTokenAt) firstTokenAt = Date.now()
            content += contentDelta
            chunkCount += 1
          }

          if (reasoningDelta || contentDelta) {
            onChunk!({ content, reasoning })
          }
        }

        // 每 2s 一条心跳，区分 thinking / output 两个阶段
        if (Date.now() - lastLogAt > 2000) {
          const ttft = firstTokenAt ? `${firstTokenAt - startedAt}ms` : 'pending'
          console.log(
            `[SpellCheck] 流式接收中: chunks=${chunkCount} reasoning=${reasoning.length} content=${content.length} ttft=${ttft}`,
          )
          lastLogAt = Date.now()
        }
      }

      const ttft = firstTokenAt ? firstTokenAt - startedAt : -1
      console.log(
        `[SpellCheck] 流式结束 | chunks=${chunkCount} | reasoning=${reasoning.length} | content=${content.length} | ttft=${ttft}ms | 总耗时 ${Date.now() - startedAt}ms`,
      )
      // 仅对 content 做结构化解析；reasoning 仅供进度展示
      const result = parseSpellCheckResult(content || reasoning)
      console.log(`[SpellCheck] 解析完成 | errors=${result.errors.length}${result.error ? ` | parseError=${result.error}` : ''}`)
      return result
    } else {
      // ── 非流式处理 ─────────────────────────
      const data = await res.json()
      const raw: string = data.choices?.[0]?.message?.content ?? '[]'
      console.log(
        `[SpellCheck] 非流式完成 | 总耗时 ${Date.now() - startedAt}ms | rawLen=${raw.length} | preview=${raw.slice(0, 120).replace(/\n/g, ' ')}`,
      )
      const parsed = parseSpellCheckResult(raw)
      console.log(`[SpellCheck] 解析完成 | errors=${parsed.errors.length}${parsed.error ? ` | parseError=${parsed.error}` : ''}`)
      return parsed
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const aborted = ctrl.signal.aborted
    if (aborted && externalSignal?.aborted) {
      console.log(`[SpellCheck] 用户已取消 | 耗时 ${Date.now() - startedAt}ms`)
      return { errors: [], error: '已取消' }
    }
    console.error(`[SpellCheck] 请求失败 | 耗时 ${Date.now() - startedAt}ms | error=${msg}`, e)
    return { errors: [], error: msg }
  } finally {
    clearTimeout(timer)
    if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort)
  }
}

/**
 * 解析错别字检查结果
 */
function parseSpellCheckResult(raw: string): { errors: SpellCheckError[]; error?: string } {
  // 清理可能存在的 <think> 块
  let cleaned = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()

  // 尝试提取 JSON 数组
  try {
    // 先尝试提取 ```json ... ``` 代码块
    const codeBlock = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (codeBlock) {
      cleaned = codeBlock[1].trim()
    }

    const parsed = JSON.parse(cleaned)
    if (!Array.isArray(parsed)) {
      return { errors: [], error: '返回格式异常' }
    }

    const errors: SpellCheckError[] = parsed.map((item: Record<string, unknown>) => ({
      start: typeof item.start === 'number' ? item.start : 0,
      end: typeof item.end === 'number' ? item.end : 0,
      original: String(item.original ?? ''),
      correction: String(item.correction ?? ''),
      reason: item.reason ? String(item.reason) : undefined,
    }))

    return { errors }
  } catch {
    // 如果解析失败，尝试直接解析
    try {
      const parsed = JSON.parse(cleaned)
      if (Array.isArray(parsed)) {
        return {
          errors: parsed.map((item: Record<string, unknown>) => ({
            start: typeof item.start === 'number' ? item.start : 0,
            end: typeof item.end === 'number' ? item.end : 0,
            original: String(item.original ?? ''),
            correction: String(item.correction ?? ''),
            reason: item.reason ? String(item.reason) : undefined,
          })),
        }
      }
    } catch { /* ignore */ }

    return { errors: [], error: '解析结果失败' }
  }
}

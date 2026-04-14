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
 */
export async function spellCheck(
  text: string,
  onChunk?: (accumulated: string) => void,
): Promise<{ errors: SpellCheckError[]; error?: string }> {
  const config = getConfig()
  const apiKey = await getAPIKey()

  if (!apiKey) {
    return { errors: [], error: '未配置 API Key，请在设置中配置' }
  }

  const baseUrl = config.llm_api_url.replace(/\/$/, '')

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
        stream: onChunk !== undefined,
      }),
      signal: AbortSignal.timeout(300000),
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      return { errors: [], error: `API 返回 ${res.status}: ${body.slice(0, 120)}` }
    }

    if (onChunk) {
      // 流式处理
      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let accumulated = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        const chunk = decoder.decode(value, { stream: true })
        const lines = chunk.split('\n').filter(l => l.startsWith('data: '))

        for (const line of lines) {
          const json = line.slice(6).trim()
          if (json === '[DONE]') break
          try {
            const delta = JSON.parse(json)
            const content = delta.choices?.[0]?.delta?.content ?? ''
            accumulated += content
            onChunk(accumulated)
          } catch { /* 跳过非 JSON 行 */ }
        }
      }

      // 解析最终结果
      return parseSpellCheckResult(accumulated)
    } else {
      // 非流式处理
      const data = await res.json()
      const raw: string = data.choices?.[0]?.message?.content ?? '[]'
      return parseSpellCheckResult(raw)
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { errors: [], error: msg }
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

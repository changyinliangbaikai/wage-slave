/**
 * LLM 调用 Hook
 * 封装 OpenAI 兼容格式的 API 调用，包含计划解析和总结生成
 */

import { useState, useCallback } from 'react'
import { getConfig, getAPIKey } from './useIPC'
import type { TodoItem, DailyLog } from '@shared/types'

// ── 晨间计划解析 Prompt ─────────────────────────
const PARSE_PLAN_SYSTEM = `你是一个工作计划解析助手。

你的任务是将用户输入的今日工作计划（自然语言）解析为结构化的待办清单，以 JSON 数组形式返回。

输出格式：
[{"id":"1","title":"任务名称","priority":"high|medium|low","estimated_min":60,"status":"pending"}]

解析规则：
1. 一句话可能包含多个任务，请拆分为独立条目
2. 时间词优先级：上午/早点/先→high，下午/之后/然后→medium，晚点/顺便/抽空→low
3. 无时间标记时默认 priority: "medium"
4. 预估时间：会议60-120分钟，邮件15-30分钟，文档60-180分钟，不确定填null
5. 输入极简时（如"开会"）也要正常解析，不要拒绝
6. 不是工作计划时（如只是打招呼）返回 []
7. 只输出JSON数组，不要任何其他文字或markdown标记`

// ── 总结生成 Prompt ────────────────────────────
const SUMMARY_SYSTEM = `你是一个专业的工作总结撰写助手。

你将收到用户某段时间的每日工作日志，请整理归纳生成工作总结。

严格按以下 Markdown 格式输出：

## 工作总结（{时间范围}）

### 一、工作概览
（2-3句话，整体概括）

### 二、主要工作内容
（按项目/主题归类，不按日期罗列）

#### 【主题名称】
（内容描述）

### 三、工作亮点
· 亮点1
· 亮点2

### 四、问题与不足
· 问题1

### 五、下阶段计划
· 计划1
· 计划2

规则：严格基于日志内容，不虚构信息；口语化表达转为书面语；按主题归类，不按日期罗列。`

// ── 工具函数 ──────────────────────────────────
function extractJSON(text: string): string {
  const match = text.match(/\[[\s\S]*\]/)
  return match ? match[0] : '[]'
}

function fallbackTodo(input: string): TodoItem[] {
  if (!input.trim()) return []
  return [{
    id: '1',
    title: input.slice(0, 50),
    priority: 'medium',
    estimated_min: null,
    status: 'pending',
  }]
}

// ── Hook: 计划解析 ─────────────────────────────
export function useParsePlan() {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const parse = useCallback(async (input: string): Promise<TodoItem[]> => {
    if (!input.trim()) return []
    setLoading(true)
    setError(null)

    try {
      const [config, apiKey] = await Promise.all([getConfig(), getAPIKey()])
      const baseUrl = config.llm_api_url.replace(/\/$/, '')

      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: config.llm_model,
          messages: [
            { role: 'system', content: PARSE_PLAN_SYSTEM },
            { role: 'user', content: input },
          ],
          temperature: 0.2,
          max_tokens: 800,
        }),
        signal: AbortSignal.timeout(15000),
      })

      if (!res.ok) throw new Error(`API 返回 ${res.status}`)

      const data = await res.json()
      const raw = data.choices?.[0]?.message?.content ?? '[]'
      const jsonStr = extractJSON(raw)
      const parsed = JSON.parse(jsonStr)

      if (!Array.isArray(parsed)) return fallbackTodo(input)

      return parsed.map((item: Record<string, unknown>, i: number): TodoItem => ({
        id: String(i + 1),
        title: String(item.title ?? '未命名任务').slice(0, 50),
        priority: (['high', 'medium', 'low'] as const).includes(item.priority as 'high')
          ? item.priority as TodoItem['priority']
          : 'medium',
        estimated_min: typeof item.estimated_min === 'number' ? item.estimated_min : null,
        status: 'pending',
      }))

    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg)
      return fallbackTodo(input)
    } finally {
      setLoading(false)
    }
  }, [])

  return { parse, loading, error }
}

// ── Hook: 总结生成（流式） ──────────────────────
export function useGenerateSummary() {
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState('')
  const [error, setError] = useState<string | null>(null)

  const generate = useCallback(async (logs: DailyLog[], periodLabel: string) => {
    setLoading(true)
    setResult('')
    setError(null)

    try {
      const [config, apiKey] = await Promise.all([getConfig(), getAPIKey()])
      const baseUrl = config.llm_api_url.replace(/\/$/, '')

      // 构造日志文本
      const logText = logs
        .sort((a, b) => a.date.localeCompare(b.date))
        .map(log => {
          const todos = log.todos
            .map(t => `  - [${t.status === 'done' ? '✓' : '✗'}] ${t.title}`)
            .join('\n')
          const eod = log.eod_log ? `  工作记录：${log.eod_log}` : ''
          return `### ${log.date}\n${todos}\n${eod}`.trim()
        })
        .join('\n\n')

      const userPrompt = `以下是我 ${periodLabel} 的每日工作日志，请帮我生成工作总结：\n\n${logText}`

      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: config.llm_model,
          messages: [
            { role: 'system', content: SUMMARY_SYSTEM },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0.5,
          max_tokens: 2000,
          stream: true,
        }),
        signal: AbortSignal.timeout(60000),
      })

      if (!res.ok) throw new Error(`API 返回 ${res.status}`)

      // 处理流式输出
      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let accumulated = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        const chunk = decoder.decode(value, { stream: true })
        const lines = chunk.split('\n').filter(l => l.startsWith('data: '))

        for (const line of lines) {
          const json = line.slice(6)
          if (json === '[DONE]') break
          try {
            const delta = JSON.parse(json)
            const content = delta.choices?.[0]?.delta?.content ?? ''
            accumulated += content
            setResult(accumulated)
          } catch { /* 跳过非 JSON 行 */ }
        }
      }

    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg)
    } finally {
      setLoading(false)
    }
  }, [])

  return { generate, loading, result, error }
}

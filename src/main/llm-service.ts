/**
 * LLM 调用服务（主进程）
 * 在主进程中调用外部 API，绕过渲染进程的 CORS 限制
 */

import type { TodoItem, DailyLog } from '@shared/types'
import { getConfig } from './store'

/**
 * 清除 <think>...</think> 推理块
 * 同时处理已闭合和未闭合（流式传输中途）的情况
 */
function stripThinkBlocks(text: string): string {
  // 清除已闭合的 <think>...</think> 块
  let result = text.replace(/<think>[\s\S]*?<\/think>/gi, '')
  // 清除未闭合的 <think>...（流式传输中尚未收到 </think>）
  result = result.replace(/<think>[\s\S]*$/gi, '')
  // 清除残留标签
  result = result.replace(/<\/?think>/gi, '')
  // 清除开头空白行
  result = result.replace(/^\s*\n+/, '')
  return result
}

// ── Prompt ──────────────────────────────────────

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
  // 1. 去掉 <think>...</think> 推理块（MiniMax 等模型会返回）
  let cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()

  // 2. 尝试提取 ```json ... ``` 代码块
  const codeBlock = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (codeBlock) return codeBlock[1].trim()

  // 3. 提取裸 JSON 数组（用非贪婪匹配最后一个完整的 [...] ）
  //    找到所有 [...] 候选，取最长的那个
  const candidates: string[] = []
  const re = /\[[\s\S]*?\]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(cleaned)) !== null) {
    // 验证是否是有效 JSON
    try {
      JSON.parse(m[0])
      candidates.push(m[0])
    } catch { /* 不是有效 JSON，跳过 */ }
  }

  if (candidates.length > 0) {
    // 返回最长的有效 JSON 数组（通常是包含所有条目的那个）
    return candidates.reduce((a, b) => a.length >= b.length ? a : b)
  }

  return '[]'
}

function makeFallback(input: string): TodoItem[] {
  if (!input.trim()) return []
  // 按换行、分号、句号分割（不按逗号/顿号，因为它们常在同一任务描述内部）
  const lines = input.split(/[\n；;。]/).map(s => s.trim()).filter(Boolean)
  return lines.map((line, i) => ({
    id: String(i + 1),
    title: line.slice(0, 50),
    priority: 'medium' as const,
    estimated_min: null,
    status: 'pending' as const,
  }))
}

// ── 计划解析 ──────────────────────────────────

export async function parsePlan(input: string, apiKey: string): Promise<{ todos: TodoItem[]; error?: string }> {
  if (!input.trim()) return { todos: [] }

  const config = getConfig()
  const baseUrl = config.llm_api_url.replace(/\/$/, '')

  if (!apiKey) {
    return { todos: makeFallback(input), error: '未配置 API Key，使用简单拆分' }
  }

  try {
    console.log('[LLM] 解析计划，输入：', input.slice(0, 80))

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
      signal: AbortSignal.timeout(20000),
    })

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      const errMsg = `API 返回 ${res.status}: ${text.slice(0, 120)}`
      console.error('[LLM]', errMsg)
      return { todos: makeFallback(input), error: errMsg }
    }

    const data = await res.json()
    const raw: string = data.choices?.[0]?.message?.content ?? '[]'
    console.log('[LLM] 原始返回：', raw.slice(0, 200))

    const jsonStr = extractJSON(raw)
    const parsed = JSON.parse(jsonStr)

    if (!Array.isArray(parsed) || parsed.length === 0) {
      return { todos: makeFallback(input), error: 'LLM 返回格式异常，使用简单拆分' }
    }

    const todos: TodoItem[] = parsed.map((item: Record<string, unknown>, i: number) => ({
      id: String(i + 1),
      title: String(item.title ?? '未命名任务').slice(0, 50),
      priority: (['high', 'medium', 'low'] as const).includes(item.priority as 'high')
        ? item.priority as TodoItem['priority']
        : 'medium',
      estimated_min: typeof item.estimated_min === 'number' ? item.estimated_min : null,
      status: 'pending',
    }))

    console.log('[LLM] 解析出', todos.length, '条待办')
    return { todos }

  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[LLM] 解析失败：', msg)
    return { todos: makeFallback(input), error: msg }
  }
}

// ── 总结生成（流式，通过回调推送增量） ──────────

export async function generateSummary(
  logs: DailyLog[],
  periodLabel: string,
  apiKey: string,
  onChunk: (accumulated: string) => void,
): Promise<{ result: string; error?: string }> {

  const config = getConfig()
  const baseUrl = config.llm_api_url.replace(/\/$/, '')

  if (!apiKey) {
    return { result: '', error: '未配置 API Key' }
  }

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
          { role: 'system', content: SUMMARY_SYSTEM },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.5,
        max_tokens: 2000,
        stream: true,
      }),
      signal: AbortSignal.timeout(60000),
    })

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return { result: '', error: `API 返回 ${res.status}: ${text.slice(0, 120)}` }
    }

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

          // 每次推送前过滤掉 <think> 块（含不完整的）
          const display = stripThinkBlocks(accumulated)
          onChunk(display)
        } catch { /* 跳过非 JSON 行 */ }
      }
    }

    // 最终结果也做清理
    return { result: stripThinkBlocks(accumulated) }

  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { result: '', error: msg }
  }
}

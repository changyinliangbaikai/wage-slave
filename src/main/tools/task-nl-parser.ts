/**
 * 自然语言 → ScheduledTask 解析器
 * 将"每天早上 8 点提醒我喝水"这类口语化输入转成结构化定时任务草稿
 * - 调用 LLM /chat/completions
 * - 让模型按指定 JSON Schema 返回
 * - 服务端做基本字段清洗 + 默认值兜底
 * 解析失败 / Key 未配置 / 模型乱回时，回退到一份带说明的占位草稿，让前端继续编辑
 */

import type { ScheduledTask } from '@shared/types'
import { getConfig } from '../store'
import { getStoredApiKey } from '../api-key'

const SYSTEM_PROMPT = `你是一名定时任务建模助手。
用户会用一句中文描述他想要的"定时任务"。
请把它解析成 JSON，**只输出 JSON 本身，不要任何额外文字、解释、Markdown 代码块标记**。

输出 JSON 字段：
- name: string，任务名称，<= 20 字
- kind: "shell" | "agent"。**如果是"提醒/写日报/帮我整理/分析/打招呼/发送邮件"等需要思考或调用工具的，用 "agent"；如果是"执行命令、跑脚本、运行 npm/git/python xxx"等纯命令行的，用 "shell"**
- command: string，仅当 kind="shell" 时填写要执行的 shell 命令，agent 任务留空字符串
- userInput: string，仅当 kind="agent" 时填写给 Agent 的具体任务描述（一句完整自然语言）
- schedule: 对象，子字段如下：
  - type: "daily" | "weekly" | "interval"
  - time: "HH:mm"（daily/weekly 必填）
  - weekDay: 0-6（仅 weekly 必填，0=周日 1=周一 ... 6=周六）
  - intervalMinutes: number（仅 interval 必填，分钟）

约束：
1. 如果用户没有给出具体时间，默认 daily 09:00
2. "每天/每日"→daily；"每周一/每周三"→weekly + 对应 weekDay；"每隔/每 N 分钟/每 N 小时"→interval
3. agent 任务的 userInput 要把用户的意图完整复述（包含动作 + 对象 + 期望产出）
4. shell 任务的 command 要可直接在 bash/cmd 中执行
5. 严格输出 JSON，不要 markdown 包裹，不要解释。`

/** 从原始文本中提取 JSON 对象（兼容裸 JSON、```json 代码块、含前后噪声等情况） */
function extractJSONObject(text: string): string | null {
  let cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()

  // 代码块优先
  const codeBlock = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (codeBlock) cleaned = codeBlock[1].trim()

  // 找最大的合法 {...}
  const candidates: string[] = []
  let depth = 0
  let start = -1
  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i]
    if (ch === '{') {
      if (depth === 0) start = i
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0 && start >= 0) {
        candidates.push(cleaned.slice(start, i + 1))
        start = -1
      }
    }
  }
  for (const c of candidates.sort((a, b) => b.length - a.length)) {
    try {
      JSON.parse(c)
      return c
    } catch { /* skip */ }
  }
  return null
}

interface ParsedDraft {
  name: string
  kind: 'shell' | 'agent'
  command: string
  userInput: string
  schedule: {
    type: 'daily' | 'weekly' | 'interval'
    time?: string
    weekDay?: number
    intervalMinutes?: number
  }
}

/** 规范化 + 默认值兜底，确保返回的对象前端可直接载入表单 */
function normalize(raw: unknown, originalText: string): ParsedDraft {
  const r = (raw ?? {}) as Record<string, unknown>
  const rawKind = String(r.kind ?? '').toLowerCase()
  const kind: 'shell' | 'agent' = rawKind === 'shell' ? 'shell' : 'agent'

  const sched = (r.schedule ?? {}) as Record<string, unknown>
  const rawType = String(sched.type ?? '').toLowerCase()
  const type: 'daily' | 'weekly' | 'interval' =
    rawType === 'weekly' ? 'weekly' : rawType === 'interval' ? 'interval' : 'daily'

  // time 校验：HH:mm
  let time = typeof sched.time === 'string' ? sched.time.trim() : ''
  if (!/^\d{1,2}:\d{2}$/.test(time)) time = '09:00'
  const [h, m] = time.split(':').map(Number)
  if (h > 23 || m > 59) time = '09:00'

  // weekDay
  let weekDay = Number(sched.weekDay)
  if (!Number.isFinite(weekDay) || weekDay < 0 || weekDay > 6) weekDay = 1

  // intervalMinutes
  let intervalMinutes = Number(sched.intervalMinutes)
  if (!Number.isFinite(intervalMinutes) || intervalMinutes <= 0) intervalMinutes = 60

  // name：去除多余空白，截断到 20
  let name = typeof r.name === 'string' ? r.name.trim() : ''
  if (!name) name = originalText.slice(0, 20) || '未命名任务'
  if (name.length > 20) name = name.slice(0, 20)

  const command = typeof r.command === 'string' ? r.command : ''
  const userInput = typeof r.userInput === 'string' && r.userInput.trim() ? r.userInput.trim() : originalText

  return {
    name,
    kind,
    command,
    userInput,
    schedule: { type, time, weekDay, intervalMinutes },
  }
}

/** 兜底：本地启发式，不调 LLM 时给一份"够用但不精准"的草稿 */
function localFallback(text: string): ParsedDraft {
  const t = text.trim()
  // 时间匹配："8 点"、"08:00"、"8:30"
  const colonMatch = t.match(/(\d{1,2})\s*[:：]\s*(\d{2})/)
  const hourMatch = !colonMatch ? t.match(/(\d{1,2})\s*点/) : null
  let time = '09:00'
  if (colonMatch) {
    const h = Math.min(23, Number(colonMatch[1]))
    const m = Math.min(59, Number(colonMatch[2]))
    time = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
  } else if (hourMatch) {
    const h = Math.min(23, Number(hourMatch[1]))
    time = `${String(h).padStart(2, '0')}:00`
  }

  let type: 'daily' | 'weekly' | 'interval' = 'daily'
  let weekDay = 1
  let intervalMinutes = 60
  if (/每\s*\d+\s*(分钟|小时)/.test(t)) {
    type = 'interval'
    const im = t.match(/每\s*(\d+)\s*(分钟|小时)/)
    if (im) intervalMinutes = Number(im[1]) * (im[2] === '小时' ? 60 : 1)
  } else if (/每周|周一|周二|周三|周四|周五|周六|周日/.test(t)) {
    type = 'weekly'
    const map: Record<string, number> = { '周日': 0, '周一': 1, '周二': 2, '周三': 3, '周四': 4, '周五': 5, '周六': 6 }
    for (const k of Object.keys(map)) if (t.includes(k)) { weekDay = map[k]; break }
  }

  return {
    name: t.slice(0, 20) || '未命名任务',
    kind: 'agent',
    command: '',
    userInput: t,
    schedule: { type, time, weekDay, intervalMinutes },
  }
}

/** 主入口：把自然语言解析为 ScheduledTask 草稿（不写库，由前端确认后保存） */
export async function parseNaturalLanguageToTask(
  text: string,
): Promise<Partial<ScheduledTask> & { name: string; userInput?: string }> {
  const apiKey = await getStoredApiKey()
  if (!apiKey) {
    console.warn('[NL-Parser] 未配置 API Key，使用本地启发式兜底')
    const draft = localFallback(text)
    return toScheduledTaskDraft(draft)
  }

  const config = getConfig()
  const baseUrl = config.llm_api_url.replace(/\/$/, '')

  try {
    console.log('[NL-Parser] 调用 LLM 解析:', text.slice(0, 80))
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: config.llm_model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: text },
        ],
        temperature: 0.1,
        max_tokens: 500,
      }),
      signal: AbortSignal.timeout(30000),
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`LLM 返回 ${res.status}: ${body.slice(0, 120)}`)
    }

    const data = await res.json()
    const raw: string = data.choices?.[0]?.message?.content ?? ''
    console.log('[NL-Parser] LLM 原始返回:', raw.slice(0, 200))

    const jsonStr = extractJSONObject(raw)
    if (!jsonStr) {
      console.warn('[NL-Parser] LLM 未返回有效 JSON，使用本地兜底')
      return toScheduledTaskDraft(localFallback(text))
    }

    const parsed = normalize(JSON.parse(jsonStr), text)
    console.log('[NL-Parser] 解析结果:', parsed.kind, parsed.schedule.type, parsed.schedule.time)
    return toScheduledTaskDraft(parsed)
  } catch (err) {
    console.error('[NL-Parser] LLM 调用失败，使用本地兜底:', err)
    return toScheduledTaskDraft(localFallback(text))
  }
}

/** ParsedDraft → 前端表单可消费的 ScheduledTask 草稿（不带 id/timestamps） */
function toScheduledTaskDraft(
  d: ParsedDraft,
): Partial<ScheduledTask> & { name: string; userInput?: string } {
  const schedule: ScheduledTask['schedule'] =
    d.schedule.type === 'interval'
      ? { type: 'interval', intervalMinutes: d.schedule.intervalMinutes ?? 60 }
      : d.schedule.type === 'weekly'
      ? { type: 'weekly', time: d.schedule.time ?? '09:00', weekDay: d.schedule.weekDay ?? 1 }
      : { type: 'daily', time: d.schedule.time ?? '09:00' }

  return {
    name: d.name,
    kind: d.kind,
    command: d.command,
    workDir: '',
    enabled: true,
    schedule,
    ...(d.kind === 'agent' && {
      agentTask: { userInput: d.userInput },
      userInput: d.userInput,
    }),
  }
}

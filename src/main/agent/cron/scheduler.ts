/**
 * Agent Cron 独立调度器
 *
 * - 持久化到 {userData}/agent-cron/tasks.json
 * - 每 30 秒检查一次，休眠唤醒后补一次检查
 * - 每个 Cron 防重入，触发后启动独立 AgentOrchestrator
 */

import { app, BrowserWindow, Notification, powerMonitor } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { IPC } from '@shared/ipc-channels'
import type { AgentCronNotifyConfig, AgentCronTask, AgentCronTaskSpec, TaskExecution, TaskSchedule } from '@shared/types'
import { AgentOrchestrator } from '../orchestrator'
import { agentActivityEnded, agentActivityStarted } from '../active-tracker'
import { getStoredApiKey } from '../../api-key'

const AGENT_CRON_DIR = path.join(app.getPath('userData'), 'agent-cron')
const AGENT_CRON_FILE = path.join(AGENT_CRON_DIR, 'tasks.json')
const DEFAULT_NOTIFY: AgentCronNotifyConfig = { onStart: false, onComplete: true, onError: true }
const DEFAULT_SCHEDULE: TaskSchedule = { type: 'daily', time: '09:00' }
const WEEK_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

const runningCrons = new Map<string, AgentOrchestrator>()
const runningExecutions = new Map<string, string>()
const loggedSkippedCronIds = new Set<string>()

let schedulerInterval: NodeJS.Timeout | null = null
let schedulerStartTime: Date | null = null
let powerResumeRegistered = false

function ensureDir(): void {
  if (!fs.existsSync(AGENT_CRON_DIR)) fs.mkdirSync(AGENT_CRON_DIR, { recursive: true })
}

function atomicWrite(filePath: string, data: unknown): void {
  ensureDir()
  const tmp = filePath + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8')
  fs.renameSync(tmp, filePath)
}

function readJSON<T>(filePath: string, fallback: T): T {
  try {
    ensureDir()
    if (!fs.existsSync(filePath)) return fallback
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T
  } catch {
    return fallback
  }
}

function readCrons(): AgentCronTask[] {
  return readJSON<AgentCronTask[]>(AGENT_CRON_FILE, []).map(normalizeStoredCron)
}

function writeCrons(crons: AgentCronTask[]): void {
  atomicWrite(AGENT_CRON_FILE, crons)
  broadcastCronListChanged()
}

export function listAgentCrons(): AgentCronTask[] {
  return readCrons().sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

export function getAgentCron(id: string): AgentCronTask | null {
  return readCrons().find(c => c.id === id) ?? null
}

export function saveAgentCron(cron: Partial<AgentCronTask> & { name: string }): AgentCronTask {
  const crons = readCrons()
  const idx = cron.id ? crons.findIndex(c => c.id === cron.id) : -1
  const existing = idx >= 0 ? crons[idx] : undefined
  const saved = buildCronForSave(cron, existing)

  if (idx >= 0) crons[idx] = saved
  else crons.push(saved)

  writeCrons(crons)
  return saved
}

export function deleteAgentCron(id: string): boolean {
  const crons = readCrons()
  const target = crons.find(c => c.id === id)
  if (!target) return false

  runningCrons.get(id)?.abort()
  runningCrons.delete(id)
  runningExecutions.delete(id)
  writeCrons(crons.filter(c => c.id !== id))
  return true
}

export function toggleAgentCron(id: string): AgentCronTask | null {
  const crons = readCrons()
  const idx = crons.findIndex(c => c.id === id)
  if (idx < 0) return null

  crons[idx] = {
    ...crons[idx],
    enabled: !crons[idx].enabled,
    updatedAt: new Date().toISOString(),
  }
  writeCrons(crons)
  return crons[idx]
}

export function runAgentCronNow(id: string): TaskExecution {
  const cron = getAgentCron(id)
  if (!cron) throw new Error('Agent Cron 不存在')
  return runAgentCron(cron)
}

export function startAgentCronScheduler(): void {
  if (schedulerInterval) return

  schedulerStartTime = new Date()
  loggedSkippedCronIds.clear()
  resetStaleRunningCrons()
  console.log(`[AgentCron] 调度器已启动，启动时间: ${schedulerStartTime.toLocaleTimeString()}`)

  schedulerInterval = setInterval(checkAgentCrons, 30 * 1000)
  if (!powerResumeRegistered) {
    powerMonitor.on('resume', handlePowerResume)
    powerResumeRegistered = true
  }
  setTimeout(checkAgentCrons, 5000)
}

export function stopAgentCronScheduler(): void {
  if (schedulerInterval) {
    clearInterval(schedulerInterval)
    schedulerInterval = null
  }
  if (powerResumeRegistered) {
    powerMonitor.off('resume', handlePowerResume)
    powerResumeRegistered = false
  }
  for (const orchestrator of runningCrons.values()) orchestrator.abort()
  runningCrons.clear()
  runningExecutions.clear()
  console.log('[AgentCron] 调度器已停止')
}

function runAgentCron(cron: AgentCronTask): TaskExecution {
  if (runningCrons.has(cron.id)) {
    throw new Error(`Agent Cron 正在运行: ${cron.name}`)
  }

  const executionId = `agent_cron_exec_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
  const now = new Date().toISOString()
  const execution: TaskExecution = {
    id: executionId,
    taskId: cron.id,
    taskName: cron.name,
    startTime: now,
    exitCode: null,
    output: '',
    status: 'running',
  }

  runningExecutions.set(cron.id, executionId)
  updateCronRunStatus(cron.id, 'running')
  notifyCron(cron, 'start', 'running', '已启动执行')

  runAgentCronExecution(cron, executionId).catch(err => {
    const message = err instanceof Error ? err.message : String(err)
    failCronExecution(cron, executionId, message)
  })

  return execution
}

async function runAgentCronExecution(cron: AgentCronTask, executionId: string): Promise<void> {
  const userInput = buildUserInput(cron.agentTask)
  if (!userInput.trim()) {
    failCronExecution(cron, executionId, 'Agent Cron 缺少 goal')
    return
  }

  const apiKey = await getStoredApiKey()
  if (!apiKey) {
    failCronExecution(cron, executionId, '未配置 LLM API Key，请先在设置中保存')
    return
  }

  const sessionId = `agent-cron-${executionId}`
  const orchestrator = new AgentOrchestrator(sessionId)
  runningCrons.set(cron.id, orchestrator)
  agentActivityStarted('cron')

  let finalContent = ''
  const toolSummaries: string[] = []
  let errorText: string | null = null
  let stats = { iterations: 0, toolCalls: 0, totalDurationMs: 0 }

  try {
    await orchestrator.run({
      userInput,
      apiKey,
      history: [],
      maxIterations: cron.agentTask.maxSteps,
      timeoutMs: cron.agentTask.timeoutMinutes * 60 * 1000,
      callbacks: {
        onChunk: () => {},
        onDone: p => {
          finalContent = p.content
          stats = p.stats
          if (p.aborted) {
            errorText = p.abortReason === 'timeout'
              ? `任务超时（${cron.agentTask.timeoutMinutes} 分钟）`
              : '用户中断'
          }
        },
        onError: p => {
          if (p.fatal) errorText = p.error
        },
        onToolStart: () => {},
        onToolExecuting: () => {},
        onToolExecuted: p => {
          const icon = p.success ? '✅' : '❌'
          const raw = p.success ? p.output : (p.error ?? p.output ?? '')
          const snippet = raw.replace(/\s+/g, ' ').slice(0, 200)
          toolSummaries.push(`${icon} ${p.toolName} (${p.durationMs}ms): ${snippet}`)
        },
      },
    })
  } catch (e) {
    errorText = e instanceof Error ? e.message : String(e)
  } finally {
    runningCrons.delete(cron.id)
    runningExecutions.delete(cron.id)
    agentActivityEnded('cron')
  }

  const status: 'success' | 'failed' = errorText ? 'failed' : 'success'
  updateCronRunStatus(cron.id, status)

  const output = buildExecutionOutput(cron, userInput, finalContent, toolSummaries, stats, errorText)
  console.log(`[AgentCron] 执行完成: ${cron.name} status=${status}`)
  notifyCron(cron, 'finish', status, status === 'success' ? (finalContent || '已完成') : (errorText ?? '执行失败'))

  if (output.length > 0) {
    console.log(`[AgentCron] 执行摘要 ${cron.name} (${executionId}):\n${output.slice(0, 2000)}`)
  }
}

function failCronExecution(cron: AgentCronTask, executionId: string, error: string): void {
  runningCrons.delete(cron.id)
  runningExecutions.delete(cron.id)
  updateCronRunStatus(cron.id, 'failed')
  console.error(`[AgentCron] 执行失败: ${cron.name} (${executionId})`, error)
  notifyCron(cron, 'finish', 'failed', error)
}

function checkAgentCrons(): void {
  const now = new Date()
  const crons = listAgentCrons().filter(c => c.enabled)

  for (const cron of crons) {
    if (runningCrons.has(cron.id) || cron.lastRunStatus === 'running') continue
    const { schedule } = cron

    if (schedule.type === 'interval') {
      const intervalMs = (schedule.intervalMinutes ?? 60) * 60 * 1000
      const lastRun = cron.lastRunAt ? new Date(cron.lastRunAt).getTime() : 0
      const baseline = lastRun > 0 ? lastRun : (schedulerStartTime?.getTime() ?? now.getTime())
      if (now.getTime() - baseline >= intervalMs) {
        console.log(`[AgentCron] 间隔调度触发: ${cron.name}`)
        runAgentCron(cron)
      }
      continue
    }

    if (schedule.type === 'daily') {
      if (wasRunTodayAfterSchedule(cron)) continue
      const [h, m] = (schedule.time ?? '09:00').split(':').map(Number)
      if (now.getHours() > h || (now.getHours() === h && now.getMinutes() >= m)) {
        if (wasScheduleBeforeStartup(schedule)) {
          logSkippedOnce(cron, `跳过已错过的每日任务: ${cron.name} (计划 ${schedule.time}，启动时已过时)`)
          continue
        }
        console.log(`[AgentCron] 每日调度触发: ${cron.name} (计划 ${schedule.time})`)
        runAgentCron(cron)
      }
      continue
    }

    if (schedule.type === 'weekly') {
      if (now.getDay() !== (schedule.weekDay ?? 1)) continue
      if (wasRunTodayAfterSchedule(cron)) continue
      const [h, m] = (schedule.time ?? '09:00').split(':').map(Number)
      if (now.getHours() > h || (now.getHours() === h && now.getMinutes() >= m)) {
        if (wasScheduleBeforeStartup(schedule)) {
          logSkippedOnce(cron, `跳过已错过的每周任务: ${cron.name} (计划 ${WEEK_NAMES[schedule.weekDay ?? 1]} ${schedule.time}，启动时已过时)`)
          continue
        }
        console.log(`[AgentCron] 每周调度触发: ${cron.name} (计划 ${WEEK_NAMES[schedule.weekDay ?? 1]} ${schedule.time})`)
        runAgentCron(cron)
      }
    }
  }
}

function updateCronRunStatus(id: string, status: 'running' | 'success' | 'failed'): void {
  const crons = readCrons()
  const idx = crons.findIndex(c => c.id === id)
  if (idx < 0) return

  crons[idx] = {
    ...crons[idx],
    lastRunAt: new Date().toISOString(),
    lastRunStatus: status,
    updatedAt: new Date().toISOString(),
  }
  writeCrons(crons)
}

function resetStaleRunningCrons(): void {
  const crons = readCrons()
  let changed = false
  for (const cron of crons) {
    if (cron.lastRunStatus === 'running') {
      cron.lastRunStatus = 'failed'
      cron.updatedAt = new Date().toISOString()
      changed = true
    }
  }
  if (changed) writeCrons(crons)
}

function buildCronForSave(input: Partial<AgentCronTask> & { name: string }, existing?: AgentCronTask): AgentCronTask {
  const now = new Date().toISOString()
  const name = input.name.trim()
  if (!name) throw new Error('Agent Cron 缺少名称')

  const agentTask = normalizeAgentTask(input.agentTask, existing?.agentTask)
  if (!agentTask.goal.trim()) throw new Error('Agent Cron 缺少 goal')

  return {
    id: existing?.id ?? input.id ?? `agent_cron_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name,
    description: input.description ?? existing?.description ?? '',
    schedule: normalizeSchedule(input.schedule ?? existing?.schedule ?? DEFAULT_SCHEDULE),
    agentTask,
    notify: normalizeNotify(input.notify ?? existing?.notify),
    enabled: input.enabled ?? existing?.enabled ?? true,
    createdAt: existing?.createdAt ?? input.createdAt ?? now,
    updatedAt: now,
    lastRunAt: input.lastRunAt ?? existing?.lastRunAt,
    lastRunStatus: input.lastRunStatus ?? existing?.lastRunStatus,
  }
}

function normalizeStoredCron(cron: AgentCronTask): AgentCronTask {
  return {
    ...cron,
    schedule: normalizeSchedule(cron.schedule),
    agentTask: normalizeAgentTask(cron.agentTask),
    notify: normalizeNotify(cron.notify),
    enabled: cron.enabled ?? true,
    createdAt: cron.createdAt ?? new Date().toISOString(),
    updatedAt: cron.updatedAt ?? cron.createdAt ?? new Date().toISOString(),
  }
}

function normalizeAgentTask(input?: Partial<AgentCronTaskSpec>, existing?: AgentCronTaskSpec): AgentCronTaskSpec {
  return {
    goal: input?.goal ?? existing?.goal ?? '',
    context: input?.context ?? existing?.context,
    allowedTools: input?.allowedTools ?? existing?.allowedTools,
    maxSteps: clampInt(input?.maxSteps ?? existing?.maxSteps ?? 20, 1, 50),
    timeoutMinutes: clampInt(input?.timeoutMinutes ?? existing?.timeoutMinutes ?? 10, 1, 1440),
  }
}

function normalizeSchedule(schedule: TaskSchedule): TaskSchedule {
  if (schedule.type === 'interval') {
    return { type: 'interval', intervalMinutes: clampInt(schedule.intervalMinutes ?? 60, 1, 1440) }
  }
  if (schedule.type === 'weekly') {
    return {
      type: 'weekly',
      weekDay: clampInt(schedule.weekDay ?? 1, 0, 6),
      time: normalizeTime(schedule.time ?? '09:00'),
    }
  }
  return { type: 'daily', time: normalizeTime(schedule.time ?? '09:00') }
}

function normalizeNotify(notify?: Partial<AgentCronNotifyConfig>): AgentCronNotifyConfig {
  return {
    onStart: notify?.onStart ?? DEFAULT_NOTIFY.onStart,
    onComplete: notify?.onComplete ?? DEFAULT_NOTIFY.onComplete,
    onError: notify?.onError ?? DEFAULT_NOTIFY.onError,
  }
}

function buildUserInput(spec: AgentCronTaskSpec): string {
  const goal = spec.goal.trim()
  const context = spec.context?.trim()
  return context ? `${goal}\n\n上下文：\n${context}` : goal
}

function buildExecutionOutput(
  cron: AgentCronTask,
  userInput: string,
  finalContent: string,
  toolSummaries: string[],
  stats: { iterations: number; toolCalls: number; totalDurationMs: number },
  errorText: string | null,
): string {
  const lines: string[] = []
  lines.push(`# Agent Cron：${cron.name}`)
  lines.push('')
  lines.push(`**输入**：${userInput}`)
  lines.push('')
  if (errorText) {
    lines.push(`**错误**：${errorText}`)
    lines.push('')
  }
  if (finalContent) {
    lines.push('**最终回复**：')
    lines.push(finalContent)
    lines.push('')
  }
  if (toolSummaries.length > 0) {
    lines.push(`**工具调用（${toolSummaries.length} 次）**：`)
    for (const s of toolSummaries) lines.push(`- ${s}`)
    lines.push('')
  }
  lines.push(`**统计**：${stats.iterations} 轮迭代，${stats.toolCalls} 次工具调用，耗时 ${(stats.totalDurationMs / 1000).toFixed(1)}s`)
  return lines.join('\n')
}

function notifyCron(
  cron: AgentCronTask,
  phase: 'start' | 'finish',
  status: 'running' | 'success' | 'failed',
  body: string,
): void {
  const shouldNotify = phase === 'start'
    ? cron.notify.onStart
    : status === 'success'
      ? cron.notify.onComplete
      : cron.notify.onError
  if (!shouldNotify) return

  const title = phase === 'start'
    ? `Agent 定时启动：${cron.name}`
    : status === 'success'
      ? `Agent 定时完成：${cron.name}`
      : `Agent 定时失败：${cron.name}`

  try {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(IPC.AGENT_NOTIFICATION, {
          title,
          body: body.slice(0, 200),
          type: 'cron-result',
        })
      }
    }
  } catch (err) {
    console.warn('[AgentCron] 广播通知失败:', err)
  }

  try {
    new Notification({ title, body: body.slice(0, 120) }).show()
  } catch {
    // 通知可能在某些环境不可用
  }
}

function broadcastCronListChanged(): void {
  try {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(IPC.SCHEDULER_TASKS_CHANGED, { action: 'update', taskId: 'agent-cron' })
      }
    }
  } catch {
    // UI 在线刷新失败不影响调度
  }
}

function wasRunTodayAfterSchedule(cron: AgentCronTask): boolean {
  if (!cron.lastRunAt) return false
  const lastRun = new Date(cron.lastRunAt)
  const now = new Date()
  if (
    lastRun.getFullYear() !== now.getFullYear() ||
    lastRun.getMonth() !== now.getMonth() ||
    lastRun.getDate() !== now.getDate()
  ) {
    return false
  }

  const [h, m] = (cron.schedule.time ?? '09:00').split(':').map(Number)
  const scheduledMinutes = h * 60 + m
  const lastRunMinutes = lastRun.getHours() * 60 + lastRun.getMinutes()
  return lastRunMinutes >= scheduledMinutes
}

function wasScheduleBeforeStartup(schedule: { time?: string }): boolean {
  if (!schedulerStartTime) return false
  const now = new Date()
  const isStartupDay =
    schedulerStartTime.getFullYear() === now.getFullYear() &&
    schedulerStartTime.getMonth() === now.getMonth() &&
    schedulerStartTime.getDate() === now.getDate()
  if (!isStartupDay) return false

  const [h, m] = (schedule.time ?? '09:00').split(':').map(Number)
  const scheduledMinutes = h * 60 + m
  const startMinutes = schedulerStartTime.getHours() * 60 + schedulerStartTime.getMinutes()
  return scheduledMinutes < startMinutes
}

function logSkippedOnce(cron: AgentCronTask, message: string): void {
  if (loggedSkippedCronIds.has(cron.id)) return
  loggedSkippedCronIds.add(cron.id)
  console.log(`[AgentCron] ${message}`)
}

function handlePowerResume(): void {
  setTimeout(checkAgentCrons, 2000)
}

function normalizeTime(value: string): string {
  const match = value.match(/^(\d{1,2}):(\d{1,2})$/)
  if (!match) return '09:00'
  const h = clampInt(Number(match[1]), 0, 23)
  const m = clampInt(Number(match[2]), 0, 59)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.max(min, Math.min(max, Math.floor(value)))
}

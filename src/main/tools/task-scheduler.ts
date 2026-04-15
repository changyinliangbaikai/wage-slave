/**
 * 定时任务调度器
 * - 任务 CRUD（持久化到 JSON 文件）
 * - 基于 setInterval 的调度引擎（每 30 秒检查一次）
 * - 通过 child_process.spawn 执行用户自定义命令
 * - 执行日志存储与管理
 */

import { app, Notification } from 'electron'
import { spawn, type ChildProcess } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import * as iconv from 'iconv-lite'
import type { ScheduledTask, TaskExecution } from '@shared/types'

// ── 存储路径 ─────────────────────────────────
const BASE_DIR = path.join(app.getPath('userData'))
const SCHEDULER_DIR = path.join(BASE_DIR, 'scheduler')
const TASKS_FILE = path.join(SCHEDULER_DIR, 'tasks.json')
const LOGS_DIR = path.join(SCHEDULER_DIR, 'logs')

// 确保目录存在
;[SCHEDULER_DIR, LOGS_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
})

// ── 原子写入 ─────────────────────────────────
function atomicWrite(filePath: string, data: unknown): void {
  const tmp = filePath + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8')
  fs.renameSync(tmp, filePath)
}

function readJSON<T>(filePath: string, fallback: T): T {
  try {
    if (!fs.existsSync(filePath)) return fallback
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T
  } catch {
    return fallback
  }
}

// ── 运行中的进程跟踪 ─────────────────────────
const runningProcesses = new Map<string, ChildProcess>()

// ── 调度引擎状态 ─────────────────────────────
let schedulerInterval: NodeJS.Timeout | null = null
const WEEK_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
// 记录调度引擎启动时间，用于跳过启动前已错过的任务
let schedulerStartTime: Date | null = null

// ── 任务 CRUD ────────────────────────────────

/** 获取所有任务 */
export function listTasks(): ScheduledTask[] {
  return readJSON<ScheduledTask[]>(TASKS_FILE, [])
}

/** 保存任务（新建或更新） */
export function saveTask(task: Partial<ScheduledTask> & { name: string; command: string }): ScheduledTask {
  const tasks = listTasks()
  const now = new Date().toISOString()

  if (task.id) {
    // 更新已有任务
    const idx = tasks.findIndex(t => t.id === task.id)
    if (idx >= 0) {
      const updated: ScheduledTask = { ...tasks[idx], ...task, updatedAt: now }
      tasks[idx] = updated
      atomicWrite(TASKS_FILE, tasks)
      console.log(`[TaskScheduler] 更新任务: ${updated.name} (${updated.id})`)
      return updated
    }
  }

  // 新建任务
  const newTask: ScheduledTask = {
    id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name: task.name,
    command: task.command,
    workDir: task.workDir || '',
    schedule: task.schedule || { type: 'daily', time: '09:00' },
    enabled: task.enabled ?? true,
    createdAt: now,
    updatedAt: now,
  }

  tasks.push(newTask)
  atomicWrite(TASKS_FILE, tasks)
  console.log(`[TaskScheduler] 新建任务: ${newTask.name} (${newTask.id})`)
  return newTask
}

/** 删除任务 */
export function deleteTask(taskId: string): boolean {
  const tasks = listTasks()
  const filtered = tasks.filter(t => t.id !== taskId)
  if (filtered.length === tasks.length) return false

  atomicWrite(TASKS_FILE, filtered)

  // 同时清理该任务的日志文件
  const logFile = path.join(LOGS_DIR, `${taskId}.json`)
  if (fs.existsSync(logFile)) fs.unlinkSync(logFile)

  console.log(`[TaskScheduler] 删除任务: ${taskId}`)
  return true
}

/** 切换任务启用状态 */
export function toggleTask(taskId: string): ScheduledTask | null {
  const tasks = listTasks()
  const task = tasks.find(t => t.id === taskId)
  if (!task) return null

  task.enabled = !task.enabled
  task.updatedAt = new Date().toISOString()
  atomicWrite(TASKS_FILE, tasks)
  console.log(`[TaskScheduler] 任务 ${task.name} ${task.enabled ? '启用' : '禁用'}`)
  return task
}

// ── 执行日志管理 ─────────────────────────────

/** 获取任务执行日志（最近 N 条） */
export function getTaskLogs(taskId: string, limit = 50): TaskExecution[] {
  const logFile = path.join(LOGS_DIR, `${taskId}.json`)
  const logs = readJSON<TaskExecution[]>(logFile, [])
  // 按时间倒序，取最近 limit 条
  return logs.sort((a, b) => b.startTime.localeCompare(a.startTime)).slice(0, limit)
}

/** 追加执行日志 */
function appendLog(taskId: string, log: TaskExecution): void {
  const logFile = path.join(LOGS_DIR, `${taskId}.json`)
  const logs = readJSON<TaskExecution[]>(logFile, [])
  logs.push(log)
  // 保留最近 200 条
  const trimmed = logs.slice(-200)
  atomicWrite(logFile, trimmed)
}

/** 更新执行日志（任务完成时更新状态） */
function updateLog(taskId: string, executionId: string, updates: Partial<TaskExecution>): void {
  const logFile = path.join(LOGS_DIR, `${taskId}.json`)
  const logs = readJSON<TaskExecution[]>(logFile, [])
  const idx = logs.findIndex(l => l.id === executionId)
  if (idx >= 0) {
    logs[idx] = { ...logs[idx], ...updates }
    atomicWrite(logFile, logs)
  }
}

/** 清除任务日志 */
export function clearTaskLogs(taskId: string): void {
  const logFile = path.join(LOGS_DIR, `${taskId}.json`)
  if (fs.existsSync(logFile)) atomicWrite(logFile, [])
  console.log(`[TaskScheduler] 清除任务日志: ${taskId}`)
}

// ── 更新任务的最近执行状态 ────────────────────
function updateTaskRunStatus(taskId: string, status: 'running' | 'success' | 'failed'): void {
  const tasks = listTasks()
  const task = tasks.find(t => t.id === taskId)
  if (!task) return

  task.lastRunAt = new Date().toISOString()
  task.lastRunStatus = status
  atomicWrite(TASKS_FILE, tasks)
}

// ── 命令执行 ─────────────────────────────────

/**
 * 智能解码子进程输出
 * Windows cmd.exe 管道默认输出 GBK/CP936 编码，直接 toString('utf-8') 会乱码
 * 策略：先尝试 UTF-8，若包含替换字符（说明不是合法 UTF-8）则用 iconv-lite 按 GBK 解码
 */
function decodeProcessOutput(buf: Buffer): string {
  if (buf.length === 0) return ''

  // 非 Windows 直接用 UTF-8
  if (process.platform !== 'win32') return buf.toString('utf-8')

  // 尝试 UTF-8 解码
  const utf8Result = buf.toString('utf-8')
  // U+FFFD 是 Node.js 遇到非法 UTF-8 字节时的替换字符
  if (!utf8Result.includes('\ufffd')) {
    console.log('[TaskScheduler] 输出编码: UTF-8')
    return utf8Result
  }

  // 包含替换字符，说明不是合法 UTF-8，用 iconv-lite 按 GBK 解码
  console.log('[TaskScheduler] 检测到非 UTF-8 输出，使用 GBK 解码')
  return iconv.decode(buf, 'gbk')
}

/** 执行任务命令 */
export function runTask(taskId: string): TaskExecution {
  const tasks = listTasks()
  const task = tasks.find(t => t.id === taskId)
  if (!task) throw new Error(`任务不存在: ${taskId}`)

  const executionId = `exec_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
  const now = new Date().toISOString()

  // 创建执行记录
  const execution: TaskExecution = {
    id: executionId,
    taskId,
    taskName: task.name,
    startTime: now,
    exitCode: null,
    output: '',
    status: 'running',
  }

  appendLog(taskId, execution)
  updateTaskRunStatus(taskId, 'running')
  console.log(`[TaskScheduler] 开始执行任务: ${task.name} → ${task.command}`)

  // 确定 shell 和工作目录
  const isWin = process.platform === 'win32'
  const shell = isWin ? 'cmd.exe' : '/bin/sh'
  const shellArgs = isWin ? ['/c', task.command] : ['-c', task.command]
  const cwd = task.workDir && fs.existsSync(task.workDir) ? task.workDir : undefined

  // 收集原始 Buffer，结束后再统一解码，避免 Windows GBK 乱码
  const outputChunks: Buffer[] = []

  const child = spawn(shell, shellArgs, {
    cwd,
    env: {
      ...process.env,
      // Windows 下为常见程序设置 UTF-8 输出环境变量
      ...(isWin && {
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
      }),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  runningProcesses.set(executionId, child)

  // 收集原始字节，不立即转字符串
  child.stdout?.on('data', (data: Buffer) => {
    outputChunks.push(data)
  })

  child.stderr?.on('data', (data: Buffer) => {
    outputChunks.push(data)
  })

  child.on('close', (code) => {
    runningProcesses.delete(executionId)
    const status = code === 0 ? 'success' : 'failed'
    const endTime = new Date().toISOString()

    // 合并 Buffer 并自动检测编码解码
    const rawOutput = Buffer.concat(outputChunks)
    const output = decodeProcessOutput(rawOutput)

    // 限制日志大小（最多保留 5000KB）
    const trimmedOutput = output.length > 5000000
      ? output.slice(0, 2500000) + '\n\n... [日志过长，已截断] ...\n\n' + output.slice(-2500000)
      : output

    updateLog(taskId, executionId, {
      endTime,
      exitCode: code,
      output: trimmedOutput,
      status,
    })
    updateTaskRunStatus(taskId, status)

    console.log(`[TaskScheduler] 任务完成: ${task.name} exitCode=${code}`)

    // 发送系统通知
    try {
      new Notification({
        title: `定时任务${status === 'success' ? '成功' : '失败'}`,
        body: `${task.name}: ${status === 'success' ? '执行完成' : `退出码 ${code}`}`,
      }).show()
    } catch {
      // 通知可能在某些环境不可用
    }
  })

  child.on('error', (err) => {
    runningProcesses.delete(executionId)
    const endTime = new Date().toISOString()
    const rawOutput = Buffer.concat(outputChunks)
    const output = decodeProcessOutput(rawOutput)
    updateLog(taskId, executionId, {
      endTime,
      exitCode: -1,
      output: output + '\n[ERROR] ' + err.message,
      status: 'failed',
    })
    updateTaskRunStatus(taskId, 'failed')

    console.error(`[TaskScheduler] 任务执行出错: ${task.name}`, err.message)
  })

  return execution
}

// ── 调度引擎 ─────────────────────────────────

/**
 * 判断任务今天是否已在调度时间点之后执行过
 * 基于 lastRunAt 与调度时间比较，而非内存标记，
 * 这样编辑任务时间后能正确重新触发
 */
function wasRunTodayAfterSchedule(task: ScheduledTask): boolean {
  if (!task.lastRunAt) return false
  const lastRun = new Date(task.lastRunAt)
  const now = new Date()

  // 不是同一天，未执行过
  if (lastRun.getFullYear() !== now.getFullYear() ||
      lastRun.getMonth() !== now.getMonth() ||
      lastRun.getDate() !== now.getDate()) {
    return false
  }

  // 比较最后执行时间是否 >= 调度时间
  const [h, m] = (task.schedule.time ?? '09:00').split(':').map(Number)
  const scheduledMinutes = h * 60 + m
  const lastRunMinutes = lastRun.getHours() * 60 + lastRun.getMinutes()
  return lastRunMinutes >= scheduledMinutes
}

/**
 * 判断调度时间是否在程序启动之前就已经过了
 * 如果是，说明是“错过”的任务，不补跑，留给用户手动决定
 */
function wasScheduleBeforeStartup(schedule: { time?: string }): boolean {
  if (!schedulerStartTime) return false
  const [h, m] = (schedule.time ?? '09:00').split(':').map(Number)
  const scheduledMinutes = h * 60 + m
  const startMinutes = schedulerStartTime.getHours() * 60 + schedulerStartTime.getMinutes()
  return scheduledMinutes < startMinutes
}

/** 检查任务是否需要执行 */
function checkTasks(): void {
  const tasks = listTasks().filter(t => t.enabled)
  const now = new Date()

  for (const task of tasks) {
    const { schedule } = task

    // 防重入：正在运行的任务不再重复启动
    if (task.lastRunStatus === 'running') continue

    if (schedule.type === 'interval') {
      // 间隔执行：以启动时间或上次执行时间为基准，超过 N 分钟则执行
      const intervalMs = (schedule.intervalMinutes ?? 60) * 60 * 1000
      const lastRun = task.lastRunAt ? new Date(task.lastRunAt).getTime() : 0
      // 首次启动且从未执行过，以启动时间为基准开始计时
      const baseline = lastRun > 0 ? lastRun : (schedulerStartTime?.getTime() ?? now.getTime())
      if (now.getTime() - baseline >= intervalMs) {
        console.log(`[TaskScheduler] 间隔调度触发: ${task.name}`)
        runTask(task.id)
      }
    } else if (schedule.type === 'daily') {
      // 每日执行：到达指定时间且今天在该时间点后未执行过
      if (wasRunTodayAfterSchedule(task)) continue

      const [h, m] = (schedule.time ?? '09:00').split(':').map(Number)
      if (now.getHours() > h || (now.getHours() === h && now.getMinutes() >= m)) {
        // 启动时已错过的任务不补跑，留给用户手动执行
        if (wasScheduleBeforeStartup(schedule)) {
          console.log(`[TaskScheduler] 跳过已错过的每日任务: ${task.name} (计划 ${schedule.time}，启动时已过时)`)
          continue
        }
        console.log(`[TaskScheduler] 每日调度触发: ${task.name} (计划 ${schedule.time})`)
        runTask(task.id)
      }
    } else if (schedule.type === 'weekly') {
      // 每周执行：到达指定星期和时间且今天在该时间点后未执行过
      if (now.getDay() !== (schedule.weekDay ?? 1)) continue
      if (wasRunTodayAfterSchedule(task)) continue

      const [h, m] = (schedule.time ?? '09:00').split(':').map(Number)
      if (now.getHours() > h || (now.getHours() === h && now.getMinutes() >= m)) {
        // 启动时已错过的任务不补跑
        if (wasScheduleBeforeStartup(schedule)) {
          console.log(`[TaskScheduler] 跳过已错过的每周任务: ${task.name} (计划 ${WEEK_NAMES[schedule.weekDay ?? 1]} ${schedule.time}，启动时已过时)`)
          continue
        }
        console.log(`[TaskScheduler] 每周调度触发: ${task.name} (计划 ${WEEK_NAMES[schedule.weekDay ?? 1]} ${schedule.time})`)
        runTask(task.id)
      }
    }
  }
}

/** 启动调度引擎 */
export function startTaskScheduler(): void {
  schedulerStartTime = new Date()
  console.log(`[TaskScheduler] 调度引擎已启动，启动时间: ${schedulerStartTime.toLocaleTimeString()}`)
  // 每 30 秒检查一次
  schedulerInterval = setInterval(checkTasks, 30 * 1000)
  // 启动后延迟 5 秒开始首次检查
  setTimeout(checkTasks, 5000)
}

/** 停止调度引擎 */
export function stopTaskScheduler(): void {
  if (schedulerInterval) {
    clearInterval(schedulerInterval)
    schedulerInterval = null
  }
  // 终止所有运行中的进程
  for (const [id, child] of runningProcesses) {
    child.kill()
    runningProcesses.delete(id)
  }
  console.log('[TaskScheduler] 调度引擎已停止')
}

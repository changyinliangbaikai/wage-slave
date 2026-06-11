/**
 * 定时任务调度器
 * - 任务 CRUD（持久化到 JSON 文件，内存缓存避免频繁磁盘 I/O）
 * - 基于 setInterval 的调度引擎（每秒检查一次，支持秒级精度）
 * - 通过 child_process.spawn 执行用户自定义命令
 * - 执行日志存储与管理
 */

import { app, BrowserWindow, Notification, powerMonitor } from 'electron'
import { spawn, type ChildProcess } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import * as iconv from 'iconv-lite'
import type { ScheduledTask, TaskExecution } from '@shared/types'
import { IPC } from '@shared/ipc-channels'

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
/** executionId → taskId 反向索引（用于按 taskId 中止运行中的执行） */
const executionToTask = new Map<string, string>()

/** 安全地杀死子进程及其派生的所有子子进程 */
function killProcess(child: ChildProcess): void {
  const pid = child.pid
  if (!pid) {
    child.kill()
    return
  }
  if (process.platform === 'win32') {
    try {
      const killer = spawn('taskkill', ['/pid', pid.toString(), '/T', '/F'])
      killer.on('error', (err) => {
        console.warn(`[TaskScheduler] Windows taskkill 异步报错:`, err)
        child.kill()
      })
    } catch {
      child.kill()
    }
  } else {
    try {
      process.kill(-pid, 'SIGTERM')
    } catch {
      child.kill()
    }
  }
}

// ── 调度引擎状态 ─────────────────────────────
let schedulerInterval: NodeJS.Timeout | null = null
const WEEK_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
// 记录调度引擎启动时间，用于跳过启动前已错过的任务
let schedulerStartTime: Date | null = null
let powerResumeRegistered = false
// 启动期内"已错过并打印过跳过日志"的任务 ID，避免每 5s 重复刷屏
const loggedSkippedTaskIds = new Set<string>()

// ── 任务列表缓存 ─────────────────────────────
// 避免每秒都从磁盘读取 tasks.json，缓存到内存并在修改时同步
let cachedTasks: ScheduledTask[] | null = null
let isCacheDirty = false // 标记缓存是否需要从磁盘刷新

// ── 广播任务列表变化 ──────────────────────────
/**
 * 通知所有渲染窗口任务列表已变化（CRUD 任意一项），由 UI 决定是否 reload
 * 与 SCHEDULER_TASK_UPDATE 不同：后者只在执行态切换时发，前者覆盖 create/update/delete/toggle
 */
function broadcastTasksChanged(action: 'create' | 'update' | 'delete' | 'toggle', taskId?: string): void {
  try {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(IPC.SCHEDULER_TASKS_CHANGED, { action, taskId })
      }
    }
  } catch (err) {
    console.warn('[TaskScheduler] 广播任务列表变化失败:', err)
  }
}

// ── 任务 CRUD ────────────────────────────────

/** 获取所有任务（使用内存缓存，避免频繁磁盘 I/O） */
export function listTasks(): ScheduledTask[] {
  if (cachedTasks && !isCacheDirty) {
    // 返回浅拷贝数组，防止外部修改影响缓存（防御性编程）
    return [...cachedTasks]
  }

  const tasks = readJSON<ScheduledTask[]>(TASKS_FILE, [])
  cachedTasks = tasks
  isCacheDirty = false
  return [...tasks]
}

/** 强制刷新任务缓存（当外部修改了 tasks.json 时调用） */
export function refreshTaskCache(): void {
  isCacheDirty = true
  cachedTasks = null
}

/**
 * 保存任务（新建或更新）
 * 兼容 shell 与 agent 两种执行体：
 *  - shell：command 必填
 *  - agent：command 可空（不参与执行），agentTask.userInput 必填
 *  签名上将 command 放宽为可选；具体校验由调用方负责
 */
export function saveTask(task: Partial<ScheduledTask> & { name: string }): ScheduledTask {
  const tasks = listTasks() // 返回缓存引用
  const now = new Date().toISOString()

  if (task.id) {
    // 更新已有任务（spread 自然带过 kind / agentTask）
    const idx = tasks.findIndex(t => t.id === task.id)
    if (idx >= 0) {
      const updated: ScheduledTask = { ...tasks[idx], ...task, updatedAt: now }
      tasks[idx] = updated
      cachedTasks = tasks // 同步更新缓存
      atomicWrite(TASKS_FILE, tasks)
      console.log(`[TaskScheduler] 更新任务: ${updated.name} (${updated.id}, kind=${updated.kind ?? 'shell'})`)
      broadcastTasksChanged('update', updated.id)
      return updated
    }
  }

  // 新建任务
  const newTask: ScheduledTask = {
    id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name: task.name,
    command: task.command ?? '',
    workDir: task.workDir || '',
    schedule: task.schedule || { type: 'daily', time: '09:00' },
    enabled: task.enabled ?? true,
    createdAt: now,
    updatedAt: now,
    ...(task.kind && { kind: task.kind }),
    ...(task.agentTask && { agentTask: task.agentTask }),
    ...(task.agentCron && { agentCron: task.agentCron }),
  }

  tasks.push(newTask)
  cachedTasks = tasks // 同步更新缓存
  atomicWrite(TASKS_FILE, tasks)
  console.log(`[TaskScheduler] 新建任务: ${newTask.name} (${newTask.id}, kind=${newTask.kind ?? 'shell'})`)
  broadcastTasksChanged('create', newTask.id)
  return newTask
}

/** 删除任务 */
export function deleteTask(taskId: string): boolean {
  const tasks = listTasks() // 返回缓存引用
  const filtered = tasks.filter(t => t.id !== taskId)
  if (filtered.length === tasks.length) return false

  cachedTasks = filtered // 同步更新缓存
  atomicWrite(TASKS_FILE, filtered)

  // 同时清理该任务的日志文件
  const logFile = path.join(LOGS_DIR, `${taskId}.json`)
  if (fs.existsSync(logFile)) fs.unlinkSync(logFile)

  console.log(`[TaskScheduler] 删除任务: ${taskId}`)
  broadcastTasksChanged('delete', taskId)
  return true
}

/** 切换任务启用状态 */
export function toggleTask(taskId: string): ScheduledTask | null {
  const tasks = listTasks() // 返回缓存引用
  const task = tasks.find(t => t.id === taskId)
  if (!task) return null

  task.enabled = !task.enabled
  task.updatedAt = new Date().toISOString()
  cachedTasks = tasks // 同步更新缓存（虽然直接修改了对象，但显式同步更清晰）
  atomicWrite(TASKS_FILE, tasks)
  console.log(`[TaskScheduler] 任务 ${task.name} ${task.enabled ? '启用' : '禁用'}`)
  broadcastTasksChanged('toggle', task.id)
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

  // 广播任务状态变化，让前端 UI 实时刷新（不强求 UI 在线，失败安全忽略）
  try {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(IPC.SCHEDULER_TASK_UPDATE, { taskId, status })
      }
    }
  } catch (err) {
    console.warn('[TaskScheduler] 广播任务状态变化失败:', err)
  }
}

// ── 运行态查询 / 中止 ────────────────────────

/** 列出当前正在运行的执行（用于 UI 显示「运行中」状态、停止按钮） */
export function listRunningExecutions(): Array<{ executionId: string; kind: 'shell' | 'agent' }> {
  const result: Array<{ executionId: string; kind: 'shell' | 'agent' }> = []
  for (const id of runningProcesses.keys()) result.push({ executionId: id, kind: 'shell' })
  return result
}

/**
 * 中止单个正在运行的执行
 * - 入参可以是 executionId（精确）或 taskId（中止该任务下任一在跑的执行）
 * - shell：杀死整个子进程组，由 close 事件兜底写日志
 * @returns 是否找到并发起中止
 */
export function stopRunningTask(idOrTaskId: string): boolean {
  // 1. 优先按 executionId 精确匹配
  const child = runningProcesses.get(idOrTaskId)
  if (child) {
    try {
      killProcess(child)
      console.log(`[TaskScheduler] 已向整个进程组发送 kill 信号: ${idOrTaskId}`)
    } catch (err) {
      console.warn(`[TaskScheduler] 中止 shell 进程树失败 (${idOrTaskId}):`, err)
    }
    return true
  }
  // 2. 兜底：把入参当 taskId，遍历反向索引找正在跑的执行
  let hit = false
  for (const [execId, taskId] of executionToTask.entries()) {
    if (taskId !== idOrTaskId) continue
    const targetChild = runningProcesses.get(execId)
    if (targetChild) {
      try {
        killProcess(targetChild)
        hit = true
        console.log(`[TaskScheduler] 按 taskId 中止整个进程组: task=${taskId} exec=${execId}`)
      } catch { /* ignore */ }
    }
  }
  if (!hit) console.warn(`[TaskScheduler] 未找到运行中的执行: ${idOrTaskId}`)
  return hit
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

  // 记录反向索引，便于按 taskId 查找正在运行的执行
  executionToTask.set(executionId, taskId)
  console.log(`[TaskScheduler] 开始执行任务: ${task.name}`)

  runShellTask(task, executionId)

  return execution
}

/** 执行 shell 任务（spawn 子进程 + 智能解码 + 日志 + 通知） */
function runShellTask(task: ScheduledTask, executionId: string): void {
  const taskId = task.id

  // 确定 shell 和工作目录
  const isWin = process.platform === 'win32'
  const shell = isWin ? 'cmd.exe' : '/bin/sh'
  const shellArgs = isWin ? ['/c', task.command] : ['-c', task.command]
  const cwd = task.workDir && fs.existsSync(task.workDir) ? task.workDir : undefined

  // 收集原始 Buffer，结束后再统一解码，避免 Windows GBK 乱码
  const outputChunks: Buffer[] = []

  const child = spawn(shell, shellArgs, {
    cwd,
    detached: true,
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
    executionToTask.delete(executionId)
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
    executionToTask.delete(executionId)
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

  // 仅在“启动当天”才判定为“启动前已错过”：schedulerStartTime 在整个进程生命周期内固定不变，
  // 若缺少同日约束，一旦某次启动晚于计划时间，之后每天都会被误判为“已错过”而永久跳过。
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
        // 启动时已错过的任务不补跑，留给用户手动执行（同一启动周期内只提示一次）
        if (wasScheduleBeforeStartup(schedule)) {
          if (!loggedSkippedTaskIds.has(task.id)) {
            console.log(`[TaskScheduler] 跳过已错过的每日任务: ${task.name} (计划 ${schedule.time}，启动时已过时)`)
            loggedSkippedTaskIds.add(task.id)
          }
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
        // 启动时已错过的任务不补跑（同一启动周期内只提示一次）
        if (wasScheduleBeforeStartup(schedule)) {
          if (!loggedSkippedTaskIds.has(task.id)) {
            console.log(`[TaskScheduler] 跳过已错过的每周任务: ${task.name} (计划 ${WEEK_NAMES[schedule.weekDay ?? 1]} ${schedule.time}，启动时已过时)`)
            loggedSkippedTaskIds.add(task.id)
          }
          continue
        }
        console.log(`[TaskScheduler] 每周调度触发: ${task.name} (计划 ${WEEK_NAMES[schedule.weekDay ?? 1]} ${schedule.time})`)
        runTask(task.id)
      }
    } else if (schedule.type === 'once' || schedule.type === 'delay') {
      // 一次性任务：到达指定时间执行，执行后自动禁用
      if (!schedule.executeAt) continue

      const executeAt = new Date(schedule.executeAt)
      if (isNaN(executeAt.getTime())) {
        console.warn(`[TaskScheduler] 任务时间格式错误: ${task.name}, executeAt=${schedule.executeAt}`)
        continue
      }

      // 检查是否已执行过
      if (task.lastRunAt) {
        const lastRun = new Date(task.lastRunAt)
        // 如果已在此时间后执行过，禁用任务
        if (lastRun >= executeAt) {
          console.log(`[TaskScheduler] 一次性任务已执行过，自动禁用: ${task.name}`)
          toggleTask(task.id)
          continue
        }
      }

      // 检查是否到达执行时间
      if (now.getTime() >= executeAt.getTime()) {
        console.log(`[TaskScheduler] 一次性任务触发: ${task.name} (计划 ${executeAt.toLocaleString('zh-CN')})`)
        runTask(task.id)
        // 执行后任务会在下次检查时被禁用（通过上面的 lastRunAt 判断）
      }
    }
  }
}

function handlePowerResume(): void {
  setTimeout(checkTasks, 2000)
}

/** 启动调度引擎 */
export function startTaskScheduler(): void {
  if (schedulerInterval) return
  schedulerStartTime = new Date()
  // 清空上次启动期的"已跳过"标记，本次重新判断
  loggedSkippedTaskIds.clear()
  console.log(`[TaskScheduler] 调度引擎已启动，启动时间: ${schedulerStartTime.toLocaleTimeString()}`)
  // 每秒检查一次（支持秒级精度的定时任务）
  schedulerInterval = setInterval(checkTasks, 1000)
  if (!powerResumeRegistered) {
    powerMonitor.on('resume', handlePowerResume)
    powerResumeRegistered = true
  }
  // 启动后延迟 5 秒开始首次检查
  setTimeout(checkTasks, 5000)
}

/** 停止调度引擎 */
export function stopTaskScheduler(): void {
  if (schedulerInterval) {
    clearInterval(schedulerInterval)
    schedulerInterval = null
  }
  if (powerResumeRegistered) {
    powerMonitor.off('resume', handlePowerResume)
    powerResumeRegistered = false
  }
  // 终止所有运行中的进程
  for (const [id, child] of runningProcesses) {
    child.kill()
    runningProcesses.delete(id)
    executionToTask.delete(id)
  }
  // 中止所有运行中的 Agent
  for (const [id, agent] of runningAgents) {
    agent.abort()
    runningAgents.delete(id)
    executionToTask.delete(id)
  }
  console.log('[TaskScheduler] 调度引擎已停止')
}

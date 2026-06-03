/**
 * Agent 工具执行器
 *
 * 负责把 LLM 返回的工具调用分发到对应的实现函数，
 * 并以统一的 AgentToolResult 结构返回结果。
 *
 * 跨平台关键修正（对比方案文档）：
 *  - search_files：用 Node 递归实现，不再依赖 grep
 *  - run_command：用 child_process.exec 跨平台执行
 *  - 路径白名单：assertSafePath 跨平台（参见 security.ts）
 *  - 命令编码：复用 task-scheduler 的 decodeProcessOutput 思路
 */

import { exec, type ExecOptions } from 'child_process'
import { promisify } from 'util'
import * as fs from 'fs/promises'
import * as fsSync from 'fs'
import * as path from 'path'
import * as iconv from 'iconv-lite'
import log from 'electron-log/main'
import { shell, BrowserWindow } from 'electron'
import { IPC } from '@shared/ipc-channels'
import type {
  AgentToolCall,
  AgentToolResult,
  TodoItem,
  ScheduledTask,
  TaskSchedule,
} from '@shared/types'
import {
  getLog,
  saveLog,
  getTodos,
  saveTodos,
  getLogsInRange,
  todayStr,
} from '../store'
import { assertSafePath, expandHome, checkCommand, confirmCommandWithUser } from './security'
import { isToolEnabled } from './tool-registry'

const execAsync = promisify(exec)

/** 工具最大输出字符数（防止把整个仓库灌给 LLM） */
const MAX_TOOL_OUTPUT = 16_000

/**
 * 工具执行入口
 * 接收 LLM 解析后的 toolCall，分发到对应实现，统一封装结果
 */
export async function executeTool(call: AgentToolCall): Promise<AgentToolResult> {
  const startTime = Date.now()

  try {
    log.info(`[AgentTool] 执行: ${call.name}`, JSON.stringify(call.arguments).slice(0, 200))

    // 二次校验：即使 LLM 用了过时 schema 调到了被禁用的工具，也必须拦在分发前
    // 给 LLM 一个明确的错误，方便它换路径
    if (!isToolEnabled(call.name)) {
      throw new Error(`工具 "${call.name}" 已被用户在设置中关闭，本次会话不可用。请改用其他方式或提醒用户去「设置 → Agent 工具权限」启用。`)
    }

    let raw: string
    switch (call.name) {
      // 文件操作
      case 'read_file':    raw = await toolReadFile(call.arguments); break
      case 'write_file':   raw = await toolWriteFile(call.arguments); break
      case 'edit_file':    raw = await toolEditFile(call.arguments); break
      case 'list_files':   raw = await toolListFiles(call.arguments); break
      case 'search_files': raw = await toolSearchFiles(call.arguments); break
      // 命令执行
      case 'run_command':  raw = await toolRunCommand(call.arguments); break
      // 小牛马数据操作
      case 'get_today_log':  raw = await toolGetTodayLog(); break
      case 'get_todos':      raw = await toolGetTodos(); break
      case 'save_todo':      raw = await toolSaveTodo(call.arguments); break
      case 'update_todo':    raw = await toolUpdateTodo(call.arguments); break
      case 'append_log':     raw = await toolAppendLog(call.arguments); break
      case 'get_logs_range': raw = await toolGetLogsRange(call.arguments); break
      // 定时任务管理（Phase 3.6）
      case 'scheduler_list_tasks':  raw = await toolSchedulerListTasks(); break
      case 'scheduler_create_task': raw = await toolSchedulerCreateTask(call.arguments); break
      case 'scheduler_update_task': raw = await toolSchedulerUpdateTask(call.arguments); break
      case 'scheduler_delete_task': raw = await toolSchedulerDeleteTask(call.arguments); break
      case 'scheduler_toggle_task': raw = await toolSchedulerToggleTask(call.arguments); break
      // 系统操作
      case 'open_file':         raw = await toolOpenFile(call.arguments); break
      case 'show_notification': raw = await toolShowNotification(call.arguments); break
      // 流程控制
      case 'wait': raw = await toolWait(call.arguments); break

      default:
        return {
          toolCallId: call.id,
          toolName: call.name,
          output: '',
          error: `未知工具: ${call.name}`,
          fatal: false,
          durationMs: Date.now() - startTime,
        }
    }

    const elapsed = Date.now() - startTime
    log.info(`[AgentTool] ${call.name} 完成 ${elapsed}ms`)

    return {
      toolCallId: call.id,
      toolName: call.name,
      output: truncate(raw),
      durationMs: elapsed,
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const elapsed = Date.now() - startTime
    log.error(`[AgentTool] ${call.name} 失败 ${elapsed}ms:`, msg)
    return {
      toolCallId: call.id,
      toolName: call.name,
      output: '',
      error: msg,
      fatal: false,
      durationMs: elapsed,
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// 文件操作工具
// ═══════════════════════════════════════════════════════════════

interface ReadFileArgs { path: string; offset?: number; max_lines?: number }

async function toolReadFile(args: unknown): Promise<string> {
  const { path: p, offset = 0, max_lines } = pickArgs<ReadFileArgs>(args, ['path'])
  const target = expandHome(p)
  // 读取也走白名单（避免读取系统敏感文件如 /etc/passwd）
  assertSafePath(target)
  const content = await fs.readFile(target, 'utf-8')

  if (typeof max_lines === 'number' && max_lines > 0) {
    const lines = content.split('\n')
    const slice = lines.slice(offset, offset + max_lines)
    const total = lines.length
    return [
      `[文件: ${target}] 第 ${offset + 1}-${Math.min(offset + max_lines, total)} 行 / 共 ${total} 行`,
      slice.join('\n'),
    ].join('\n')
  }

  return [`[文件: ${target}] 共 ${content.length} 字符`, content].join('\n')
}

interface WriteFileArgs { path: string; content: string }

async function toolWriteFile(args: unknown): Promise<string> {
  const { path: p, content } = pickArgs<WriteFileArgs>(args, ['path', 'content'])
  const target = expandHome(p)
  assertSafePath(target)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, content, 'utf-8')
  return `已写入: ${target}（${content.length} 字符）`
}

interface EditFileArgs { path: string; old_string: string; new_string: string; replace_all?: boolean }

async function toolEditFile(args: unknown): Promise<string> {
  const { path: p, old_string, new_string, replace_all } = pickArgs<EditFileArgs>(args, ['path', 'old_string', 'new_string'])
  if (old_string === new_string) {
    throw new Error('old_string 与 new_string 完全一致，无需替换')
  }

  const target = expandHome(p)
  assertSafePath(target)
  const content = await fs.readFile(target, 'utf-8')

  if (replace_all) {
    const occurrences = countOccurrences(content, old_string)
    if (occurrences === 0) {
      throw new Error(`未找到匹配文本: "${preview(old_string)}"`)
    }
    const updated = content.split(old_string).join(new_string)
    await fs.writeFile(target, updated, 'utf-8')
    return `已替换 ${occurrences} 处于 ${target}`
  }

  const idx = content.indexOf(old_string)
  if (idx === -1) {
    throw new Error(`未找到匹配文本: "${preview(old_string)}"`)
  }
  // 校验唯一性，避免误改
  const next = content.indexOf(old_string, idx + old_string.length)
  if (next !== -1) {
    throw new Error('old_string 在文件中出现多次，请提供更多上下文使其唯一，或设置 replace_all=true')
  }
  const updated = content.slice(0, idx) + new_string + content.slice(idx + old_string.length)
  await fs.writeFile(target, updated, 'utf-8')
  return `已替换 1 处于 ${target}`
}

interface ListFilesArgs { path: string; pattern?: string }

async function toolListFiles(args: unknown): Promise<string> {
  const { path: p, pattern } = pickArgs<ListFilesArgs>(args, ['path'])
  const target = expandHome(p)
  assertSafePath(target)
  const entries = await fs.readdir(target, { withFileTypes: true })
  const regex = pattern ? globToRegex(pattern) : null
  const items = entries
    .filter(e => (regex ? regex.test(e.name) : true))
    .map(e => `${e.isDirectory() ? '[DIR] ' : '[FILE]'} ${e.name}`)

  if (items.length === 0) return `${target} 内无匹配项${pattern ? `（pattern=${pattern}）` : ''}`
  return [`[目录: ${target}] 共 ${items.length} 项`, ...items].join('\n')
}

interface SearchFilesArgs { path: string; query: string; file_pattern?: string; max_results?: number }

async function toolSearchFiles(args: unknown): Promise<string> {
  const { path: p, query, file_pattern, max_results = 50 } = pickArgs<SearchFilesArgs>(args, ['path', 'query'])
  const target = expandHome(p)
  assertSafePath(target)

  const fileRegex = file_pattern ? globToRegex(file_pattern) : null
  const queryLower = query.toLowerCase()
  const matched: string[] = []

  // 跨平台 Node 实现：递归遍历，避免依赖 grep
  await walkDir(target, async (filePath, name) => {
    if (matched.length >= max_results) return false  // 提前退出
    if (fileRegex && !fileRegex.test(name)) return true
    try {
      const stat = await fs.stat(filePath)
      // 跳过超大文件（>2MB），防止 OOM
      if (stat.size > 2 * 1024 * 1024) return true
      const text = await fs.readFile(filePath, 'utf-8')
      if (text.toLowerCase().includes(queryLower)) {
        matched.push(filePath)
      }
    } catch {
      // 二进制 / 权限等问题忽略
    }
    return true
  })

  if (matched.length === 0) return `未找到包含 "${query}" 的文件`
  return [`[搜索: ${query}] 命中 ${matched.length} 个文件${matched.length >= max_results ? '（已截断）' : ''}`, ...matched].join('\n')
}

// ═══════════════════════════════════════════════════════════════
// 命令执行工具
// ═══════════════════════════════════════════════════════════════

interface RunCommandArgs { command: string; work_dir?: string; timeout_ms?: number }

async function toolRunCommand(args: unknown): Promise<string> {
  const { command, work_dir, timeout_ms } = pickArgs<RunCommandArgs>(args, ['command'])

  // 第一道防线：黑名单（命令边界正则）
  const check = checkCommand(command)
  if (!check.allowed) {
    console.warn(`[Agent.tool] run_command 被黑名单拦截: ${command} | 原因: ${check.reason}`)
    throw new Error(`命令被安全策略拒绝：${check.reason ?? '未知原因'}。命令: "${preview(command, 80)}"`)
  }
  if (work_dir) {
    assertSafePath(expandHome(work_dir))
  }

  const timeout = clamp(timeout_ms ?? 30_000, 1_000, 120_000)

  // 第二道防线：人工二次确认（即使过了黑名单也强制弹窗）
  // 黑名单不是完美沙盒（如 \rm、/bin/rm、变量展开等都可能绕过），
  // 这一步把决策权交给用户，杜绝 Agent 误删/误改文件的风险
  const userAllowed = await confirmCommandWithUser({
    command,
    workDir: work_dir,
    timeoutMs: timeout,
  })
  if (!userAllowed) {
    throw new Error(`用户拒绝执行命令: "${preview(command, 80)}"`)
  }
  const opts: ExecOptions = {
    timeout,
    cwd: work_dir ? expandHome(work_dir) : undefined,
    maxBuffer: 4 * 1024 * 1024,  // 4MB
    // 不指定 encoding，让 exec 返回 Buffer，自行解码处理 Windows GBK
    encoding: 'buffer' as unknown as BufferEncoding,
    windowsHide: true,
  }

  try {
    const { stdout, stderr } = await execAsync(command, opts) as unknown as { stdout: Buffer; stderr: Buffer }
    const out = decodeProcessOutput(stdout)
    const err = decodeProcessOutput(stderr)
    return [out, err].filter(Boolean).join('\n').trim() || '(命令执行完成，无输出)'
  } catch (e: unknown) {
    // exec 失败时 e 携带 stdout/stderr/code
    const err = e as { code?: number; killed?: boolean; signal?: string; stdout?: Buffer; stderr?: Buffer; message?: string }
    const out = err.stdout ? decodeProcessOutput(err.stdout) : ''
    const errMsg = err.stderr ? decodeProcessOutput(err.stderr) : (err.message ?? String(e))
    const codeInfo = err.code !== undefined ? `（exitCode=${err.code}${err.killed ? `, killed=${err.signal}` : ''}）` : ''
    throw new Error(`命令失败${codeInfo}：${[out, errMsg].filter(Boolean).join('\n').trim()}`)
  }
}

/**
 * 智能解码子进程输出
 * Windows cmd.exe 默认 GBK，先试 UTF-8，遇到替换字符则回落 GBK（参考 task-scheduler）
 */
function decodeProcessOutput(buf: Buffer | undefined): string {
  if (!buf || buf.length === 0) return ''
  if (process.platform !== 'win32') return buf.toString('utf-8')
  const utf8 = buf.toString('utf-8')
  if (!utf8.includes('\ufffd')) return utf8
  return iconv.decode(buf, 'gbk')
}

// ═══════════════════════════════════════════════════════════════
// 小牛马数据操作工具
// ═══════════════════════════════════════════════════════════════

async function toolGetTodayLog(): Promise<string> {
  const today = todayStr()
  const log = getLog(today)
  if (!log) return `今天（${today}）还没有工作日志`
  return JSON.stringify(log, null, 2)
}

async function toolGetTodos(): Promise<string> {
  const today = todayStr()
  const todos = getTodos(today)
  if (todos.length === 0) return `今天（${today}）暂无待办`
  return [
    `今天（${today}）共 ${todos.length} 条待办：`,
    ...todos.map(t => formatTodo(t)),
  ].join('\n')
}

interface SaveTodoArgs { title: string; priority?: 'high' | 'medium' | 'low'; estimated_min?: number }

async function toolSaveTodo(args: unknown): Promise<string> {
  const { title, priority = 'medium', estimated_min } = pickArgs<SaveTodoArgs>(args, ['title'])
  const today = todayStr()
  const todos = getTodos(today)
  const newTodo: TodoItem = {
    id: `agent_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    title: String(title).slice(0, 50),
    priority,
    estimated_min: typeof estimated_min === 'number' ? estimated_min : null,
    status: 'pending',
  }
  todos.push(newTodo)
  saveTodos(today, todos)
  // 同步刷新 daily log（保持与现有 IPC TODOS_SAVE 行为一致）
  saveLog({ date: today, todos })
  return `已新增待办: ${newTodo.title}（id=${newTodo.id}, priority=${newTodo.priority}）`
}

interface UpdateTodoArgs {
  id: string
  status?: 'pending' | 'done'
  title?: string
  priority?: 'high' | 'medium' | 'low'
}

async function toolUpdateTodo(args: unknown): Promise<string> {
  const { id, status, title, priority } = pickArgs<UpdateTodoArgs>(args, ['id'])
  const today = todayStr()
  const todos = getTodos(today)
  const idx = todos.findIndex(t => t.id === id)
  if (idx === -1) throw new Error(`未找到待办: ${id}`)

  const before = { ...todos[idx] }
  if (status) todos[idx].status = status
  if (title) todos[idx].title = String(title).slice(0, 50)
  if (priority) todos[idx].priority = priority

  saveTodos(today, todos)
  saveLog({ date: today, todos })

  return `已更新待办: ${todos[idx].title}（变更：${diffSummary(before, todos[idx])}）`
}

interface AppendLogArgs { content: string; append_to?: 'eod_log' }

async function toolAppendLog(args: unknown): Promise<string> {
  const { content, append_to = 'eod_log' } = pickArgs<AppendLogArgs>(args, ['content'])
  const today = todayStr()
  const existing = getLog(today)
  if (append_to !== 'eod_log') {
    throw new Error(`不支持的字段: ${append_to}`)
  }
  const merged = (existing?.eod_log ? existing.eod_log + '\n' : '') + content
  saveLog({ date: today, eod_log: merged })
  return `已追加 ${content.length} 字符到 ${today} 的 eod_log`
}

interface GetLogsRangeArgs { start_date: string; end_date: string }

async function toolGetLogsRange(args: unknown): Promise<string> {
  const { start_date, end_date } = pickArgs<GetLogsRangeArgs>(args, ['start_date', 'end_date'])
  const logs = getLogsInRange(start_date, end_date)
  if (logs.length === 0) return `${start_date} ~ ${end_date} 范围内无日志`
  return logs.map(l => {
    const todos = l.todos.map(t => `  - [${t.status === 'done' ? '✓' : ' '}] ${t.title}`).join('\n')
    const eod = l.eod_log ? `  复盘: ${l.eod_log.replace(/\s+/g, ' ').slice(0, 200)}` : ''
    return [`## ${l.date}`, todos, eod].filter(Boolean).join('\n')
  }).join('\n\n')
}

// ═══════════════════════════════════════════════════════════════
// 定时任务管理工具（Phase 3.6）
// ═══════════════════════════════════════════════════════════════
//
// 使用动态 import 引入 task-scheduler，避免 tool-executor → task-scheduler →
// agent/orchestrator → tool-executor 的潜在循环依赖。
// 静态 import 在某些初始化顺序下会触发 "Cannot access X before initialization"

async function loadScheduler(): Promise<typeof import('../tools/task-scheduler')> {
  return await import('../tools/task-scheduler')
}

/** 把 TaskSchedule 渲染成人话给 LLM 看 */
function formatScheduleStr(s: TaskSchedule): string {
  if (s.type === 'interval') return `每 ${s.intervalMinutes ?? 60} 分钟`
  if (s.type === 'daily') return `每日 ${s.time ?? '09:00'}`
  if (s.type === 'weekly') {
    const wd = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
    return `每${wd[s.weekDay ?? 1]} ${s.time ?? '09:00'}`
  }
  return '未知'
}

async function toolSchedulerListTasks(): Promise<string> {
  const { listTasks } = await loadScheduler()
  const tasks = listTasks()
  if (tasks.length === 0) return '当前没有任何定时任务'
  return [
    `共 ${tasks.length} 条定时任务：`,
    ...tasks.map(t => {
      const kind = t.kind ?? 'shell'
      const status = t.enabled ? '启用' : '禁用'
      const body = kind === 'agent'
        ? `Agent输入="${(t.agentTask?.userInput ?? '').slice(0, 60)}"`
        : `命令="${(t.command ?? '').slice(0, 60)}"`
      return `- [${status}] ${t.name} (id=${t.id}, kind=${kind}, ${formatScheduleStr(t.schedule)}) ${body}`
    }),
  ].join('\n')
}

interface SchedulerCreateArgs {
  name: string
  kind: 'agent' | 'shell'
  user_input?: string
  command?: string
  work_dir?: string
  schedule_type: 'interval' | 'daily' | 'weekly'
  interval_minutes?: number
  time?: string
  week_day?: number
  enabled?: boolean
}

/** 校验并构造 TaskSchedule，参数缺失时给 LLM 明确的错误提示 */
function buildScheduleFromArgs(
  type: 'interval' | 'daily' | 'weekly',
  args: { interval_minutes?: number; time?: string; week_day?: number },
): TaskSchedule {
  if (type === 'interval') {
    const mins = args.interval_minutes
    if (typeof mins !== 'number' || mins < 1 || mins > 1440) {
      throw new Error('schedule_type=interval 时必须提供 1-1440 范围内的 interval_minutes')
    }
    return { type: 'interval', intervalMinutes: Math.floor(mins) }
  }
  // daily / weekly 共享 time 字段
  const t = (args.time ?? '').trim()
  if (!/^\d{1,2}:\d{2}$/.test(t)) {
    throw new Error(`schedule_type=${type} 时必须提供 HH:mm 格式的 time，例如 09:00 或 18:30`)
  }
  const [hh, mm] = t.split(':').map(Number)
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) {
    throw new Error(`time 不在合法范围：${t}`)
  }
  const time = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
  if (type === 'daily') return { type: 'daily', time }
  // weekly
  const wd = args.week_day
  if (typeof wd !== 'number' || wd < 0 || wd > 6) {
    throw new Error('schedule_type=weekly 时必须提供 week_day (0=周日 ... 6=周六)')
  }
  return { type: 'weekly', time, weekDay: Math.floor(wd) }
}

async function toolSchedulerCreateTask(args: unknown): Promise<string> {
  const a = pickArgs<SchedulerCreateArgs>(args, ['name', 'kind', 'schedule_type'])

  // 校验 kind 对应的必填字段
  if (a.kind === 'agent' && !(a.user_input ?? '').trim()) {
    throw new Error('kind=agent 时必须提供 user_input（触发时投喂给 Agent 的指令文本）')
  }
  if (a.kind === 'shell' && !(a.command ?? '').trim()) {
    throw new Error('kind=shell 时必须提供 command')
  }

  const schedule = buildScheduleFromArgs(a.schedule_type, a)

  const { saveTask } = await loadScheduler()
  const draft: Partial<ScheduledTask> & { name: string } = {
    name: a.name.trim().slice(0, 50),
    kind: a.kind,
    command: a.kind === 'shell' ? a.command!.trim() : '',
    workDir: a.kind === 'shell' ? (a.work_dir ?? '') : '',
    schedule,
    enabled: a.enabled ?? true,
  }
  if (a.kind === 'agent') {
    draft.agentTask = { userInput: a.user_input!.trim() }
  }

  const task = saveTask(draft)
  log.info(`[AgentTool] scheduler_create_task: id=${task.id} name="${task.name}" kind=${task.kind} ${formatScheduleStr(task.schedule)}`)
  return [
    `✅ 已创建定时任务：${task.name}`,
    `id：${task.id}`,
    `类型：${task.kind ?? 'shell'}`,
    `调度：${formatScheduleStr(task.schedule)}`,
    `状态：${task.enabled ? '已启用' : '已禁用'}`,
  ].join('\n')
}

interface SchedulerUpdateArgs {
  id: string
  name?: string
  user_input?: string
  command?: string
  work_dir?: string
  schedule_type?: 'interval' | 'daily' | 'weekly'
  interval_minutes?: number
  time?: string
  week_day?: number
  enabled?: boolean
}

async function toolSchedulerUpdateTask(args: unknown): Promise<string> {
  const a = pickArgs<SchedulerUpdateArgs>(args, ['id'])
  const { listTasks, saveTask } = await loadScheduler()
  const existing = listTasks().find(t => t.id === a.id)
  if (!existing) throw new Error(`定时任务不存在: ${a.id}`)

  // 在旧值之上叠加：未传的字段保持原值
  const merged: Partial<ScheduledTask> & { name: string } = {
    ...existing,
    name: (a.name ?? existing.name).trim().slice(0, 50),
  }
  if (a.command !== undefined) merged.command = a.command.trim()
  if (a.work_dir !== undefined) merged.workDir = a.work_dir
  if (a.enabled !== undefined) merged.enabled = a.enabled
  if (a.user_input !== undefined) {
    merged.agentTask = { userInput: a.user_input.trim() }
  }

  if (a.schedule_type) {
    // 整体替换 schedule（必须重新校验全部字段）
    merged.schedule = buildScheduleFromArgs(a.schedule_type, a)
  } else {
    // 同类型下覆盖局部字段，复用原 type
    const s: TaskSchedule = { ...existing.schedule }
    if (a.interval_minutes !== undefined && s.type === 'interval') s.intervalMinutes = a.interval_minutes
    if (a.time !== undefined && (s.type === 'daily' || s.type === 'weekly')) s.time = a.time
    if (a.week_day !== undefined && s.type === 'weekly') s.weekDay = a.week_day
    merged.schedule = s
  }

  const updated = saveTask(merged)
  log.info(`[AgentTool] scheduler_update_task: id=${updated.id} name="${updated.name}" ${formatScheduleStr(updated.schedule)}`)
  return [
    `✅ 已更新定时任务：${updated.name}`,
    `id：${updated.id}`,
    `调度：${formatScheduleStr(updated.schedule)}`,
    `状态：${updated.enabled ? '已启用' : '已禁用'}`,
  ].join('\n')
}

interface SchedulerIdArg { id: string }

async function toolSchedulerDeleteTask(args: unknown): Promise<string> {
  const { id } = pickArgs<SchedulerIdArg>(args, ['id'])
  const { listTasks, deleteTask } = await loadScheduler()
  const target = listTasks().find(t => t.id === id)
  if (!target) throw new Error(`定时任务不存在: ${id}`)
  const ok = deleteTask(id)
  if (!ok) throw new Error(`删除失败: ${id}`)
  log.info(`[AgentTool] scheduler_delete_task: id=${id} name="${target.name}"`)
  return `🗑 已删除定时任务：${target.name} (id=${id})`
}

async function toolSchedulerToggleTask(args: unknown): Promise<string> {
  const { id } = pickArgs<SchedulerIdArg>(args, ['id'])
  const { toggleTask } = await loadScheduler()
  const task = toggleTask(id)
  if (!task) throw new Error(`定时任务不存在: ${id}`)
  log.info(`[AgentTool] scheduler_toggle_task: id=${task.id} enabled=${task.enabled}`)
  return `${task.enabled ? '▶ 已启用' : '⏸ 已禁用'} 定时任务：${task.name} (id=${task.id})`
}

// ═══════════════════════════════════════════════════════════════
// 系统操作工具
// ═══════════════════════════════════════════════════════════════

interface OpenFileArgs { path: string }

async function toolOpenFile(args: unknown): Promise<string> {
  const { path: p } = pickArgs<OpenFileArgs>(args, ['path'])
  const target = expandHome(p)
  assertSafePath(target)
  if (!fsSync.existsSync(target)) throw new Error(`文件不存在: ${target}`)
  const err = await shell.openPath(target)
  if (err) throw new Error(`打开失败: ${err}`)
  return `已用系统默认程序打开: ${target}`
}

interface ShowNotificationArgs { title: string; body: string }

async function toolShowNotification(args: unknown): Promise<string> {
  const { title, body } = pickArgs<ShowNotificationArgs>(args, ['title', 'body'])
  const safeTitle = String(title).slice(0, 40)
  const safeBody = String(body).slice(0, 200)

  // 推送给所有窗口（小猫气泡）
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(IPC.AGENT_NOTIFICATION, {
        title: safeTitle,
        body: safeBody,
        type: 'tool',
      })
    }
  }

  // 同时显示系统通知（macOS / Windows 都支持）
  try {
    const { Notification } = await import('electron')
    new Notification({ title: safeTitle, body: safeBody }).show()
  } catch (e) {
    log.warn('[AgentTool] 系统通知失败:', e)
  }

  return `已发送通知: ${safeTitle}`
}

interface WaitArgs { ms: number }

async function toolWait(args: unknown): Promise<string> {
  const { ms } = pickArgs<WaitArgs>(args, ['ms'])
  const safe = clamp(ms, 1, 60_000)
  await new Promise<void>(resolve => setTimeout(resolve, safe))
  return `已等待 ${safe} ms`
}

// ═══════════════════════════════════════════════════════════════
// 工具内部辅助
// ═══════════════════════════════════════════════════════════════

/**
 * 校验并提取参数（type-safe）
 * 缺少必填字段时直接抛错，让 LLM 看到明确反馈
 *
 * 泛型用 object 约束而非 Record，便于业务侧用精确接口；
 * 内部仍把 args 当 Record 校验。
 */
function pickArgs<T extends object>(
  args: unknown,
  required: ReadonlyArray<keyof T & string>,
): T {
  if (!args || typeof args !== 'object') {
    throw new Error('工具参数必须是对象')
  }
  const obj = args as Record<string, unknown>
  for (const key of required) {
    if (obj[key] === undefined || obj[key] === null || obj[key] === '') {
      throw new Error(`缺少必填参数: ${String(key)}`)
    }
  }
  return obj as unknown as T
}

/** 把过长的工具输出截断，避免一次工具调用就把 context 占满 */
function truncate(text: string): string {
  if (text.length <= MAX_TOOL_OUTPUT) return text
  const head = text.slice(0, Math.floor(MAX_TOOL_OUTPUT * 0.7))
  const tail = text.slice(-Math.floor(MAX_TOOL_OUTPUT * 0.2))
  return `${head}\n\n...（输出过长，中间 ${text.length - head.length - tail.length} 字符已省略）...\n\n${tail}`
}

function preview(s: string, n = 50): string {
  return s.length > n ? s.slice(0, n) + '…' : s
}

function countOccurrences(text: string, sub: string): number {
  if (!sub) return 0
  let count = 0
  let pos = 0
  while ((pos = text.indexOf(sub, pos)) !== -1) {
    count++
    pos += sub.length
  }
  return count
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n))
}

function globToRegex(pattern: string): RegExp {
  // 仅实现常用通配：* / ? / [...]；不支持 ** 等高级语法
  const escaped = pattern
    .replace(/[.+^$(){}|]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`, 'i')
}

/** 简易递归遍历目录 */
async function walkDir(
  dir: string,
  visit: (filePath: string, name: string) => Promise<boolean>,
): Promise<void> {
  let entries: fsSync.Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    // 跳过常见噪音目录，加速遍历
    if (entry.isDirectory()) {
      if (['node_modules', '.git', '.next', 'dist', 'build', 'release', '.venv', '__pycache__'].includes(entry.name)) continue
      await walkDir(path.join(dir, entry.name), visit)
    } else if (entry.isFile()) {
      const cont = await visit(path.join(dir, entry.name), entry.name)
      if (cont === false) return
    }
  }
}

function formatTodo(t: TodoItem): string {
  const status = t.status === 'done' ? '✓' : ' '
  const est = t.estimated_min ? ` ⏱${t.estimated_min}m` : ''
  return `  [${status}] ${t.title} (id=${t.id}, priority=${t.priority}${est})`
}

function diffSummary(before: TodoItem, after: TodoItem): string {
  const parts: string[] = []
  if (before.status !== after.status) parts.push(`status ${before.status}→${after.status}`)
  if (before.priority !== after.priority) parts.push(`priority ${before.priority}→${after.priority}`)
  if (before.title !== after.title) parts.push(`title 已修改`)
  return parts.join(', ') || '无变化'
}

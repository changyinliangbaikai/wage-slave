/**
 * Agent 工具执行器
 *
 * 负责把 LLM 返回的工具调用分发到对应的实现函数，
 * 并以统一的 AgentToolResult 结构返回结果。
 *
 * 跨平台关键修正（对比方案文档）：
 *  - search_files：用 Node 递归实现，不再依赖 grep
 *  - run_command：用 child_process.spawn 跨平台执行
 *  - 路径白名单：assertSafePath 跨平台（参见 security.ts）
 *  - 命令编码：复用 task-scheduler 的 decodeProcessOutput 思路
 */

import { spawn, spawnSync, type ChildProcess } from 'child_process'
import * as fs from 'fs/promises'
import * as fsSync from 'fs'
import * as path from 'path'
import * as readline from 'readline'
import * as iconv from 'iconv-lite'
import * as os from 'os'
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
import { recordAgentAudit } from './audit-log'
import { extractFileContent } from '../file-attachment/service'
import { grepCode, globFiles } from './code-search'
import { gitStatus, gitDiff, gitLog } from './git-tools'
import { webFetch, webSearch } from './web-tools'
import { buildToolArgumentParseErrorMessage, getToolArgumentParseError } from './output-limit-handling'
import {
  getAllSkills,
  getSkillById,
  saveUserSkill,
  toggleSkill,
  deleteUserSkill,
  validateSkill,
} from './skills/store'
import type { AgentSkill } from '@shared/types'

/** 工具最大输出字符数（防止把整个仓库灌给 LLM） */
const MAX_TOOL_OUTPUT = 16_000
const DEFAULT_READ_FILE_LINES = 200
const MAX_READ_FILE_LINES = 1_000
const MAX_COMMAND_BUFFER = 4 * 1024 * 1024

/**
 * 工具执行上下文
 * - signal：用户/超时中断
 * - projectCwd：当前会话所属项目的绝对工作目录，作为相对路径解析基准；
 *   未传时回退到 process.cwd()，保证旧调用方兼容
 */
export interface ToolExecContext {
  signal?: AbortSignal
  projectCwd?: string
}

/**
 * 把相对路径基于项目根目录解析为绝对路径
 * 优先展开 ~/ ，绝对路径直接返回；相对路径用 projectCwd 拼接，避免依赖 process.cwd()
 */
export function resolvePath(p: string, projectCwd?: string): string {
  const expanded = expandHome(p)
  if (path.isAbsolute(expanded)) return expanded
  const base = projectCwd && projectCwd.length > 0 ? projectCwd : process.cwd()
  return path.resolve(base, expanded)
}

/**
 * 工具执行入口
 * 接收 LLM 解析后的 toolCall，分发到对应实现，统一封装结果
 *
 * 第二参数兼容两种形态：
 *  - AbortSignal（旧调用方）
 *  - ToolExecContext（含 projectCwd，新调用方）
 */
export async function executeTool(
  call: AgentToolCall,
  signalOrCtx?: AbortSignal | ToolExecContext,
): Promise<AgentToolResult> {
  const startTime = Date.now()
  // 兼容旧签名：第二参数若是 AbortSignal 直接当 signal 用
  const ctx: ToolExecContext = signalOrCtx && 'aborted' in signalOrCtx
    ? { signal: signalOrCtx as AbortSignal }
    : ((signalOrCtx ?? {}) as ToolExecContext)
  const signal = ctx.signal
  const cwd = ctx.projectCwd

  try {
    log.info(`[AgentTool] 执行: ${call.name}`, JSON.stringify(call.arguments).slice(0, 200))

    // 二次校验：即使 LLM 用了过时 schema 调到了被禁用的工具，也必须拦在分发前
    // 给 LLM 一个明确的错误，方便它换路径
    if (!isToolEnabled(call.name)) {
      throw new Error(`工具 "${call.name}" 已被用户在设置中关闭，本次会话不可用。请改用其他方式或提醒用户去「设置 → Agent 工具权限」启用。`)
    }

    if (getToolArgumentParseError(call)) {
      throw new Error(buildToolArgumentParseErrorMessage(call))
    }

    let raw: string
    let updatedCwd: string | undefined
    switch (call.name) {
      // 文件操作
      case 'read_file':    raw = await toolReadFile(call.arguments, cwd); break
      case 'write_file':   raw = await toolWriteFile(call.arguments, cwd); break
      case 'edit_file':    raw = await toolEditFile(call.arguments, cwd); break
      case 'list_files':   raw = await toolListFiles(call.arguments, cwd); break
      case 'search_files': raw = await toolSearchFiles(call.arguments, cwd); break
      case 'grep_code':    raw = await toolGrepCode(call.arguments, cwd); break
      case 'glob_files':   raw = await toolGlobFiles(call.arguments, cwd); break
      // Git 只读
      case 'git_status':   raw = await toolGitStatus(call.arguments, cwd); break
      case 'git_diff':     raw = await toolGitDiff(call.arguments, cwd); break
      case 'git_log':      raw = await toolGitLog(call.arguments, cwd); break
      // Web 网络工具
      case 'web_fetch':    raw = await toolWebFetch(call.arguments); break
      case 'web_search':   raw = await toolWebSearch(call.arguments); break
      // 命令执行
      case 'run_command': {
        const res = await toolRunCommand(call.arguments, signal, cwd)
        raw = res.output
        updatedCwd = res.updatedCwd
        break
      }
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
      // 技能管理
      case 'skill_list':   raw = await toolSkillList(); break
      case 'skill_get':    raw = await toolSkillGet(call.arguments as { id: string }); break
      case 'skill_install': raw = await toolSkillInstall(call.arguments as { skill_json: string }); break
      case 'skill_update': raw = await toolSkillUpdate(call.arguments as { skill_json: string }); break
      case 'skill_toggle': raw = await toolSkillToggle(call.arguments as { id: string; enabled: boolean }); break
      case 'skill_delete': raw = await toolSkillDelete(call.arguments as { id: string }); break
      // 系统操作
      case 'open_file':         raw = await toolOpenFile(call.arguments, cwd); break
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
      updatedCwd,
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

async function toolReadFile(args: unknown, cwd?: string): Promise<string> {
  const { path: p, offset = 0, max_lines } = pickArgs<ReadFileArgs>(args, ['path'])
  // 相对路径以当前会话所属项目根 cwd 解析，避免依赖 process.cwd（多会话并发不安全）
  const target = resolvePath(p, cwd)
  // 读取也走白名单（避免读取系统敏感文件如 /etc/passwd）
  assertSafePath(target, cwd)
  const safeOffset = Math.max(0, Math.floor(offset))
  const requestedLines = typeof max_lines === 'number' && max_lines > 0
    ? Math.floor(max_lines)
    : DEFAULT_READ_FILE_LINES
  const safeMaxLines = clamp(requestedLines, 1, MAX_READ_FILE_LINES)

  const ext = path.extname(target).toLowerCase()
  const isBinaryDoc = ['.docx', '.doc', '.pdf', '.xlsx', '.xls'].includes(ext)

  let lines: string[]
  let truncated = false

  if (isBinaryDoc) {
    // 对于二进制文档，提取出解析后的文本，按行切分后执行 offset 和 maxLines 过滤
    // 限制单次提取最大 100,000 字符，防止把内存撑爆
    const { content } = await extractFileContent(target, 100000)
    const allLines = content.split('\n')
    lines = allLines.slice(safeOffset, safeOffset + safeMaxLines)
    truncated = safeOffset + safeMaxLines < allLines.length
  } else {
    // 普通文本文件按原有流式方法读取
    const res = await readFileLines(target, safeOffset, safeMaxLines)
    lines = res.lines
    truncated = res.truncated
  }

  const docTypeDesc = isBinaryDoc ? ` [已解析文档]` : ''
  const note = [
    `[文件: ${target}${docTypeDesc}] 第 ${safeOffset + 1}-${safeOffset + lines.length} 行，最多读取 ${safeMaxLines} 行`,
    max_lines === undefined ? `未指定 max_lines，已使用默认限制 ${DEFAULT_READ_FILE_LINES} 行` : '',
    requestedLines > MAX_READ_FILE_LINES ? `max_lines 超过上限，已限制为 ${MAX_READ_FILE_LINES} 行` : '',
    truncated ? `后续内容已省略；可用 offset=${safeOffset + lines.length} 继续分块读取` : '',
  ].filter(Boolean).join('；')

  return [note, lines.join('\n')].join('\n')
}

interface WriteFileArgs { path: string; content?: string }

async function toolWriteFile(args: unknown, cwd?: string): Promise<string> {
  const { path: p, content = '' } = pickArgs<WriteFileArgs>(args, ['path'])
  const target = resolvePath(p, cwd)
  assertSafePath(target, cwd)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, content, 'utf-8')
  recordAgentAudit({
    tool: 'write_file',
    action: 'write',
    target,
    summary: `写入 ${content.length} 字符`,
  })
  return content.length === 0
    ? `已创建空文件: ${target}`
    : `已写入: ${target}（${content.length} 字符）`
}

interface EditFileArgs { path: string; old_string: string; new_string: string; replace_all?: boolean }

async function toolEditFile(args: unknown, cwd?: string): Promise<string> {
  const { path: p, old_string, new_string, replace_all } = pickArgs<EditFileArgs>(args, ['path', 'old_string', 'new_string'])
  if (old_string === new_string) {
    throw new Error('old_string 与 new_string 完全一致，无需替换')
  }

  const target = resolvePath(p, cwd)
  assertSafePath(target, cwd)
  const content = await fs.readFile(target, 'utf-8')

  if (replace_all) {
    const occurrences = countOccurrences(content, old_string)
    if (occurrences === 0) {
      throw new Error(buildEditNotFoundError(content, old_string))
    }
    const updated = content.split(old_string).join(new_string)
    await fs.writeFile(target, updated, 'utf-8')
    recordAgentAudit({
      tool: 'edit_file',
      action: 'replace_all',
      target,
      summary: `替换 ${occurrences} 处`,
    })
    return `已替换 ${occurrences} 处于 ${target}`
  }

  const idx = content.indexOf(old_string)
  if (idx === -1) {
    // 精确匹配失败 → 尝试模糊匹配（忽略行尾空白与缩进差异）
    const fuzzy = findFuzzyMatch(content, old_string)
    if (fuzzy) {
      const updated = content.slice(0, fuzzy.startIndex) + new_string + content.slice(fuzzy.endIndex)
      await fs.writeFile(target, updated, 'utf-8')
      recordAgentAudit({
        tool: 'edit_file',
        action: 'replace_one_fuzzy',
        target,
        summary: '模糊匹配替换 1 处',
      })
      return `已替换 1 处于 ${target}（注意：使用了模糊匹配，原文与 old_string 在空白字符上有差异）`
    }
    throw new Error(buildEditNotFoundError(content, old_string))
  }
  // 校验唯一性，避免误改
  const next = content.indexOf(old_string, idx + old_string.length)
  if (next !== -1) {
    throw new Error('old_string 在文件中出现多次，请提供更多上下文使其唯一，或设置 replace_all=true')
  }
  const updated = content.slice(0, idx) + new_string + content.slice(idx + old_string.length)
  await fs.writeFile(target, updated, 'utf-8')
  recordAgentAudit({
    tool: 'edit_file',
    action: 'replace_one',
    target,
    summary: '替换 1 处',
  })
  return `已替换 1 处于 ${target}`
}

/**
 * 编辑失败时构造一个对 LLM 友好的错误信息：包含相似行提示
 * 为 LLM 提供"自我修正"的线索（哪一行最像它想替换的内容）
 */
function buildEditNotFoundError(content: string, oldString: string): string {
  const similar = findMostSimilarLines(content, oldString, 3)
  const base = `未找到匹配文本: "${preview(oldString)}"`
  if (similar.length === 0) return base
  const hint = similar.map(s => `  · 第 ${s.line} 行: "${preview(s.text, 80)}"`).join('\n')
  return `${base}\n文件中最相似的位置：\n${hint}\n请重新阅读文件以获取确切上下文。`
}

/**
 * 模糊匹配：先尝试忽略行尾空白，再尝试忽略统一缩进差异
 * 命中时返回原文中的起止索引，调用方据此切片替换
 *
 * 安全保障：mapTrimmedIndexToOriginal 用启发式把 stripped 索引映射回原文，
 * 偏移可能算错。因此命中后必须回切原文片段，应用同一 strip 函数校验
 * 结果确实等于 strippedOld；不一致则放弃该候选，避免写坏文件。
 */
function findFuzzyMatch(
  content: string,
  oldString: string,
): { startIndex: number; endIndex: number } | null {
  // 策略 1：trim 行尾空白
  const trimRight = (s: string) => s.split('\n').map(l => l.replace(/[ \t]+$/g, '')).join('\n')
  const trimmedContent = trimRight(content)
  const trimmedOld = trimRight(oldString)
  let idx = trimmedContent.indexOf(trimmedOld)
  if (idx !== -1) {
    const cand = mapTrimmedIndexToOriginal(content, trimmedContent, idx, trimmedOld.length)
    if (cand && verifyFuzzySlice(content, cand, trimRight, trimmedOld)) return cand
  }

  // 策略 2：去掉每行前导空白后比较
  const stripIndent = (s: string) => s.split('\n').map(l => l.trim()).join('\n')
  const strippedContent = stripIndent(content)
  const strippedOld = stripIndent(oldString)
  idx = strippedContent.indexOf(strippedOld)
  if (idx !== -1 && strippedOld.length > 10) {
    // 仅在 old_string 较长时启用激进模糊匹配，避免误命中
    const cand = mapTrimmedIndexToOriginal(content, strippedContent, idx, strippedOld.length)
    if (cand && verifyFuzzySlice(content, cand, stripIndent, strippedOld)) return cand
  }

  return null
}

/**
 * 校验模糊匹配切出的原文片段，经同一 strip 函数处理后确实等于目标字符串
 * 这是写盘前的最后一道防线：mapTrimmedIndexToOriginal 偏移算错时此处会失败，
 * 从而放弃替换而不是写坏文件
 */
function verifyFuzzySlice(
  content: string,
  cand: { startIndex: number; endIndex: number },
  strip: (s: string) => string,
  expected: string,
): boolean {
  if (cand.startIndex < 0 || cand.endIndex > content.length || cand.startIndex >= cand.endIndex) {
    return false
  }
  const slice = content.slice(cand.startIndex, cand.endIndex)
  return strip(slice) === expected
}

/**
 * 通过逐字符比对的方式，把"trimmed 后字符串"上的索引映射回原始字符串的索引
 * trimmed 字符串和原始字符串的行数相同，只是每行去除了部分字符
 */
function mapTrimmedIndexToOriginal(
  original: string,
  trimmed: string,
  trimmedStart: number,
  trimmedLen: number,
): { startIndex: number; endIndex: number } | null {
  // 计算 trimmed 中起点对应的行号 + 列号
  const before = trimmed.slice(0, trimmedStart)
  const startLine = (before.match(/\n/g) ?? []).length
  const startCol = trimmedStart - (before.lastIndexOf('\n') + 1)

  const trimmedSlice = trimmed.slice(trimmedStart, trimmedStart + trimmedLen)
  const endLineOffset = (trimmedSlice.match(/\n/g) ?? []).length
  const lastNl = trimmedSlice.lastIndexOf('\n')
  const endCol = lastNl === -1 ? startCol + trimmedLen : trimmedSlice.length - lastNl - 1

  // 在原文中找到对应行的起始位置
  const origLines = original.split('\n')
  if (startLine >= origLines.length) return null
  const startLineBegin = origLines.slice(0, startLine).reduce((s, l) => s + l.length + 1, 0)

  // trimmed 的每行去掉了前导/尾随空白，需要在原行中找到对应字符位置
  const origStartLine = origLines[startLine]
  const trimmedStartLine = trimmed.split('\n')[startLine] ?? ''
  // 找到 trimmedStartLine 在原行中的位置（容错：从行头开始）
  const origStartLineIdx = origStartLine.indexOf(trimmedStartLine.slice(0, Math.max(1, trimmedStartLine.length / 2) | 0))
  const startInLine = origStartLineIdx >= 0 ? origStartLineIdx + startCol : startCol
  const startIndex = startLineBegin + startInLine

  // 终点行类似处理
  const endLine = startLine + endLineOffset
  if (endLine >= origLines.length) return null
  const endLineBegin = origLines.slice(0, endLine).reduce((s, l) => s + l.length + 1, 0)
  const origEndLine = origLines[endLine]
  const trimmedEndLine = trimmed.split('\n')[endLine] ?? ''
  const origEndLineIdx = origEndLine.indexOf(trimmedEndLine.slice(0, Math.max(1, trimmedEndLine.length / 2) | 0))
  const endInLine = origEndLineIdx >= 0 ? origEndLineIdx + endCol : endCol
  const endIndex = endLineBegin + endInLine

  if (startIndex >= endIndex || endIndex > original.length) return null
  return { startIndex, endIndex }
}

/** 找出文件中与 oldString 最相似的 N 行（用于错误提示） */
function findMostSimilarLines(
  content: string,
  oldString: string,
  topN: number,
): Array<{ line: number; text: string; score: number }> {
  const lines = content.split('\n')
  // 取 oldString 的首行作为指纹
  const fingerprint = oldString.split('\n')[0].trim().slice(0, 50)
  if (fingerprint.length < 4) return []  // 太短不做相似度判断

  const candidates: Array<{ line: number; text: string; score: number }> = []
  for (let i = 0; i < lines.length; i++) {
    const score = similarity(lines[i].trim(), fingerprint)
    if (score > 0.5) {
      candidates.push({ line: i + 1, text: lines[i], score })
    }
  }
  candidates.sort((a, b) => b.score - a.score)
  return candidates.slice(0, topN)
}

/** 简单相似度：基于公共子串长度 / 长字符串长度 */
function similarity(a: string, b: string): number {
  if (!a || !b) return 0
  const longer = a.length >= b.length ? a : b
  const shorter = a.length >= b.length ? b : a
  if (longer.length === 0) return 1
  // 滑动窗口找最长公共子串
  let best = 0
  for (let i = 0; i + shorter.length <= longer.length; i++) {
    let match = 0
    for (let j = 0; j < shorter.length; j++) {
      if (longer[i + j] === shorter[j]) match++
    }
    if (match > best) best = match
  }
  return best / longer.length
}

interface ListFilesArgs { path: string; pattern?: string; depth?: number; show_size?: boolean }

const LIST_FILES_MAX_ITEMS = 200
const NOISY_DIRS_FOR_LIST = new Set([
  'node_modules', '.git', '.svn', '.hg',
  'dist', 'build', 'out', 'target',
  '.next', '.nuxt', '.svelte-kit',
  'coverage', '.nyc_output',
  '.venv', 'venv', '__pycache__',
  '.cache', '.parcel-cache', '.turbo', 'release',
])

async function toolListFiles(args: unknown, cwd?: string): Promise<string> {
  const { path: p, pattern, depth: rawDepth, show_size } = pickArgs<ListFilesArgs>(args, ['path'])
  const target = resolvePath(p, cwd)
  assertSafePath(target, cwd)

  const depth = clamp(rawDepth ?? 1, 1, 5)
  const regex = pattern ? globToRegex(pattern) : null
  const items: string[] = []

  // 递归遍历到指定深度；噪音目录直接跳过（保留目录名但不展开）
  async function visit(dir: string, currentDepth: number): Promise<void> {
    if (items.length >= LIST_FILES_MAX_ITEMS) return
    let entries: fsSync.Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    // 排序：目录在前，文件在后；同类按字母
    entries.sort((a, b) => {
      const aDir = a.isDirectory() ? 0 : 1
      const bDir = b.isDirectory() ? 0 : 1
      return aDir !== bDir ? aDir - bDir : a.name.localeCompare(b.name)
    })

    for (const entry of entries) {
      if (items.length >= LIST_FILES_MAX_ITEMS) return
      const relIndent = '  '.repeat(currentDepth - 1)
      if (entry.isDirectory()) {
        const isNoisy = NOISY_DIRS_FOR_LIST.has(entry.name)
        if (isNoisy && depth > 1) {
          items.push(`${relIndent}[DIR]  ${entry.name}/  (已折叠，跳过递归)`)
          continue
        }
        // pattern 仅对文件名生效；深层目录始终列出
        items.push(`${relIndent}[DIR]  ${entry.name}/`)
        if (currentDepth < depth) {
          await visit(path.join(dir, entry.name), currentDepth + 1)
        }
      } else if (entry.isFile()) {
        if (regex && !regex.test(entry.name)) continue
        let sizeInfo = ''
        if (show_size) {
          try {
            const stat = await fs.stat(path.join(dir, entry.name))
            sizeInfo = `  (${formatFileSize(stat.size)})`
          } catch { /* ignore */ }
        }
        items.push(`${relIndent}[FILE] ${entry.name}${sizeInfo}`)
      }
    }
  }

  await visit(target, 1)

  if (items.length === 0) {
    return `${target} 内无匹配项${pattern ? `（pattern=${pattern}）` : ''}`
  }
  const header = `[目录: ${target}] 共 ${items.length} 项，递归深度 ${depth}${items.length >= LIST_FILES_MAX_ITEMS ? `（已截断到 ${LIST_FILES_MAX_ITEMS}）` : ''}`
  return [header, ...items].join('\n')
}

/** 友好的文件大小展示 */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

interface SearchFilesArgs { path: string; query: string; file_pattern?: string; max_results?: number }

async function toolSearchFiles(args: unknown, cwd?: string): Promise<string> {
  const { path: p, query, file_pattern, max_results = 50 } = pickArgs<SearchFilesArgs>(args, ['path', 'query'])
  const target = resolvePath(p, cwd)
  assertSafePath(target, cwd)

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

// ── grep_code / glob_files：编程任务专用搜索工具 ─────────────────
// 实现在 ./code-search.ts；此处仅做参数透传和审计记录

interface GrepCodeArgs {
  pattern: string
  path?: string
  include?: string
  context_lines?: number
  case_insensitive?: boolean
  max_results?: number
  output_mode?: 'content' | 'files_with_matches' | 'count'
}

async function toolGrepCode(args: unknown, cwd?: string): Promise<string> {
  const parsed = pickArgs<GrepCodeArgs>(args, ['pattern'])
  // 把项目 cwd 注入参数：参数缺省时使用项目根作为搜索起点
  const merged = { ...parsed, path: parsed.path ?? cwd }
  recordAgentAudit({
    tool: 'grep_code',
    action: 'grep',
    target: merged.path || process.cwd(),
    summary: `pattern=${preview(parsed.pattern, 80)}${parsed.include ? `, include=${parsed.include}` : ''}`,
  })
  return await grepCode(merged)
}

interface GlobFilesArgs {
  pattern: string
  path?: string
  max_results?: number
}

async function toolGlobFiles(args: unknown, cwd?: string): Promise<string> {
  const parsed = pickArgs<GlobFilesArgs>(args, ['pattern'])
  const merged = { ...parsed, path: parsed.path ?? cwd }
  recordAgentAudit({
    tool: 'glob_files',
    action: 'glob',
    target: merged.path || process.cwd(),
    summary: `pattern=${preview(parsed.pattern, 80)}`,
  })
  return await globFiles(merged)
}

// ── Git 只读工具 ──────────────────────────────────────────

interface GitStatusArgs { work_dir?: string }
async function toolGitStatus(args: unknown, cwd?: string): Promise<string> {
  const parsed = pickArgs<GitStatusArgs>(args, [])
  return await gitStatus({ ...parsed, work_dir: parsed.work_dir ?? cwd })
}

interface GitDiffArgs {
  work_dir?: string
  paths?: string[]
  cached?: boolean
  name_only?: boolean
  ref?: string
}
async function toolGitDiff(args: unknown, cwd?: string): Promise<string> {
  const parsed = pickArgs<GitDiffArgs>(args, [])
  return await gitDiff({ ...parsed, work_dir: parsed.work_dir ?? cwd })
}

interface GitLogArgs {
  work_dir?: string
  limit?: number
  file?: string
  with_stat?: boolean
  ref?: string
}
async function toolGitLog(args: unknown, cwd?: string): Promise<string> {
  const parsed = pickArgs<GitLogArgs>(args, [])
  return await gitLog({ ...parsed, work_dir: parsed.work_dir ?? cwd })
}

// ── Web 网络工具 ──────────────────────────────────────────

interface WebFetchArgs { url: string; max_chars?: number }
async function toolWebFetch(args: unknown): Promise<string> {
  const parsed = pickArgs<WebFetchArgs>(args, ['url'])
  recordAgentAudit({
    tool: 'web_fetch',
    action: 'fetch',
    target: parsed.url,
    summary: `抓取 URL`,
  })
  return await webFetch(parsed)
}

interface WebSearchArgs { query: string; max_results?: number }
async function toolWebSearch(args: unknown): Promise<string> {
  const parsed = pickArgs<WebSearchArgs>(args, ['query'])
  recordAgentAudit({
    tool: 'web_search',
    action: 'search',
    target: parsed.query,
    summary: preview(parsed.query, 200),
  })
  return await webSearch(parsed)
}

// ═══════════════════════════════════════════════════════════════
// 命令执行工具
// ═══════════════════════════════════════════════════════════════

interface RunCommandArgs { command: string; work_dir?: string; timeout_ms?: number }

/**
 * 自动探测可用 Shell
 */
async function findSuitableShell(): Promise<string> {
  if (process.env.CLAUDE_CODE_SHELL && isExecutable(process.env.CLAUDE_CODE_SHELL)) {
    return process.env.CLAUDE_CODE_SHELL
  }
  const envShell = process.env.SHELL
  if (envShell && (envShell.includes('bash') || envShell.includes('zsh')) && isExecutable(envShell)) {
    return envShell
  }
  const candidates = [
    '/bin/zsh',
    '/bin/bash',
    '/usr/bin/zsh',
    '/usr/bin/bash',
    '/usr/local/bin/zsh',
    '/usr/local/bin/bash'
  ]
  for (const c of candidates) {
    if (isExecutable(c)) return c
  }
  return '/bin/sh'
}

function isExecutable(filePath: string): boolean {
  try {
    fsSync.accessSync(filePath, fsSync.constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * 获取 Shell 基础配置
 */
interface ShellConfig {
  shell: string
  argsPrefix: string[]
  isPowerShell: boolean
}

async function getShellConfig(): Promise<ShellConfig> {
  const isWin = process.platform === 'win32'
  if (isWin) {
    const pwshProbe = spawnSync('pwsh', ['--version'], { stdio: 'ignore' })
    const shell = pwshProbe.status === 0 ? 'pwsh' : 'powershell.exe'
    return {
      shell,
      argsPrefix: ['-NoProfile', '-NonInteractive', '-Command'],
      isPowerShell: true
    }
  } else {
    const shell = await findSuitableShell()
    return {
      shell,
      argsPrefix: ['-c'],
      isPowerShell: false
    }
  }
}

function quoteForPosixShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function quoteForPowerShell(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function buildTrackedShellCommand(command: string, cwdFile: string, isPowerShell: boolean): string {
  if (isPowerShell) {
    const quotedCwdFile = quoteForPowerShell(cwdFile)
    return [
      '& {',
      "  $ErrorActionPreference = 'Continue'",
      '  $__exitCode = 0',
      '  try {',
      command,
      '    if ($LASTEXITCODE -is [int]) { $__exitCode = $LASTEXITCODE } elseif (-not $?) { $__exitCode = 1 }',
      '  } finally {',
      '    $__cwd = (Get-Location).Path',
      `    [System.IO.File]::WriteAllText(${quotedCwdFile}, $__cwd)`,
      '  }',
      '  exit $__exitCode',
      '}',
    ].join('\n')
  }

  const quotedCwdFile = quoteForPosixShell(cwdFile)
  return [
    'if [ -n "${BASH_VERSION:-}" ]; then',
    '  shopt -u extglob 2>/dev/null || true',
    'elif [ -n "${ZSH_VERSION:-}" ]; then',
    '  setopt NO_EXTENDED_GLOB 2>/dev/null || true',
    'fi',
    `__wage_slave_cwd_file=${quotedCwdFile}`,
    '__wage_slave_write_cwd() {',
    '  pwd -P > "$__wage_slave_cwd_file" 2>/dev/null || true',
    '}',
    '__exit_code=0',
    '__wage_slave_command_finished=0',
    'trap \'__wage_slave_trap_status=$?; if [ "$__wage_slave_command_finished" -eq 0 ]; then __exit_code=$__wage_slave_trap_status; fi; __wage_slave_write_cwd; exit $__exit_code\' EXIT',
    command,
    '__exit_code=$?',
    '__wage_slave_command_finished=1',
    'exit $__exit_code',
  ].join('\n')
}

async function toolRunCommand(
  args: unknown,
  signal?: AbortSignal,
  projectCwd?: string
): Promise<{ output: string; updatedCwd?: string }> {
  const { command, work_dir, timeout_ms } = pickArgs<RunCommandArgs>(args, ['command'])

  // 安全分级：黑名单命令需用户确认，安全命令直接执行
  const check = checkCommand(command)

  // 命令工作目录：优先用工具参数 work_dir；否则回退到项目根 projectCwd
  const targetWorkDir = work_dir ? resolvePath(work_dir, projectCwd) : projectCwd
  if (targetWorkDir) {
    assertSafePath(targetWorkDir, projectCwd)
  }

  const timeout = clamp(timeout_ms ?? 30_000, 1_000, 120_000)

  if (!check.allowed) {
    // 命中黑名单：弹窗让用户确认，用户可放行或拒绝
    console.warn(`[Agent.tool] run_command 命中风险规则，需用户确认: ${command} | 原因: ${check.reason}`)
    const userAllowed = await confirmCommandWithUser({
      command,
      workDir: targetWorkDir,
      timeoutMs: timeout,
      reason: check.reason,
    })
    if (!userAllowed) {
      throw new Error(`用户拒绝执行命令: "${preview(command, 80)}"`)
    }
  } else {
    // 安全命令：直接执行，记录日志
    console.log(`[Agent.tool] run_command 安全命令直接执行: ${preview(command, 120)}`)
  }
  const cwd = targetWorkDir
  recordAgentAudit({
    tool: 'run_command',
    action: 'run_command',
    target: cwd ?? process.cwd(),
    summary: preview(command, 200),
  })

  // CWD 追踪：生成唯一的临时 CWD 文件路径
  const cwdFile = path.join(
    os.tmpdir(),
    `wage-slave-cwd-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  )

  // 封装原始命令，以追踪执行后的工作目录，同时向外透传原始 exit code
  const shellConf = await getShellConfig()
  const wrappedCommand = buildTrackedShellCommand(command, cwdFile, shellConf.isPowerShell)

  const result = await spawnShellCommand(wrappedCommand, { cwd, timeoutMs: timeout, maxBuffer: MAX_COMMAND_BUFFER }, signal, shellConf)
  const combined = decodeProcessOutput(result.output).trim()

  // 读取并更新工作目录
  let updatedCwd: string | undefined
  try {
    if (fsSync.existsSync(cwdFile)) {
      const readCwd = fsSync.readFileSync(cwdFile, 'utf-8').trim()
      if (readCwd) {
        updatedCwd = shellConf.isPowerShell ? path.resolve(readCwd) : readCwd.normalize('NFC')
        // 安全性二次校验：确保切换后的工作目录也在安全白名单内
        assertSafePath(updatedCwd, projectCwd)
      }
      fsSync.unlinkSync(cwdFile)
    }
  } catch (err) {
    console.warn(`[Agent.tool] CWD 追踪读取或验证失败:`, err)
    try {
      if (fsSync.existsSync(cwdFile)) fsSync.unlinkSync(cwdFile)
    } catch {}
  }

  if (result.timedOutDueToPrompt) {
    throw new Error(`命令疑似因等待交互式键盘输入而挂起。最后输出：\n${combined.slice(-500)}\n请终止该任务并搭配管道（如 \`echo y | 命令\`）或非交互参数重新运行。`)
  }
  if (result.timedOut) {
    throw new Error(`命令超时（${timeout}ms）：${combined || preview(command, 120)}`)
  }
  if (result.exceededBuffer) {
    throw new Error(`命令输出超过 ${MAX_COMMAND_BUFFER} bytes，已中止：${combined.slice(0, 2000)}`)
  }
  if (result.code !== 0) {
    const codeInfo = `（exitCode=${result.code ?? 'null'}${result.signal ? `, signal=${result.signal}` : ''}）`
    throw new Error(`命令失败${codeInfo}：${combined || preview(command, 120)}`)
  }

  return {
    output: combined || '(命令执行完成，无输出)',
    updatedCwd
  }
}

interface SpawnCommandOptions {
  cwd?: string
  timeoutMs: number
  maxBuffer: number
}

interface SpawnCommandResult {
  output: Buffer
  code: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
  exceededBuffer: boolean
  timedOutDueToPrompt: boolean
}

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
        log.warn(`[AgentTool] Windows taskkill 异步报错:`, err)
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

async function spawnShellCommand(
  command: string,
  options: SpawnCommandOptions,
  signal?: AbortSignal,
  shellConf?: ShellConfig,
): Promise<SpawnCommandResult> {
  const resolvedShellConf = shellConf ?? await getShellConfig()
  const shell = resolvedShellConf.shell
  const shellArgs = [...resolvedShellConf.argsPrefix, command]

  // I/O 直接落盘：创建临时输出文件，避免 V8 内存占用与阻塞
  const outputFilePath = path.join(
    os.tmpdir(),
    `wage-slave-out-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  )
  const outFd = fsSync.openSync(outputFilePath, 'w')

  return new Promise((resolve, reject) => {
    const child = spawn(shell, shellArgs, {
      cwd: options.cwd,
      detached: true,
      windowsHide: true,
      env: {
        ...process.env,
        WAGE_SLAVE: '1',
        ...(process.platform === 'win32' && {
          PYTHONIOENCODING: 'utf-8',
          PYTHONUTF8: '1',
        }),
      },
      stdio: ['ignore', outFd, outFd], // stdout/stderr 直接导向文件描述符
    })

    let timedOut = false
    let exceededBuffer = false
    let timedOutDueToPrompt = false
    let isFinished = false
    let lastGrowthTime = Date.now()
    let lastSize = 0

    const cleanUp = () => {
      isFinished = true
      clearTimeout(timer)
      clearInterval(watchdogInterval)
      if (signal && onAbort) {
        signal.removeEventListener('abort', onAbort)
      }
      try {
        fsSync.closeSync(outFd)
      } catch {}
    }

    const killForLimit = () => {
      exceededBuffer = true
      killProcess(child)
    }

    const timer = setTimeout(() => {
      timedOut = true
      killProcess(child)
    }, options.timeoutMs)

    // 交互式挂起看门狗提示符模式
    const PROMPT_PATTERNS = [
      /\(y\/n\)/i,
      /\[y\/n\]/i,
      /\(yes\/no\)/i,
      /\b(?:Do you|Would you|Shall I|Are you sure|Ready to)\b.*\? *$/i,
      /Press (any key|Enter)/i,
      /Continue\?/i,
      /Overwrite\?/i
    ]

    function looksLikePrompt(tail: string): boolean {
      const lastLine = tail.trimEnd().split('\n').pop() ?? ''
      return PROMPT_PATTERNS.some(p => p.test(lastLine))
    }

    const watchdogInterval = setInterval(() => {
      if (isFinished) return
      try {
        const stats = fsSync.statSync(outputFilePath)
        const currentSize = stats.size

        // 1. 容量看门狗
        if (currentSize > options.maxBuffer) {
          killForLimit()
          return
        }

        // 2. 挂起卡死看门狗
        if (currentSize === lastSize) {
          if (Date.now() - lastGrowthTime > 5000) {
            const readLen = Math.min(1024, currentSize)
            if (readLen > 0) {
              const fd = fsSync.openSync(outputFilePath, 'r')
              const buffer = Buffer.alloc(readLen)
              fsSync.readSync(fd, buffer, 0, readLen, currentSize - readLen)
              fsSync.closeSync(fd)

              const tail = decodeProcessOutput(buffer)
              if (looksLikePrompt(tail)) {
                timedOutDueToPrompt = true
                killProcess(child)
              }
            }
          }
        } else {
          lastSize = currentSize
          lastGrowthTime = Date.now()
        }
      } catch {}
    }, 2000)

    let onAbort: (() => void) | null = null
    if (signal) {
      if (signal.aborted) {
        cleanUp()
        killProcess(child)
        try {
          fsSync.unlinkSync(outputFilePath)
        } catch {}
        reject(new Error('Command aborted'))
        return
      }
      onAbort = () => {
        if (isFinished) return
        cleanUp()
        killProcess(child)
        try {
          fsSync.unlinkSync(outputFilePath)
        } catch {}
        reject(new Error('Command aborted'))
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }

    child.on('error', err => {
      if (isFinished) return
      cleanUp()
      try {
        fsSync.unlinkSync(outputFilePath)
      } catch {}
      reject(err)
    })

    child.on('close', (code, signalName) => {
      if (isFinished) return
      cleanUp()
      let output = Buffer.alloc(0)
      try {
        output = fsSync.readFileSync(outputFilePath)
        fsSync.unlinkSync(outputFilePath)
      } catch {}
      resolve({
        output,
        code,
        signal: signalName,
        timedOut,
        exceededBuffer,
        timedOutDueToPrompt,
      })
    })
  })
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
  recordAgentAudit({
    tool: 'save_todo',
    action: 'create_todo',
    target: today,
    summary: `${newTodo.title} (${newTodo.priority})`,
  })
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
  recordAgentAudit({
    tool: 'update_todo',
    action: 'update_todo',
    target: id,
    summary: diffSummary(before, todos[idx]),
  })

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
  recordAgentAudit({
    tool: 'append_log',
    action: 'append_log',
    target: today,
    summary: `追加 ${content.length} 字符到 ${append_to}`,
  })
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

/** 格式化秒数为易读的时分秒格式 */
function formatDelaySeconds(seconds: number): string {
  if (seconds < 60) {
    return `${seconds}秒后执行一次`
  }
  if (seconds < 3600) {
    const mins = Math.floor(seconds / 60)
    const secs = seconds % 60
    return secs === 0 ? `${mins}分钟后执行一次` : `${mins}分${secs}秒后执行一次`
  }
  const hrs = Math.floor(seconds / 3600)
  const mins = Math.floor((seconds % 3600) / 60)
  const secs = seconds % 60
  if (mins === 0 && secs === 0) return `${hrs}小时后执行一次`
  if (secs === 0) return `${hrs}时${mins}分后执行一次`
  return `${hrs}时${mins}分${secs}秒后执行一次`
}

/** 把 TaskSchedule 渲染成人话给 LLM 看 */
function formatScheduleStr(s: TaskSchedule): string {
  if (s.type === 'interval') return `每 ${s.intervalMinutes ?? 60} 分钟`
  if (s.type === 'daily') return `每日 ${s.time ?? '09:00'}`
  if (s.type === 'weekly') {
    const wd = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
    return `每${wd[s.weekDay ?? 1]} ${s.time ?? '09:00'}`
  }
  if (s.type === 'once') {
    const date = s.executeAt ? new Date(s.executeAt) : null
    return date && !isNaN(date.getTime())
      ? `一次性任务 ${date.toLocaleString('zh-CN')}`
      : `一次性任务 ${s.executeAt ?? '未指定时间'}`
  }
  if (s.type === 'delay') {
    return formatDelaySeconds(s.delaySeconds ?? 0)
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
  schedule_type: 'interval' | 'daily' | 'weekly' | 'once' | 'delay'
  interval_minutes?: number
  time?: string
  week_day?: number
  execute_at?: string
  delay_seconds?: number
  enabled?: boolean
}

/** 校验并构造 TaskSchedule，参数缺失时给 LLM 明确的错误提示 */
function buildScheduleFromArgs(
  type: 'interval' | 'daily' | 'weekly' | 'once' | 'delay',
  args: {
    interval_minutes?: number
    time?: string
    week_day?: number
    execute_at?: string
    delay_seconds?: number
  },
): TaskSchedule {
  if (type === 'interval') {
    const mins = args.interval_minutes
    if (typeof mins !== 'number' || mins < 1 || mins > 1440) {
      throw new Error('schedule_type=interval 时必须提供 1-1440 范围内的 interval_minutes')
    }
    return { type: 'interval', intervalMinutes: Math.floor(mins) }
  }

  if (type === 'once') {
    const executeAt = (args.execute_at ?? '').trim()
    if (!executeAt) {
      throw new Error('schedule_type=once 时必须提供 execute_at（ISO8601 格式日期时间，如 2026-06-15T14:30:00）')
    }
    const date = new Date(executeAt)
    if (isNaN(date.getTime())) {
      throw new Error(`execute_at 格式不正确：${executeAt}，请使用 ISO8601 格式，如 2026-06-15T14:30:00`)
    }
    return { type: 'once', executeAt }
  }

  if (type === 'delay') {
    const secs = args.delay_seconds
    if (typeof secs !== 'number' || secs < 1) {
      throw new Error('schedule_type=delay 时必须提供 delay_seconds（>=1 的秒数）')
    }
    // 计算实际执行时间（当前时间 + delay_seconds）
    const executeAt = new Date(Date.now() + secs * 1000).toISOString()
    return { type: 'delay', delaySeconds: Math.floor(secs), executeAt }
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
  recordAgentAudit({
    tool: 'scheduler_create_task',
    action: 'create_task',
    target: task.id,
    summary: `${task.name} (${task.kind ?? 'shell'}, ${formatScheduleStr(task.schedule)})`,
  })
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
  schedule_type?: 'interval' | 'daily' | 'weekly' | 'once' | 'delay'
  interval_minutes?: number
  time?: string
  week_day?: number
  execute_at?: string
  delay_seconds?: number
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
    if (a.execute_at !== undefined && s.type === 'once') s.executeAt = a.execute_at
    // delay 类型不支持局部更新 executeAt（需要重新计算），所以如果要改 delay_seconds，必须同时传 schedule_type
    merged.schedule = s
  }

  const updated = saveTask(merged)
  recordAgentAudit({
    tool: 'scheduler_update_task',
    action: 'update_task',
    target: updated.id,
    summary: `${updated.name} (${formatScheduleStr(updated.schedule)}, ${updated.enabled ? 'enabled' : 'disabled'})`,
  })
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
  recordAgentAudit({
    tool: 'scheduler_delete_task',
    action: 'delete_task',
    target: id,
    summary: target.name,
  })
  log.info(`[AgentTool] scheduler_delete_task: id=${id} name="${target.name}"`)
  return `🗑 已删除定时任务：${target.name} (id=${id})`
}

async function toolSchedulerToggleTask(args: unknown): Promise<string> {
  const { id } = pickArgs<SchedulerIdArg>(args, ['id'])
  const { toggleTask } = await loadScheduler()
  const task = toggleTask(id)
  if (!task) throw new Error(`定时任务不存在: ${id}`)
  recordAgentAudit({
    tool: 'scheduler_toggle_task',
    action: 'toggle_task',
    target: task.id,
    summary: `${task.name} -> ${task.enabled ? 'enabled' : 'disabled'}`,
  })
  log.info(`[AgentTool] scheduler_toggle_task: id=${task.id} enabled=${task.enabled}`)
  return `${task.enabled ? '▶ 已启用' : '⏸ 已禁用'} 定时任务：${task.name} (id=${task.id})`
}

// ═══════════════════════════════════════════════════════════════
// 系统操作工具
// ═══════════════════════════════════════════════════════════════

interface OpenFileArgs { path: string }

async function toolOpenFile(args: unknown, cwd?: string): Promise<string> {
  const { path: p } = pickArgs<OpenFileArgs>(args, ['path'])
  const target = resolvePath(p, cwd)
  assertSafePath(target, cwd)
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

async function readFileLines(
  filePath: string,
  offset: number,
  maxLines: number,
): Promise<{ lines: string[]; truncated: boolean }> {
  const stream = fsSync.createReadStream(filePath, { encoding: 'utf-8' })
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })
  const lines: string[] = []
  let lineNo = 0
  let truncated = false

  try {
    for await (const line of rl) {
      if (lineNo < offset) {
        lineNo++
        continue
      }
      if (lines.length >= maxLines) {
        truncated = true
        break
      }
      lines.push(line)
      lineNo++
    }
  } finally {
    rl.close()
    stream.destroy()
  }

  return { lines, truncated }
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

// ── 技能管理工具 ──────────────────────────────

async function toolSkillList(): Promise<string> {
  const skills = getAllSkills()
  const lines = skills.map(s => {
    const status = s.enabled ? '✓' : '✗'
    const scope = s.scope === 'builtin' ? '内置' : s.scope === 'user' ? '用户' : '远程'
    return `[${status}] ${s.name} (id=${s.id}, ${scope}, ${s.category})`
  })
  return `共 ${skills.length} 个技能:\n${lines.join('\n')}`
}

async function toolSkillGet(args: { id: string }): Promise<string> {
  const skill = getSkillById(args.id)
  if (!skill) {
    throw new Error(`技能不存在: ${args.id}`)
  }
  return JSON.stringify(skill, null, 2)
}

async function toolSkillInstall(args: { skill_json: string }): Promise<string> {
  let skill: AgentSkill
  try {
    skill = JSON.parse(args.skill_json) as AgentSkill
  } catch {
    throw new Error('技能 JSON 解析失败')
  }

  if (!validateSkill(skill)) {
    throw new Error('技能格式非法：缺少 id/name/description/systemPromptAddition/triggers 等必要字段')
  }

  // 确保 scope 是 user
  skill.scope = 'user'

  const result = saveUserSkill(skill, 'user')
  return `技能 "${result.name}" (id=${result.id}) 安装成功，已启用`
}

async function toolSkillUpdate(args: { skill_json: string }): Promise<string> {
  let skill: AgentSkill
  try {
    skill = JSON.parse(args.skill_json) as AgentSkill
  } catch {
    throw new Error('技能 JSON 解析失败')
  }

  if (!skill.id) {
    throw new Error('技能 JSON 缺少 id 字段')
  }

  // 检查技能是否存在且不是内置技能
  const existing = getSkillById(skill.id)
  if (!existing) {
    throw new Error(`技能不存在: ${skill.id}，请使用 skill_install 安装新技能`)
  }
  if (existing.scope === 'builtin') {
    throw new Error(`内置技能 "${skill.id}" 无法修改，只能禁用/启用`)
  }

  // 合并现有技能的状态
  skill.scope = existing.scope

  // 保存更新后的技能（saveUserSkill 会覆盖同 id 的技能）
  const result = saveUserSkill(skill, existing.scope)
  return `技能 "${result.name}" (id=${result.id}) 更新成功`
}

async function toolSkillToggle(args: { id: string; enabled: boolean }): Promise<string> {
  const result = toggleSkill(args.id, args.enabled)
  if (!result) {
    throw new Error(`技能不存在: ${args.id}`)
  }
  return `技能 "${result.name}" 已${result.enabled ? '启用' : '禁用'}`
}

async function toolSkillDelete(args: { id: string }): Promise<string> {
  const skill = getSkillById(args.id)
  if (!skill) {
    throw new Error(`技能不存在: ${args.id}`)
  }
  if (skill.scope === 'builtin') {
    throw new Error(`内置技能 "${args.id}" 无法删除，只能禁用`)
  }

  const success = deleteUserSkill(args.id)
  if (!success) {
    throw new Error(`删除技能 "${args.id}" 失败`)
  }
  return `技能 "${skill.name}" (id=${args.id}) 已删除`
}

function diffSummary(before: TodoItem, after: TodoItem): string {
  const parts: string[] = []
  if (before.status !== after.status) parts.push(`status ${before.status}→${after.status}`)
  if (before.priority !== after.priority) parts.push(`priority ${before.priority}→${after.priority}`)
  if (before.title !== after.title) parts.push(`title 已修改`)
  return parts.join(', ') || '无变化'
}

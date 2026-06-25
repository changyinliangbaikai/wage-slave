/**
 * 代码搜索工具实现：grep_code（基于 ripgrep / Node 回退）与 glob_files（基于 glob v11）
 *
 * 设计要点：
 *  1. grep_code 优先使用系统安装的 ripgrep；未安装时降级到 Node 实现，保证跨平台可用
 *  2. glob_files 使用 glob v11 的 Promise API，支持完整 ** / 大括号展开等高级语法
 *  3. 所有路径输入都强制通过 assertSafePath 校验，防止访问白名单外的目录
 *  4. 自动排除 .git / node_modules / dist / build / .next 等噪音目录，加速搜索
 *  5. 输出按 "文件:行号:内容" 风格统一，方便 LLM 二次定位
 *
 * 与 Claude Code 的差异：
 *  - 简化输出模式为 "content" 一种；files_with_matches 由 grep_code(head_only=true) 表达
 *  - 不实现多线程重试 / 缓冲区精细分块；这些是 Claude Code 在大型 monorepo 才需要的优化
 *  - 不引入插件缓存排除（小牛马面向单仓库桌面场景）
 */

import { spawn } from 'child_process'
import * as fs from 'fs/promises'
import * as fsSync from 'fs'
import * as path from 'path'
import { glob } from 'glob'
import log from 'electron-log/main'
import { assertSafePath, expandHome } from './security'

/** 噪音目录列表（递归遍历时跳过，减少误命中） */
const NOISY_DIRECTORIES = [
  '.git', '.svn', '.hg',
  'node_modules',
  'dist', 'build', 'out', 'target',
  '.next', '.nuxt', '.svelte-kit',
  'coverage', '.nyc_output',
  '.venv', 'venv', '__pycache__',
  '.cache', '.parcel-cache', '.turbo',
] as const

/** ripgrep 二进制是否存在的缓存（避免每次都 spawn 一次） */
let cachedRipgrepStatus: boolean | null = null

/** 检测系统是否安装了 ripgrep（结果会缓存到进程退出） */
export async function isRipgrepAvailable(): Promise<boolean> {
  if (cachedRipgrepStatus !== null) return cachedRipgrepStatus
  cachedRipgrepStatus = await new Promise<boolean>(resolve => {
    const child = spawn('rg', ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] })
    let resolved = false
    const done = (ok: boolean) => {
      if (!resolved) {
        resolved = true
        resolve(ok)
      }
    }
    child.on('error', () => done(false))
    child.on('exit', code => done(code === 0))
    // 超时保护：3 秒还没结果就当作没装
    setTimeout(() => {
      if (!resolved) {
        try { child.kill() } catch { /* ignore */ }
        done(false)
      }
    }, 3000)
  })
  log.info(`[CodeSearch] ripgrep 可用性检测: ${cachedRipgrepStatus ? '✓ 已安装' : '✗ 未安装，使用 Node 回退'}`)
  return cachedRipgrepStatus
}

// ═══════════════════════════════════════════════════════════════
// grep_code：在代码中搜索文本（正则）
// ═══════════════════════════════════════════════════════════════

export interface GrepCodeArgs {
  pattern: string
  path?: string
  include?: string
  context_lines?: number
  case_insensitive?: boolean
  max_results?: number
  output_mode?: 'content' | 'files_with_matches' | 'count'
}

/** 单次 grep_code 默认超时（ms） */
const GREP_TIMEOUT_MS = 30_000

/**
 * grep_code 工具入口
 * 先尝试 ripgrep，失败/不可用则回退到 Node 实现
 */
export async function grepCode(args: GrepCodeArgs): Promise<string> {
  if (!args.pattern || typeof args.pattern !== 'string') {
    throw new Error('pattern 不能为空')
  }
  const searchRoot = expandHome(args.path || process.cwd())
  assertSafePath(searchRoot)
  // 校验正则合法性，避免把非法正则交给 ripgrep
  try {
    new RegExp(args.pattern)
  } catch (e) {
    throw new Error(`正则表达式非法: ${(e as Error).message}`)
  }

  const maxResults = clamp(args.max_results ?? 50, 1, 500)
  const contextLines = clamp(args.context_lines ?? 0, 0, 10)
  const outputMode = args.output_mode ?? 'content'

  if (await isRipgrepAvailable()) {
    try {
      return await grepWithRipgrep({ ...args, path: searchRoot }, { maxResults, contextLines, outputMode })
    } catch (e) {
      log.warn(`[CodeSearch] ripgrep 调用失败，回退 Node 实现: ${(e as Error).message}`)
    }
  }
  return await grepWithNode({ ...args, path: searchRoot }, { maxResults, contextLines, outputMode })
}

interface NormalizedGrepOptions {
  maxResults: number
  contextLines: number
  outputMode: 'content' | 'files_with_matches' | 'count'
}

/** ripgrep 调用层 */
async function grepWithRipgrep(
  args: GrepCodeArgs,
  options: NormalizedGrepOptions,
): Promise<string> {
  const rgArgs: string[] = []

  // 基础参数
  rgArgs.push('--hidden')                            // 搜索隐藏文件，但通过 ignore 规则跳过 .git 等
  rgArgs.push('--max-columns', '500')                // 限制单行最大列数，防止 base64/minified 内容污染输出
  rgArgs.push('--max-count', String(options.maxResults))
  rgArgs.push('--no-heading')                        // 行内显示文件路径，便于 LLM 解析
  rgArgs.push('--color', 'never')                    // 关闭 ANSI 着色

  // 大小写不敏感
  if (args.case_insensitive) rgArgs.push('-i')

  // 输出模式
  if (options.outputMode === 'files_with_matches') {
    rgArgs.push('-l')
  } else if (options.outputMode === 'count') {
    rgArgs.push('-c')
  } else {
    // content 模式：显示行号
    rgArgs.push('-n')
    if (options.contextLines > 0) {
      rgArgs.push('-C', String(options.contextLines))
    }
  }

  // include 过滤（glob 模式）
  if (args.include) {
    rgArgs.push('--glob', args.include)
  }

  // 噪音目录排除
  for (const dir of NOISY_DIRECTORIES) {
    rgArgs.push('--glob', `!**/${dir}/**`)
  }

  // 模式参数（处理以 - 开头的模式，避免被 rg 当成选项解析）
  if (args.pattern.startsWith('-')) {
    rgArgs.push('-e', args.pattern)
  } else {
    rgArgs.push(args.pattern)
  }

  // 搜索路径放最后
  rgArgs.push(args.path!)

  log.info(`[CodeSearch] 调用 ripgrep: rg ${rgArgs.slice(0, 10).map(a => a.length > 30 ? a.slice(0, 30) + '…' : a).join(' ')}…`)

  return await new Promise<string>((resolve, reject) => {
    // 注意：使用命令名 'rg' 而非绝对路径，避免 PATH 劫持风险
    const child = spawn('rg', rgArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })

    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let timedOut = false
    let outputBytes = 0
    const MAX_OUTPUT = 4 * 1024 * 1024  // 4MB

    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGTERM') } catch { /* ignore */ }
      // 5 秒还没退出则升级到 SIGKILL（参考 Claude Code 实现）
      setTimeout(() => { try { child.kill('SIGKILL') } catch { /* ignore */ } }, 5000)
    }, GREP_TIMEOUT_MS)

    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length
      if (outputBytes > MAX_OUTPUT) {
        try { child.kill('SIGTERM') } catch { /* ignore */ }
        return
      }
      stdoutChunks.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk))

    child.on('error', err => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', code => {
      clearTimeout(timer)
      const stdout = Buffer.concat(stdoutChunks).toString('utf-8')
      const stderr = Buffer.concat(stderrChunks).toString('utf-8')
      if (timedOut) {
        return reject(new Error(`ripgrep 搜索超时（${GREP_TIMEOUT_MS / 1000}s），尝试更精确的 pattern 或更小的搜索范围`))
      }
      // ripgrep 退出码：0=有匹配，1=无匹配，2+=错误
      if (code === 1) {
        return resolve(formatGrepEmpty(args, options))
      }
      if (code !== 0) {
        return reject(new Error(`ripgrep 失败（exitCode=${code}）：${stderr.slice(0, 500)}`))
      }
      resolve(formatRipgrepOutput(stdout, args, options))
    })
  })
}

/** 格式化 ripgrep 的 stdout 输出 */
function formatRipgrepOutput(
  stdout: string,
  args: GrepCodeArgs,
  options: NormalizedGrepOptions,
): string {
  const lines = stdout.split('\n').filter(Boolean)
  if (lines.length === 0) return formatGrepEmpty(args, options)

  const header = formatGrepHeader(args, options, lines.length)
  if (options.outputMode === 'files_with_matches') {
    // ripgrep -l 输出每行一个文件路径
    return [header, ...lines.slice(0, options.maxResults)].join('\n')
  }
  if (options.outputMode === 'count') {
    // ripgrep -c 输出 "file:count"
    return [header, ...lines.slice(0, options.maxResults)].join('\n')
  }
  // content 模式：rg -n 输出格式 "file:line:content"（context 行用 "file-line-content"）
  return [header, ...lines.slice(0, options.maxResults * (options.contextLines * 2 + 1))].join('\n')
}

function formatGrepHeader(args: GrepCodeArgs, options: NormalizedGrepOptions, hitCount: number): string {
  const parts = [
    `[grep_code: ${args.pattern}`,
    `路径: ${args.path}`,
    args.include ? `过滤: ${args.include}` : '',
    `模式: ${options.outputMode}`,
  ].filter(Boolean)
  return `${parts.join(', ')}] 命中 ${hitCount} 行（上限 ${options.maxResults}）`
}

function formatGrepEmpty(args: GrepCodeArgs, _options: NormalizedGrepOptions): string {
  return `[grep_code: ${args.pattern}, 路径: ${args.path}] 未命中任何文件`
}

/** Node.js 纯实现的 grep 回退 */
async function grepWithNode(
  args: GrepCodeArgs,
  options: NormalizedGrepOptions,
): Promise<string> {
  const flags = args.case_insensitive ? 'gi' : 'g'
  const regex = new RegExp(args.pattern, flags)
  const includeRegex = args.include ? globToFileRegex(args.include) : null

  interface Hit {
    file: string
    line: number
    text: string
    context?: string[]   // 上下文行（前后各 contextLines 行）
  }
  const hits: Hit[] = []
  const fileHits = new Map<string, number>()
  const startTime = Date.now()

  await walkSourceTree(args.path!, async (filePath, name) => {
    if (hits.length >= options.maxResults) return false
    if (Date.now() - startTime > GREP_TIMEOUT_MS) return false
    if (includeRegex && !includeRegex.test(name)) return true

    try {
      const stat = await fs.stat(filePath)
      if (stat.size > 2 * 1024 * 1024) return true   // 2MB 以上的文件跳过
      const buf = await fs.readFile(filePath)
      // 简单二进制检测：前 512 字节含 NUL 就当二进制
      if (buf.subarray(0, 512).includes(0)) return true
      const text = buf.toString('utf-8')
      const lines = text.split('\n')

      for (let i = 0; i < lines.length; i++) {
        // reset lastIndex 避免 global 标志带来的状态污染
        regex.lastIndex = 0
        if (regex.test(lines[i])) {
          if (options.outputMode === 'files_with_matches') {
            hits.push({ file: filePath, line: i + 1, text: lines[i].slice(0, 200) })
            break  // 一个文件命中一次就够
          }
          fileHits.set(filePath, (fileHits.get(filePath) ?? 0) + 1)
          if (options.outputMode === 'content') {
            const before = options.contextLines > 0
              ? lines.slice(Math.max(0, i - options.contextLines), i)
              : []
            const after = options.contextLines > 0
              ? lines.slice(i + 1, i + 1 + options.contextLines)
              : []
            const context = options.contextLines > 0 ? [...before, ...after] : undefined
            hits.push({ file: filePath, line: i + 1, text: lines[i].slice(0, 500), context })
          }
          if (hits.length >= options.maxResults) return false
        }
      }
    } catch {
      // 二进制 / 权限错误等忽略
    }
    return true
  })

  if (hits.length === 0) return formatGrepEmpty(args, options)

  const header = formatGrepHeader(args, options, hits.length)

  if (options.outputMode === 'files_with_matches') {
    return [header, ...Array.from(new Set(hits.map(h => h.file)))].join('\n')
  }
  if (options.outputMode === 'count') {
    return [header, ...Array.from(fileHits.entries()).map(([f, c]) => `${f}:${c}`)].join('\n')
  }
  // content 模式：file:line:content + 上下文（用 file-line-content 标记上下文）
  const lines: string[] = [header]
  for (const h of hits) {
    if (h.context && h.context.length > 0) {
      // 简化处理：上下文与匹配行一起渲染，匹配行用 "file:line" 分隔符
      const indent = '    '
      lines.push(`${h.file}:${h.line}:${h.text}`)
      for (const ctx of h.context) {
        lines.push(`${indent}${ctx.slice(0, 200)}`)
      }
    } else {
      lines.push(`${h.file}:${h.line}:${h.text}`)
    }
  }
  return lines.join('\n')
}

// ═══════════════════════════════════════════════════════════════
// glob_files：按模式查找文件
// ═══════════════════════════════════════════════════════════════

export interface GlobFilesArgs {
  pattern: string
  path?: string
  max_results?: number
}

const GLOB_MAX_RESULTS_DEFAULT = 100
const GLOB_MAX_RESULTS_UPPER = 500
const GLOB_TIMEOUT_MS = 20_000

export async function globFiles(args: GlobFilesArgs): Promise<string> {
  if (!args.pattern || typeof args.pattern !== 'string') {
    throw new Error('pattern 不能为空')
  }
  const searchRoot = expandHome(args.path || process.cwd())
  assertSafePath(searchRoot)
  const maxResults = clamp(args.max_results ?? GLOB_MAX_RESULTS_DEFAULT, 1, GLOB_MAX_RESULTS_UPPER)

  // 检查路径是否存在
  try {
    const stat = await fs.stat(searchRoot)
    if (!stat.isDirectory()) {
      throw new Error(`搜索路径不是目录: ${searchRoot}`)
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`搜索路径不存在: ${searchRoot}`)
    }
    throw e
  }

  const startTime = Date.now()
  // glob v11 是 Promise 接口；nodir:true 只返回文件
  const files = await runWithTimeout(
    glob(args.pattern, {
      cwd: searchRoot,
      nodir: true,
      absolute: false,
      // 排除噪音目录（glob 的 ignore 接受 glob 数组）
      ignore: NOISY_DIRECTORIES.map(d => `**/${d}/**`),
      dot: false,  // 默认不匹配以 . 开头的文件（用户用 .env 这种需显式指定）
    }),
    GLOB_TIMEOUT_MS,
    () => new Error(`glob_files 搜索超时（${GLOB_TIMEOUT_MS / 1000}s），尝试更精确的 pattern`),
  )

  const elapsed = Date.now() - startTime
  if (files.length === 0) {
    return `[glob_files: ${args.pattern}, 路径: ${searchRoot}] 未找到任何文件（耗时 ${elapsed}ms）`
  }

  // 按文件路径排序，保证输出稳定
  files.sort()
  const truncated = files.length > maxResults
  const shown = truncated ? files.slice(0, maxResults) : files

  const header = `[glob_files: ${args.pattern}, 路径: ${searchRoot}] 找到 ${files.length} 个文件（耗时 ${elapsed}ms${truncated ? `，已截断到 ${maxResults}` : ''}）`
  const footer = truncated
    ? `\n...还有 ${files.length - maxResults} 个文件未显示，请使用更精确的 pattern`
    : ''
  return [header, ...shown, footer].filter(Boolean).join('\n')
}

// ═══════════════════════════════════════════════════════════════
// 工具函数
// ═══════════════════════════════════════════════════════════════

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n))
}

/** 把简单 glob（如 "*.ts"）转成文件名匹配的 RegExp（不支持 **，仅用于 grep 回退） */
function globToFileRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^$(){}|]/g, '\\$&')
    .replace(/\*\*/g, '.*')           // ** 匹配任意（含 /）
    .replace(/\*/g, '[^/]*')          // * 不跨目录
    .replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`, 'i')
}

/** 递归遍历源码目录，跳过噪音目录 */
async function walkSourceTree(
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
    if (entry.isDirectory()) {
      if (NOISY_DIRECTORIES.includes(entry.name as typeof NOISY_DIRECTORIES[number])) continue
      await walkSourceTree(path.join(dir, entry.name), visit)
    } else if (entry.isFile()) {
      const cont = await visit(path.join(dir, entry.name), entry.name)
      if (cont === false) return
    }
  }
}

/** 给 Promise 加上超时保护 */
function runWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  makeError: () => Error,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        reject(makeError())
      }
    }, timeoutMs)
    promise.then(
      v => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          resolve(v)
        }
      },
      e => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          reject(e)
        }
      },
    )
  })
}



/**
 * Git 专用工具实现：git_status / git_diff / git_log
 *
 * 设计动机：让 Agent 在编程任务中能直接查看 git 状态而无需经过 run_command 的二次确认弹窗。
 * 这些都是只读操作，安全风险低，使用频率高。
 *
 * 安全约束：
 *  - 不暴露任何写操作（commit/push/reset 仍走 run_command 走二次确认）
 *  - work_dir 必须在路径白名单内
 *  - 单条命令超时 15 秒（diff 全量可能较大）
 *  - 输出最大 64KB，超出截断
 */

import { spawn } from 'child_process'
import log from 'electron-log/main'
import { assertSafePath, expandHome } from './security'

const GIT_TOOL_TIMEOUT_MS = 15_000
const GIT_OUTPUT_MAX_BYTES = 64 * 1024  // 64KB

export interface GitStatusArgs {
  work_dir?: string
}

export async function gitStatus(args: GitStatusArgs): Promise<string> {
  const cwd = resolveCwd(args.work_dir)
  const stdout = await runGit(cwd, ['status', '--short', '--branch'])
  if (!stdout.trim()) return `[git_status @ ${cwd}] 工作区干净（无未提交变更）`
  return `[git_status @ ${cwd}]\n${stdout}`
}

export interface GitDiffArgs {
  work_dir?: string
  /** 指定路径过滤；默认全部 */
  paths?: string[]
  /** 是否包含已暂存（--cached），默认 false 显示未暂存的修改 */
  cached?: boolean
  /** 仅显示文件名列表（--name-only）；默认 false 显示完整 diff */
  name_only?: boolean
  /** 与某个提交比较，如 HEAD~1、main */
  ref?: string
}

export async function gitDiff(args: GitDiffArgs): Promise<string> {
  const cwd = resolveCwd(args.work_dir)
  const gitArgs = ['diff', '--no-color']
  if (args.cached) gitArgs.push('--cached')
  if (args.name_only) gitArgs.push('--name-only')
  if (args.ref) gitArgs.push(args.ref)
  if (args.paths && args.paths.length > 0) {
    gitArgs.push('--', ...args.paths)
  }
  const stdout = await runGit(cwd, gitArgs)
  if (!stdout.trim()) {
    return `[git_diff @ ${cwd}${args.cached ? ' --cached' : ''}] 无差异`
  }
  return `[git_diff @ ${cwd}${args.cached ? ' --cached' : ''}]\n${stdout}`
}

export interface GitLogArgs {
  work_dir?: string
  /** 显示多少条提交，默认 10，最大 50 */
  limit?: number
  /** 仅显示某文件的提交历史 */
  file?: string
  /** 是否包含改动统计（--stat），默认 false */
  with_stat?: boolean
  /** 显示某个分支/ref 的日志 */
  ref?: string
}

export async function gitLog(args: GitLogArgs): Promise<string> {
  const cwd = resolveCwd(args.work_dir)
  const limit = clamp(args.limit ?? 10, 1, 50)
  const gitArgs = ['log', `-n`, String(limit), '--no-color', '--pretty=format:%h %ad %an  %s', '--date=short']
  if (args.with_stat) gitArgs.push('--stat')
  if (args.ref) gitArgs.push(args.ref)
  if (args.file) {
    gitArgs.push('--', args.file)
  }
  const stdout = await runGit(cwd, gitArgs)
  if (!stdout.trim()) return `[git_log @ ${cwd}] 没有提交记录`
  return `[git_log @ ${cwd}，最近 ${limit} 条]\n${stdout}`
}

// ── 工具函数 ────────────────────────────────────────────────

function resolveCwd(workDir: string | undefined): string {
  const cwd = workDir ? expandHome(workDir) : process.cwd()
  // 即使是只读命令，也要保证 cwd 在白名单内，防止泄露白名单外的代码
  assertSafePath(cwd)
  return cwd
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n))
}

/** 安全地运行 git 命令并返回 stdout，超时/失败时抛出有信息的错误 */
async function runGit(cwd: string, args: string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
    })
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let outputBytes = 0
    let truncated = false
    let settled = false

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        try { child.kill('SIGTERM') } catch { /* ignore */ }
        reject(new Error(`git ${args[0]} 超时（${GIT_TOOL_TIMEOUT_MS / 1000}s）`))
      }
    }, GIT_TOOL_TIMEOUT_MS)

    child.stdout.on('data', (chunk: Buffer) => {
      if (outputBytes + chunk.length > GIT_OUTPUT_MAX_BYTES && !truncated) {
        truncated = true
        const remaining = GIT_OUTPUT_MAX_BYTES - outputBytes
        if (remaining > 0) stdoutChunks.push(chunk.subarray(0, remaining))
        outputBytes = GIT_OUTPUT_MAX_BYTES
        try { child.kill('SIGTERM') } catch { /* ignore */ }
        return
      }
      stdoutChunks.push(chunk)
      outputBytes += chunk.length
    })
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk))

    child.on('error', err => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(new Error('未找到 git 命令，请确认系统已安装 Git'))
        } else {
          reject(err)
        }
      }
    })
    child.on('close', code => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const stdout = Buffer.concat(stdoutChunks).toString('utf-8')
      const stderr = Buffer.concat(stderrChunks).toString('utf-8')
      if (code !== 0 && !truncated) {
        const msg = stderr.trim() || `exit code ${code}`
        log.warn(`[GitTool] git ${args.join(' ')} 失败: ${msg}`)
        return reject(new Error(`git ${args[0]} 失败：${msg.slice(0, 500)}`))
      }
      const footer = truncated ? `\n...[输出超过 ${GIT_OUTPUT_MAX_BYTES / 1024}KB 已截断，请使用更具体的参数缩小范围]` : ''
      resolve(stdout + footer)
    })
  })
}

/**
 * Git 上下文收集器
 *
 * 在每次构建动态上下文时自动执行：当前分支、主分支、status、最近提交、用户名
 * 帮助 LLM 一开始就理解项目所处的 Git 状态（待提交修改、近期变更、所在分支等）
 *
 * 设计原则：
 *  1. 任何 git 调用失败 → 静默降级（不让 git 报错阻塞 Agent）
 *  2. 单条命令超时 5 秒（大仓库的 git status 可能很慢）
 *  3. 多个 git 命令并行执行
 *  4. 结果尺寸严格控制（避免占用过多 Prompt 空间）
 */

import { spawn } from 'child_process'
import * as fs from 'fs/promises'
import * as path from 'path'
import log from 'electron-log/main'

const GIT_CMD_TIMEOUT_MS = 5_000

/** Git 上下文快照 */
export interface GitContext {
  isGitRepo: boolean
  branch?: string          // 当前分支名
  mainBranch?: string      // 主分支（main / master）
  userName?: string        // git config user.name
  /** git status --short 输出，截断到 2000 字 */
  statusShort?: string
  /** 最近 5 条 git log，每行一条 */
  recentCommits?: string
}

/**
 * 收集 Git 上下文
 * 任何 git 命令失败都不抛错，而是返回 isGitRepo:false 让上层降级处理
 */
export async function collectGitContext(cwd: string): Promise<GitContext> {
  // 先检查目录是否为 git 仓库（通过 .git 目录的存在性快速判断，避免无谓 git 调用）
  const isRepo = await isGitRepo(cwd)
  if (!isRepo) {
    return { isGitRepo: false }
  }

  // 并行执行 5 个 git 命令（参考 Claude Code context.ts 的实现）
  const [branch, mainBranch, statusShort, recentCommits, userName] = await Promise.all([
    runGitCommand(cwd, ['branch', '--show-current']),
    detectMainBranch(cwd),
    runGitCommand(cwd, ['status', '--short']),
    runGitCommand(cwd, ['log', '--oneline', '-n', '5']),
    runGitCommand(cwd, ['config', 'user.name']),
  ])

  // 截断 status 输出，避免污染 prompt
  const truncatedStatus = statusShort.length > 2000
    ? statusShort.slice(0, 2000) + '\n...[已截断，建议运行 git status 查看完整]'
    : statusShort

  return {
    isGitRepo: true,
    branch: branch || undefined,
    mainBranch: mainBranch || undefined,
    userName: userName || undefined,
    statusShort: truncatedStatus || undefined,
    recentCommits: recentCommits || undefined,
  }
}

/** 检测目录是否在 git 仓库内（递归向上查找 .git） */
async function isGitRepo(cwd: string): Promise<boolean> {
  let current = path.resolve(cwd)
  const root = path.parse(current).root
  // 最多向上查找 20 层，避免病态路径
  for (let i = 0; i < 20 && current !== root; i++) {
    try {
      const gitPath = path.join(current, '.git')
      const stat = await fs.stat(gitPath)
      if (stat.isDirectory() || stat.isFile()) return true   // .git 可能是文件（git worktree 情况）
    } catch {
      // ENOENT 继续向上
    }
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return false
}

/** 推断主分支：先看 origin/HEAD，再回退到 main/master */
async function detectMainBranch(cwd: string): Promise<string> {
  // 1. 通过 origin/HEAD 推断（最准确）
  const symref = await runGitCommand(cwd, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  if (symref) {
    // 输出形如 "origin/main"，取后半段
    const parts = symref.split('/')
    if (parts.length >= 2) return parts.slice(1).join('/')
  }

  // 2. 检测本地有 main / master 哪个
  for (const candidate of ['main', 'master']) {
    const exists = await runGitCommand(cwd, ['show-ref', '--quiet', '--heads', candidate], { allowNonZeroExit: true })
    if (exists !== null) return candidate
  }
  return 'main'   // 兜底默认
}

interface GitCommandOptions {
  /** 允许命令以非 0 退出（如 show-ref 失败时不算错误），返回空字符串而非 null */
  allowNonZeroExit?: boolean
}

/**
 * 安全地执行 git 命令并返回 stdout
 * 失败时返回空字符串（不抛错），调用方据此降级
 */
async function runGitCommand(
  cwd: string,
  args: string[],
  options: GitCommandOptions = {},
): Promise<string> {
  return new Promise<string>(resolve => {
    const child = spawn('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      // 防止 git 弹密码框等交互
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
    })
    let stdout = ''
    let stderr = ''
    let settled = false

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        try { child.kill('SIGTERM') } catch { /* ignore */ }
        log.warn(`[GitContext] git ${args.join(' ')} 超时 ${GIT_CMD_TIMEOUT_MS}ms，已中止`)
        resolve('')
      }
    }, GIT_CMD_TIMEOUT_MS)

    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf-8') })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf-8') })
    child.on('error', () => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        resolve('')
      }
    })
    child.on('close', code => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code === 0) {
        resolve(stdout.trim())
      } else if (options.allowNonZeroExit) {
        resolve(stdout.trim() || '')
      } else {
        // 不抛错，但记录日志方便排查
        if (stderr) log.debug(`[GitContext] git ${args.join(' ')} 失败 (exit ${code}): ${stderr.slice(0, 200)}`)
        resolve('')
      }
    })
  })
}

/**
 * 渲染 Git 上下文到 prompt 文本片段
 * 非 Git 仓库时返回"非 Git 仓库"的一行说明
 */
export function renderGitContext(ctx: GitContext): string {
  if (!ctx.isGitRepo) {
    return '- 非 Git 仓库'
  }
  const lines: string[] = []
  if (ctx.branch) {
    lines.push(`- Git 分支：\`${ctx.branch}\`${ctx.mainBranch && ctx.branch !== ctx.mainBranch ? `（主分支：\`${ctx.mainBranch}\`）` : ''}`)
  }
  if (ctx.userName) {
    lines.push(`- Git 用户：${ctx.userName}`)
  }
  if (ctx.statusShort) {
    lines.push(`- Git status：`)
    // 多行缩进显示
    const indented = ctx.statusShort.split('\n').map(l => `  ${l}`).join('\n')
    lines.push(indented)
  } else if (ctx.statusShort === '') {
    lines.push(`- Git status：(clean，无未提交变更)`)
  }
  if (ctx.recentCommits) {
    lines.push(`- 最近提交：`)
    const indented = ctx.recentCommits.split('\n').map(l => `  ${l}`).join('\n')
    lines.push(indented)
  }
  return lines.join('\n')
}

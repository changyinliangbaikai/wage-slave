/**
 * Agent 安全护栏
 *
 * 三层防护：
 *  1. 路径白名单：写入/编辑/打开操作时校验目标路径必须在白名单内
 *  2. 命令黑名单：run_command 执行前过滤已知危险命令
 *  3. 跨平台抽象：根据 process.platform 选择正确的目录与命令策略
 *
 * 跨平台修正（对比方案文档）：
 *  - 不再使用 process.env.APPDATA（macOS / Linux 不存在）
 *  - 用 app.getPath() 与 os.homedir() 派生标准目录
 */

import { app, BrowserWindow, dialog } from 'electron'
import * as os from 'os'
import * as path from 'path'

/**
 * 获取 Agent 允许访问的路径白名单（绝对路径前缀）
 * 校验时只要 resolve 后的目标以白名单中任一前缀开头即可放行
 */
export function getAllowedPaths(): string[] {
  const home = os.homedir()
  const userData = app.getPath('userData')
  const tempDir = app.getPath('temp')

  // 跨平台用户标准目录（mac / Windows 通用）
  const desktop = path.join(home, 'Desktop')
  const documents = path.join(home, 'Documents')
  const downloads = path.join(home, 'Downloads')

  const allowed: string[] = [
    userData,           // 应用数据目录（小牛马 JSON 存储）
    desktop,
    documents,
    downloads,
    tempDir,            // 系统临时目录
  ]

  // 用户主目录下的常见开发目录（按需）
  const devDirs = ['Projects', 'workspace', 'Code', 'Repos']
  for (const d of devDirs) {
    allowed.push(path.join(home, d))
  }

  // POSIX 平台额外允许 /tmp
  if (process.platform !== 'win32') {
    allowed.push('/tmp')
    allowed.push('/var/tmp')
  }

  return allowed
}

/**
 * 校验目标路径是否在白名单内
 * 不在白名单内的路径会抛出错误，由工具执行器捕获并返回给 LLM
 */
export function assertSafePath(targetPath: string): void {
  if (!targetPath || typeof targetPath !== 'string') {
    throw new Error('路径不能为空')
  }

  // 展开 ~ 起始的路径（部分模型会输出这种相对路径）
  const expanded = expandHome(targetPath)
  const resolved = path.resolve(expanded)

  const allowedPrefixes = getAllowedPaths()
  const isAllowed = allowedPrefixes.some(prefix => isInside(resolved, prefix))
  if (!isAllowed) {
    throw new Error(
      `安全限制: 不允许访问路径 ${resolved}。允许的目录：${allowedPrefixes.join('、')}`,
    )
  }
}

/**
 * 把 ~/foo 展开为 $HOME/foo
 * Windows 上同样支持 ~（os.homedir 返回正确的 USERPROFILE）
 */
export function expandHome(p: string): string {
  if (!p) return p
  if (p === '~') return os.homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(os.homedir(), p.slice(2))
  }
  return p
}

/**
 * 判断 child 是否在 parent 目录下（含相等情况）
 * 用 path.relative 避免 startsWith 误判（比如 /a/bcd 不是 /a/b 的子目录）
 */
function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child)
  // 同一目录返回 ''；子目录不会以 .. 开头；不能跨盘符（rel 以盘符开头说明不在 parent 下）
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/**
 * 危险命令规则（黑名单 + 边界匹配）
 *
 * 设计要点：
 *  - 用正则做"命令边界"匹配：行首 / 空白 / `;` / `&` / `|` 后才算命令开头
 *    这样既不会误伤到子串（如 `chmod` 与 `mod` 区分），
 *    也能拦下 `xxx && rm yyy`、`echo hi | sudo cmd` 等组合命令
 *  - 每条规则带 reason，拒绝时直接给 LLM 看到原因，便于它换用专用工具
 *  - 始终大小写不敏感；命令边界包含管道、分号、逻辑与/或、反引号、`$(`、行首
 *
 * 黑名单仍非完美沙盒（如 `\rm`、`/bin/rm`、变量展开仍可能绕过），
 * 因此本模块还提供 confirmCommandWithUser() 弹窗作为最后一道人工确认防线。
 */

/** 命令边界前缀：行首 / 空白 / 管道 / 分号 / 反引号 / 子命令开头 */
const CMD_BOUNDARY = '(?:^|[\\s;&|`(])'

function cmd(name: string): RegExp {
  // 命令名后必须接空白、行尾或参数分隔符；避免误伤如 `chmod` vs `mod`
  return new RegExp(`${CMD_BOUNDARY}${name}(?=\\s|$|;|&|\\|)`, 'i')
}

interface DangerousRule { pattern: RegExp; reason: string }

const DANGEROUS_RULES: ReadonlyArray<DangerousRule> = [
  // ── 文件/目录删除（强制改用专用工具或 LLM 自己拼读+写+删的组合）
  { pattern: cmd('rm'),    reason: '禁止 rm。删除请改用文件操作工具或先读再删的组合' },
  { pattern: cmd('rmdir'), reason: '禁止 rmdir。删除目录请明确告知用户，由用户手动执行' },
  { pattern: cmd('unlink'), reason: '禁止 unlink' },
  { pattern: cmd('trash'), reason: '禁止使用 trash 命令删除' },

  // ── 移动/重命名（容易丢文件）
  { pattern: cmd('mv'),    reason: '禁止 mv。移动请改用 read_file + write_file + 用户手动删除' },

  // ── 权限 / 所有权 / 特权提升
  { pattern: cmd('chmod'), reason: '禁止 chmod 修改权限' },
  { pattern: cmd('chown'), reason: '禁止 chown 修改所有者' },
  { pattern: cmd('chgrp'), reason: '禁止 chgrp 修改用户组' },
  { pattern: cmd('sudo'),  reason: '禁止 sudo 提权' },
  { pattern: cmd('su'),    reason: '禁止 su 切换用户' },
  { pattern: cmd('doas'),  reason: '禁止 doas 提权' },

  // ── 磁盘 / 文件系统级
  { pattern: /(?:^|[\s;&|`(])dd\s+(?:if=|of=)/i, reason: '禁止 dd 读写裸设备' },
  { pattern: cmd('mkfs'),   reason: '禁止格式化文件系统' },
  { pattern: cmd('fdisk'),  reason: '禁止磁盘分区操作' },
  { pattern: cmd('parted'), reason: '禁止磁盘分区操作' },
  { pattern: cmd('diskutil'), reason: '禁止 diskutil 磁盘工具' },

  // ── 进程控制（Agent 不应主动 kill 进程）
  { pattern: cmd('kill'),    reason: '禁止 kill 终止进程' },
  { pattern: cmd('killall'), reason: '禁止 killall' },
  { pattern: cmd('pkill'),   reason: '禁止 pkill' },

  // ── 系统电源 / 关机
  { pattern: cmd('shutdown'), reason: '禁止关机' },
  { pattern: cmd('reboot'),   reason: '禁止重启' },
  { pattern: cmd('halt'),     reason: '禁止 halt' },
  { pattern: cmd('poweroff'), reason: '禁止 poweroff' },

  // ── 远程脚本下载执行（curl|sh、wget|bash、bash <(curl ...)）
  { pattern: /\b(?:curl|wget)\b[^;&|]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|fish|dash|ksh|csh)\b/i, reason: '禁止远程脚本管道执行（curl|sh）' },
  { pattern: /\b(?:bash|sh|zsh|fish|dash)\s+<\(\s*(?:curl|wget)/i, reason: '禁止进程替换执行远程脚本' },
  { pattern: /\bsource\s+<\(\s*(?:curl|wget)/i, reason: '禁止 source 远程脚本' },

  // ── git 破坏性操作
  { pattern: /\bgit\s+reset\s+--hard\b/i, reason: '禁止 git reset --hard，会丢失未提交改动' },
  { pattern: /\bgit\s+clean\s+-[a-z]*f/i, reason: '禁止 git clean -f，会删未跟踪文件' },
  { pattern: /\bgit\s+push\s+(?:[^;&|]*\s)?(?:--force|--force-with-lease|-f)\b/i, reason: '禁止 git push --force' },
  { pattern: /\bgit\s+stash\s+(?:drop|clear)\b/i, reason: '禁止丢弃 git stash' },
  { pattern: /\bgit\s+checkout\s+(?:--|\.|HEAD)/i, reason: '禁止 git checkout 覆盖工作区' },
  { pattern: /\bgit\s+branch\s+-D\b/i, reason: '禁止 git branch -D 强制删除分支' },

  // ── 重定向覆盖（> 单符号会清空/覆盖文件，>> 追加放行）
  // 用否定后视避开 >> / >& / 2> / 1>&2 等合法用法
  { pattern: /(?<![>&\d])>(?!>|&|\s*\/dev\/null\b)/, reason: '禁止 > 重定向覆盖，使用 write_file 工具' },
  // 显式拦写裸设备
  { pattern: />\s*\/dev\/(?:sda|sdb|nvme|disk|hd[a-z])/i, reason: '禁止写裸设备' },

  // ── fork 炸弹
  { pattern: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, reason: 'fork 炸弹' },

  // ── /etc 写入
  { pattern: />\s*\/etc\//i, reason: '禁止写入 /etc' },

  // ── Windows / PowerShell 危险操作
  { pattern: cmd('del'),     reason: '禁止 del' },
  { pattern: cmd('erase'),   reason: '禁止 erase' },
  { pattern: cmd('rd'),      reason: '禁止 rd（rmdir）' },
  { pattern: cmd('format'),  reason: '禁止 format 格式化' },
  { pattern: cmd('taskkill'), reason: '禁止 taskkill' },
  { pattern: /\breg\s+delete\b/i, reason: '禁止注册表删除' },
  { pattern: /\bRemove-Item\b[^;&|]*-Recurse/i, reason: '禁止 Remove-Item -Recurse' },
  { pattern: /\bSet-ExecutionPolicy\b/i, reason: '禁止修改 PowerShell 执行策略' },
  { pattern: /\bInvoke-Expression\b/i, reason: '禁止 Invoke-Expression 动态执行' },
  { pattern: /\bIEX\b/i, reason: '禁止 IEX（Invoke-Expression 别名）' },
  { pattern: cmd('iex'),    reason: '禁止 iex' },
]

/** 命令安全检查结果 */
export interface CommandCheckResult {
  /** 是否允许进入二次确认（true=允许，false=直接拒绝） */
  allowed: boolean
  /** 拒绝原因（仅当 allowed=false） */
  reason?: string
  /** 命中的危险规则原文（调试用） */
  matchedPattern?: string
}

/**
 * 检查命令是否被黑名单拦截
 *
 * 注意：通过本检查 ≠ 直接执行。run_command 工具还需要经过 confirmCommandWithUser
 * 让用户人工确认。黑名单只是"硬拒绝"层，再加一层人工确认是最终保险。
 */
export function checkCommand(command: string): CommandCheckResult {
  if (!command || typeof command !== 'string') {
    return { allowed: false, reason: '命令为空或非字符串' }
  }
  for (const rule of DANGEROUS_RULES) {
    if (rule.pattern.test(command)) {
      return {
        allowed: false,
        reason: rule.reason,
        matchedPattern: rule.pattern.source,
      }
    }
  }
  return { allowed: true }
}

/**
 * 兼容旧调用：boolean 形式的命令安全判断
 * @deprecated 请使用 checkCommand() 获取拒绝原因
 */
export function isCommandSafe(command: string): boolean {
  return checkCommand(command).allowed
}

/**
 * 弹出 Electron 系统对话框，请求用户对命令执行做二次确认
 *
 * 设计：
 *  - defaultId / cancelId 都指向"拒绝"，避免用户误回车放行危险命令
 *  - 标题/正文清晰展示完整命令、工作目录、超时，让用户能审阅
 *  - 父窗口优先用当前聚焦窗口，fallback 到任一可见窗口
 *
 * @returns 用户允许执行返回 true；拒绝或关闭对话框返回 false
 */
export async function confirmCommandWithUser(params: {
  command: string
  workDir?: string
  timeoutMs: number
}): Promise<boolean> {
  const { command, workDir, timeoutMs } = params

  // 选择父窗口：优先聚焦窗口，否则任一可见窗口
  const focused = BrowserWindow.getFocusedWindow()
  const visible = BrowserWindow.getAllWindows().find(w => w.isVisible() && !w.isDestroyed())
  const parentWin = focused ?? visible ?? null

  console.log('[Agent.security] 请求用户确认命令执行:', command)

  const showOpts = {
    type: 'warning' as const,
    title: 'Agent 请求执行命令',
    message: '🤖 Agent 想要执行下面的命令，请确认',
    detail:
      `命令：\n${command}\n\n` +
      `工作目录：${workDir ?? '默认'}\n` +
      `超时：${(timeoutMs / 1000).toFixed(0)} 秒\n\n` +
      '⚠️ 命令将在你本机执行。如果不确定其行为，请点【拒绝】。',
    buttons: ['拒绝', '允许执行'],
    defaultId: 0,   // 默认聚焦"拒绝"
    cancelId: 0,    // ESC / 关闭对话框 = 拒绝
    noLink: true,
  }

  const result = parentWin
    ? await dialog.showMessageBox(parentWin, showOpts)
    : await dialog.showMessageBox(showOpts)

  const allowed = result.response === 1
  console.log(`[Agent.security] 用户${allowed ? '允许' : '拒绝'}执行命令`)
  return allowed
}

/**
 * 工具安全分级（仅做 UI 标签和审计日志用）
 *  - safe：只读，无副作用
 *  - cautious：会修改本地数据 / 文件
 *  - sensitive：会执行命令 / 打开外部程序
 */
export type ToolSafetyLevel = 'safe' | 'cautious' | 'sensitive'

export const TOOL_SAFETY_MAP: Record<string, ToolSafetyLevel> = {
  // 只读
  read_file: 'safe',
  list_files: 'safe',
  search_files: 'safe',
  get_today_log: 'safe',
  get_todos: 'safe',
  get_logs_range: 'safe',
  wait: 'safe',
  // 写入本地数据
  write_file: 'cautious',
  edit_file: 'cautious',
  save_todo: 'cautious',
  update_todo: 'cautious',
  append_log: 'cautious',
  show_notification: 'cautious',
  // 执行命令 / 打开外部
  run_command: 'sensitive',
  open_file: 'sensitive',
}

export function getToolSafety(toolName: string): ToolSafetyLevel {
  return TOOL_SAFETY_MAP[toolName] ?? 'sensitive'
}

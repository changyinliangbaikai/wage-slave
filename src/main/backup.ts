/**
 * 备份 & 恢复模块
 *
 * 将 userData 下的业务数据（logs / todos / ai-chats / scheduler / config.json）
 * 打包成 zip 文件，供用户导出/导入。
 *
 * 注意：
 *  - API Key 存在系统钥匙串（keytar），不在 userData 里，**不会** 被备份/覆盖
 *  - 导入时会先把当前数据快照到 `{userData}/.backup-before-import-<ts>/`，方便回滚
 *  - 电子日志目录（Library/Logs/...）不在备份范围，日志量大且无业务价值
 */

import * as fs from 'fs'
import * as path from 'path'
import JSZip from 'jszip'
import { app, ipcMain, dialog } from 'electron'
import log from 'electron-log/main'
import { IPC } from '@shared/ipc-channels'

// 需要打包/还原的业务子目录或文件（相对于 userData）
// 注意：不要把 ScheduledTask 的 logs 目录备份进去，体积大且可再生
const INCLUDE_FILES = ['config.json']
const INCLUDE_DIRS = ['logs', 'todos', 'ai-chats', 'scheduler']
const EXCLUDE_PATHS = [
  // scheduler/logs 是任务运行日志，无需备份
  path.join('scheduler', 'logs'),
]

const BASE_DIR = () => app.getPath('userData')

function localDateStr(d: Date = new Date()): string {
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** 判断 relPath 是否落在排除集合下 */
function isExcluded(relPath: string): boolean {
  return EXCLUDE_PATHS.some(ex => relPath === ex || relPath.startsWith(ex + path.sep))
}

/** 递归把 dir 下的文件写入 zip（相对路径保持一致） */
function addDirToZip(zip: JSZip, absDir: string, relBase: string): void {
  if (!fs.existsSync(absDir)) return
  const entries = fs.readdirSync(absDir, { withFileTypes: true })
  for (const e of entries) {
    const absChild = path.join(absDir, e.name)
    const relChild = path.join(relBase, e.name)
    if (isExcluded(relChild)) continue
    if (e.isDirectory()) {
      addDirToZip(zip, absChild, relChild)
    } else if (e.isFile()) {
      const content = fs.readFileSync(absChild)
      // zip 内使用 POSIX 分隔符
      zip.file(relChild.split(path.sep).join('/'), content)
    }
  }
}

/** 导出：打包 userData 关键数据 → zip */
async function exportBackup(): Promise<{ ok: boolean; filePath?: string; reason?: string }> {
  const defaultName = `xiaoniu-backup-${localDateStr()}.zip`
  const result = await dialog.showSaveDialog({
    title: '导出小小牛马数据备份',
    defaultPath: defaultName,
    filters: [{ name: 'Zip 压缩包', extensions: ['zip'] }],
  })
  if (result.canceled || !result.filePath) {
    return { ok: false, reason: 'cancelled' }
  }

  try {
    const zip = new JSZip()
    // 附加一个 meta 便于未来兼容性判断
    const meta = {
      productName: '小小牛马',
      version: app.getVersion(),
      exportedAt: new Date().toISOString(),
      platform: process.platform,
    }
    zip.file('backup.meta.json', JSON.stringify(meta, null, 2))

    const base = BASE_DIR()
    for (const f of INCLUDE_FILES) {
      const abs = path.join(base, f)
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        zip.file(f, fs.readFileSync(abs))
      }
    }
    for (const d of INCLUDE_DIRS) {
      addDirToZip(zip, path.join(base, d), d)
    }

    const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } })
    fs.writeFileSync(result.filePath, buf)
    log.info('[Backup] 导出成功:', result.filePath, 'size=', buf.length)
    return { ok: true, filePath: result.filePath }
  } catch (e: any) {
    log.error('[Backup] 导出失败:', e?.message, e?.stack)
    return { ok: false, reason: e?.message ?? 'unknown' }
  }
}

/** 递归删除目录（Node 14+ 的 fs.rmSync 带 recursive 选项） */
function removePath(p: string): void {
  if (!fs.existsSync(p)) return
  fs.rmSync(p, { recursive: true, force: true })
}

/** 把当前 userData 里的待覆盖部分快照到一个子目录，便于回滚 */
function snapshotCurrent(): string {
  const snapDir = path.join(BASE_DIR(), `.backup-before-import-${Date.now()}`)
  fs.mkdirSync(snapDir, { recursive: true })
  const base = BASE_DIR()
  for (const f of INCLUDE_FILES) {
    const src = path.join(base, f)
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(snapDir, f))
  }
  for (const d of INCLUDE_DIRS) {
    const src = path.join(base, d)
    if (!fs.existsSync(src)) continue
    const dst = path.join(snapDir, d)
    fs.cpSync(src, dst, { recursive: true })
  }
  return snapDir
}

/** 导入：从用户选择的 zip 解压到 userData */
async function importBackup(): Promise<{ ok: boolean; reason?: string; snapshotDir?: string }> {
  const pick = await dialog.showOpenDialog({
    title: '选择小小牛马数据备份（.zip）',
    filters: [{ name: 'Zip 压缩包', extensions: ['zip'] }],
    properties: ['openFile'],
  })
  if (pick.canceled || pick.filePaths.length === 0) {
    return { ok: false, reason: 'cancelled' }
  }
  const zipPath = pick.filePaths[0]

  // 二次确认
  const confirm = await dialog.showMessageBox({
    type: 'warning',
    title: '恢复数据将覆盖当前数据',
    message: '导入将覆盖当前的日志、待办、AI 对话等数据',
    detail: `将自动把当前数据快照到：\n.backup-before-import-*\n\n确定从「${path.basename(zipPath)}」恢复吗？`,
    buttons: ['开始恢复', '取消'],
    defaultId: 1,
    cancelId: 1,
  })
  if (confirm.response !== 0) return { ok: false, reason: 'cancelled-by-user' }

  // 快照
  const snapshotDir = snapshotCurrent()
  log.info('[Backup] 已快照当前数据到:', snapshotDir)

  try {
    const buf = fs.readFileSync(zipPath)
    const zip = await JSZip.loadAsync(buf)
    const base = BASE_DIR()

    // 先清掉将被覆盖的目录（但保留 snapshot 目录和其它不在范围的内容）
    for (const d of INCLUDE_DIRS) {
      removePath(path.join(base, d))
    }
    // Walk through all files in the zip
    const tasks: Promise<void>[] = []
    zip.forEach((relPath, entry) => {
      if (entry.dir) return
      if (relPath === 'backup.meta.json') return
      const topSegment = relPath.split('/')[0]
      // 安全校验：只允许写入白名单里的位置
      const isFileAllowed = INCLUDE_FILES.includes(relPath)
      const isDirAllowed = INCLUDE_DIRS.includes(topSegment)
      if (!isFileAllowed && !isDirAllowed) return
      // 防止路径穿越（如 ../../etc/passwd）
      if (relPath.includes('..')) return

      const abs = path.join(base, relPath.split('/').join(path.sep))
      tasks.push(
        entry.async('nodebuffer').then(data => {
          fs.mkdirSync(path.dirname(abs), { recursive: true })
          fs.writeFileSync(abs, data)
        }),
      )
    })
    await Promise.all(tasks)
    log.info('[Backup] 导入成功，文件数:', tasks.length)
    return { ok: true, snapshotDir }
  } catch (e: any) {
    log.error('[Backup] 导入失败:', e?.message, e?.stack)
    return { ok: false, reason: e?.message ?? 'unknown', snapshotDir }
  }
}

/**
 * 保存一段 markdown 到本地文件（用于 AI 对话把答复"保存为周报/文档"）
 * 默认目录：{userData}/reports/；用户点击后再通过 showSaveDialog 确认
 */
async function saveMarkdown(opts: { content: string; suggestedName?: string }): Promise<{
  ok: boolean
  filePath?: string
  reason?: string
}> {
  try {
    const { content, suggestedName } = opts
    if (!content?.trim()) return { ok: false, reason: 'empty-content' }
    const reportsDir = path.join(BASE_DIR(), 'reports')
    if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true })
    const stamp = localDateStr()
    const safeName = (suggestedName || `小牛马-${stamp}`).replace(/[\\/:*?"<>|]/g, '-').slice(0, 80)
    const defaultPath = path.join(reportsDir, `${safeName}.md`)

    const res = await dialog.showSaveDialog({
      title: '保存为本地文档',
      defaultPath,
      filters: [
        { name: 'Markdown', extensions: ['md'] },
        { name: '文本', extensions: ['txt'] },
      ],
    })
    if (res.canceled || !res.filePath) return { ok: false, reason: 'cancelled' }
    fs.writeFileSync(res.filePath, content, 'utf-8')
    log.info('[Backup] 文档保存成功:', res.filePath)
    return { ok: true, filePath: res.filePath }
  } catch (e: any) {
    log.error('[Backup] 保存文档失败:', e?.message)
    return { ok: false, reason: e?.message ?? 'unknown' }
  }
}

/** 注册 IPC */
export function registerBackupIPC(): void {
  ipcMain.handle(IPC.BACKUP_EXPORT, () => exportBackup())
  ipcMain.handle(IPC.BACKUP_IMPORT, () => importBackup())
  // 保存 AI 对话答复为本地 markdown 文档
  ipcMain.handle(IPC.REPORT_SAVE, (_e, opts: { content: string; suggestedName?: string }) => saveMarkdown(opts))
  // 打开 userData 目录（方便用户手动排查）
  ipcMain.handle(IPC.BACKUP_OPEN_DATA_DIR, async () => {
    const { shell } = await import('electron')
    const dir = BASE_DIR()
    await shell.openPath(dir)
    return { ok: true, dir }
  })
}

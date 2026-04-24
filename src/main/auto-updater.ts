/**
 * 自动更新模块（基于 electron-updater）
 *
 * 职责：
 *  - 生产环境下启动后延迟若干秒主动检查 GitHub Releases
 *  - 监听 electron-updater 事件，广播到所有渲染进程
 *  - 暴露 IPC：手动检查更新、下载更新、安装重启
 *
 * 注意：
 *  - 开发模式（app.isPackaged === false）不检查，因为 electron-updater 只支持打包后的 app
 *  - 发布流程：tag 推送 → build.yml 构建 → electron-builder 生成 latest.yml + .exe
 *    → softprops/action-gh-release 上传到 Release → 用户端 autoUpdater 拉取 latest.yml 对比版本
 */

import { app, BrowserWindow, ipcMain, dialog } from 'electron'
import log from 'electron-log/main'
import { autoUpdater, type ProgressInfo, type UpdateInfo } from 'electron-updater'
import { IPC } from '@shared/ipc-channels'

// electron-updater 自己用 electron-log 记录，日志格式和主进程一致
autoUpdater.logger = log
autoUpdater.autoDownload = false           // 让用户知情后再下载
autoUpdater.autoInstallOnAppQuit = true    // 下载完后退出时自动安装

let initialized = false
let checking = false

/** 广播到所有渲染进程 */
function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload)
    }
  }
}

/** 注册所有 autoUpdater 事件（只注册一次） */
function attachUpdaterEvents(): void {
  autoUpdater.on('checking-for-update', () => {
    log.info('[AutoUpdater] 正在检查更新…')
    broadcast(IPC.UPDATE_STATUS, { status: 'checking' })
  })

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    log.info('[AutoUpdater] 发现新版本:', info.version)
    broadcast(IPC.UPDATE_STATUS, {
      status: 'available',
      version: info.version,
      releaseDate: info.releaseDate,
      releaseNotes: info.releaseNotes,
    })
  })

  autoUpdater.on('update-not-available', (info: UpdateInfo) => {
    log.info('[AutoUpdater] 当前已是最新版本:', info.version)
    broadcast(IPC.UPDATE_STATUS, { status: 'not-available', version: info.version })
  })

  autoUpdater.on('download-progress', (p: ProgressInfo) => {
    broadcast(IPC.UPDATE_STATUS, {
      status: 'downloading',
      percent: Math.round(p.percent),
      transferred: p.transferred,
      total: p.total,
      bytesPerSecond: p.bytesPerSecond,
    })
  })

  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    log.info('[AutoUpdater] 新版本下载完成:', info.version)
    broadcast(IPC.UPDATE_STATUS, { status: 'downloaded', version: info.version })
  })

  autoUpdater.on('error', (err: Error) => {
    log.error('[AutoUpdater] 更新出错:', err?.message, err?.stack)
    broadcast(IPC.UPDATE_STATUS, { status: 'error', message: err?.message ?? String(err) })
  })
}

/** 初始化：注册 IPC + 事件 + 启动时检查 */
export function initAutoUpdater(): void {
  if (initialized) return
  initialized = true

  // 开发模式下 electron-updater 会抛异常（没有 app-update.yml），直接跳过
  if (!app.isPackaged) {
    log.info('[AutoUpdater] 开发模式，跳过自动更新')
    // 仍然注册 IPC，便于渲染进程调试时不报错（会返回一个明确提示）
    ipcMain.handle(IPC.UPDATE_CHECK, () => ({ ok: false, reason: 'dev-mode' }))
    ipcMain.handle(IPC.UPDATE_DOWNLOAD, () => ({ ok: false, reason: 'dev-mode' }))
    ipcMain.handle(IPC.UPDATE_INSTALL, () => ({ ok: false, reason: 'dev-mode' }))
    return
  }

  attachUpdaterEvents()

  // 手动检查更新
  ipcMain.handle(IPC.UPDATE_CHECK, async () => {
    if (checking) return { ok: false, reason: 'already-checking' }
    checking = true
    try {
      const r = await autoUpdater.checkForUpdates()
      return { ok: true, version: r?.updateInfo?.version }
    } catch (e: any) {
      log.error('[AutoUpdater] 手动检查更新失败:', e?.message)
      return { ok: false, reason: e?.message ?? 'unknown' }
    } finally {
      checking = false
    }
  })

  // 确认下载
  ipcMain.handle(IPC.UPDATE_DOWNLOAD, async () => {
    try {
      await autoUpdater.downloadUpdate()
      return { ok: true }
    } catch (e: any) {
      log.error('[AutoUpdater] 下载更新失败:', e?.message)
      return { ok: false, reason: e?.message ?? 'unknown' }
    }
  })

  // 退出并安装
  ipcMain.handle(IPC.UPDATE_INSTALL, async () => {
    log.info('[AutoUpdater] 用户确认安装，3 秒后退出并安装')
    setTimeout(() => {
      autoUpdater.quitAndInstall(false, true)
    }, 3000)
    return { ok: true }
  })

  // 启动后延迟 10 秒检查，避免和其它启动逻辑争抢带宽
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(err => {
      log.warn('[AutoUpdater] 启动自动检查更新失败:', err?.message)
    })
  }, 10_000)
}

/** 供其它模块在合适时机弹"有新版本"对话框（目前未主动调用，保留扩展点） */
export async function showUpdateDialog(version: string, releaseNotes?: string): Promise<boolean> {
  const result = await dialog.showMessageBox({
    type: 'info',
    title: '小小牛马有新版本',
    message: `检测到新版本 ${version}`,
    detail: typeof releaseNotes === 'string' ? releaseNotes : '点击"立即下载"在后台开始下载。',
    buttons: ['立即下载', '稍后再说'],
    defaultId: 0,
    cancelId: 1,
  })
  return result.response === 0
}

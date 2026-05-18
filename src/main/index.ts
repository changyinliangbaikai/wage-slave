/**
 * 小小牛马 - Electron 主进程入口
 */

import log from 'electron-log/main'
import { app, BrowserWindow, globalShortcut } from 'electron'

// 初始化文件日志（接管 console.log/warn/error，同时写入文件）
log.initialize()
log.transports.file.level = 'debug'
// 日志文件位置：%APPDATA%\xiao-niu-ma\logs\main.log（Windows）
console.log('[Main] 小小牛马启动，日志路径：', log.transports.file.getFile().path)

// ── 主进程全局异常兜底 ───────────────────────────────────
// 任何未捕获的异常或 rejection 都落到日志文件，不至于让 app 白退
process.on('uncaughtException', err => {
  log.error('[uncaughtException]', err?.message, err?.stack)
})
process.on('unhandledRejection', reason => {
  const err = reason as { message?: string; stack?: string } | undefined
  log.error('[unhandledRejection]', err?.message ?? String(reason), err?.stack)
})
import { createMainWindow, getMainWindow, openAIChatWindow } from './windows'
import { createTray } from './tray'
import { startScheduler } from './scheduler'
import { startActivityMonitor } from './activity-monitor'
import { registerIPCHandlers } from './ipc-handlers'
import { initAutoUpdater } from './auto-updater'
import { registerBackupIPC } from './backup'
import {
  registerPetSchemePrivileged,
  initPetPackStore,
  registerPetPackIPC,
} from './pet-pack-store'
import { getConfig } from './store'
import { IPC } from '@shared/ipc-channels'

// 注册 pet:// 自定义协议为特权 scheme（必须在 app.ready 之前调用）
registerPetSchemePrivileged()

// 防止多实例
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
}

app.on('second-instance', () => {
  // 再次启动时聚焦到已有窗口
  const win = getMainWindow()
  if (win) {
    if (win.isMinimized()) win.restore()
    win.focus()
  }
})

app.whenReady().then(() => {
  // 桌宠包系统：必须在创建主窗口之前完成 pet:// 协议绑定
  initPetPackStore()
  registerPetPackIPC()

  // 注册 IPC 处理器
  registerIPCHandlers()
  // 注册备份/恢复 IPC
  registerBackupIPC()

  // 创建主窗口（像素猫）
  createMainWindow()

  // 创建系统托盘
  createTray()

  // 启动定时触发器（上下班时间检测）
  startScheduler((type, date, hasTodos) => {
    const win = getMainWindow()
    if (!win) return

    if (type === 'morning') {
      win.webContents.send(IPC.TRIGGER_MORNING, { date })
    } else {
      win.webContents.send(IPC.TRIGGER_EVENING, { date, has_todos: hasTodos })
    }
  })

  // 启动键鼠活跃监测（休息提醒）
  startActivityMonitor((elapsedMin) => {
    const win = getMainWindow()
    win?.webContents.send(IPC.TRIGGER_BREAK, { elapsed_min: elapsedMin })
  })

  // 启动定时任务调度引擎
  import('./tools/task-scheduler').then(({ startTaskScheduler }) => {
    startTaskScheduler()
  }).catch(err => {
    console.error('[Main] 定时任务调度器启动失败:', err)
  })

  // 注册 AI 对话的全局快捷键
  registerAIChatHotkey()

  // 自动更新（生产环境会在 10s 后检查 GitHub Releases）
  initAutoUpdater()
})

/**
 * 注册（或重注册）AI 对话窗口的全局唤出快捷键
 * 失败不影响其它入口（托盘菜单 / 双击小猫）
 */
function registerAIChatHotkey(): void {
  const { ai_chat_hotkey } = getConfig()
  globalShortcut.unregisterAll()
  if (!ai_chat_hotkey) return
  try {
    const ok = globalShortcut.register(ai_chat_hotkey, () => {
      console.log('[Main] 全局快捷键触发，唤出 AI 对话窗口')
      openAIChatWindow()
    })
    if (!ok) {
      console.warn('[Main] 注册 AI 对话快捷键失败:', ai_chat_hotkey)
    } else {
      console.log('[Main] 已注册 AI 对话快捷键:', ai_chat_hotkey)
    }
  } catch (e) {
    console.warn('[Main] 注册 AI 对话快捷键异常:', e)
  }
}

// 导出以便 IPC 处理器在配置变更后重新注册
export { registerAIChatHotkey }

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})

// macOS：点击 Dock 图标时重新显示窗口（本项目主要面向 Windows，预留）
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createMainWindow()
  }
})

// 关闭所有窗口时不退出（常驻后台，依靠托盘图标退出）
app.on('window-all-closed', () => {
  // 不调用 app.quit()，保持后台运行
})

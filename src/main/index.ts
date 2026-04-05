/**
 * 小小牛马 - Electron 主进程入口
 */

import log from 'electron-log/main'
import { app, BrowserWindow } from 'electron'

// 初始化文件日志（接管 console.log/warn/error，同时写入文件）
log.initialize()
log.transports.file.level = 'debug'
// 日志文件位置：%APPDATA%\xiao-niu-ma\logs\main.log（Windows）
console.log('[Main] 小小牛马启动，日志路径：', log.transports.file.getFile().path)
import { createMainWindow, getMainWindow } from './windows'
import { createTray } from './tray'
import { startScheduler } from './scheduler'
import { startActivityMonitor } from './activity-monitor'
import { registerIPCHandlers } from './ipc-handlers'
import { IPC } from '@shared/ipc-channels'

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
  // 注册 IPC 处理器
  registerIPCHandlers()

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

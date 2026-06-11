/**
 * 窗口行为与休息提醒 IPC 注册
 */

import { ipcMain } from 'electron'
import { IPC } from '@shared/ipc-channels'
import {
  openSettingsWindow,
  showMainWindow,
  openLogWindow,
  openToolWindow,
} from '../windows'
import { snoozeBreak, resetContinuousTime } from '../activity-monitor'

export function registerWindowIPC(): void {
  // ── 窗口行为 ──────────────────────────────────
  ipcMain.on(IPC.WINDOW_SHOW, () => showMainWindow())

  ipcMain.on(IPC.OPEN_SETTINGS, () => openSettingsWindow())

  ipcMain.on(IPC.OPEN_LOGS, () => openLogWindow())

  ipcMain.on(IPC.OPEN_TOOLS, () => openToolWindow())

  // ── 休息提醒交互 ──────────────────────────────
  ipcMain.on(IPC.SNOOZE_BREAK, (_e, minutes: number) => snoozeBreak(minutes))
  ipcMain.on(IPC.BREAK_DONE, () => resetContinuousTime())

  // 兼容不同的事件名
  ipcMain.on('renderer:break-done', () => resetContinuousTime())
}

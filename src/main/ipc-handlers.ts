/**
 * IPC 处理器注册
 * 所有 renderer → main 的请求在这里统一处理
 */

import { ipcMain, app } from 'electron'
import { IPC } from '@shared/ipc-channels'
import {
  getConfig, setConfig,
  getLog, saveLog,
  getTodos, saveTodos,
  getLogsInRange, todayStr,
} from './store'
import { openSettingsWindow, showMainWindow } from './windows'
import { snoozeBreak, resetContinuousTime } from './activity-monitor'
import type { AppConfig, DailyLog, TodoItem } from '@shared/types'

// ── 尝试加载 keytar（安全存储 API Key）──────────
let keytar: typeof import('keytar') | null = null
try {
  keytar = require('keytar')
} catch {
  console.warn('[IPC] keytar 未安装，API Key 将以明文存入 config.json（开发模式）')
}

const KEYTAR_SERVICE = 'xiao-niu-ma'
const KEYTAR_ACCOUNT = 'llm-api-key'

export function registerIPCHandlers(): void {

  // ── 配置 ──────────────────────────────────────
  ipcMain.handle(IPC.CONFIG_GET, () => getConfig())

  ipcMain.handle(IPC.CONFIG_SET, (_e, config: Partial<AppConfig>) => {
    const updated = setConfig(config)
    if ('auto_launch' in config) {
      app.setLoginItemSettings({ openAtLogin: config.auto_launch ?? false })
    }
    return updated
  })

  ipcMain.handle(IPC.API_KEY_GET, async () => {
    if (keytar) {
      return await keytar.getPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT) ?? ''
    }
    // 降级：返回空字符串（明文 Key 暂不存储在 config 中）
    return ''
  })

  ipcMain.handle(IPC.API_KEY_SET, async (_e, key: string) => {
    if (keytar) {
      await keytar.setPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT, key)
    } else {
      console.warn('[IPC] API Key 以明文临时记录（请安装 keytar）')
    }
  })

  // 测试 API 连通性
  ipcMain.handle(IPC.API_TEST, async (_e, { url, key, model }: { url: string; key: string; model: string }) => {
    try {
      const res = await fetch(`${url.replace(/\/$/, '')}/v1/models`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(8000),
      })
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
      return { ok: true, model }
    } catch (e: unknown) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  // ── 数据读写 ──────────────────────────────────
  ipcMain.handle(IPC.LOG_GET, (_e, date: string) => getLog(date ?? todayStr()))

  ipcMain.handle(IPC.LOG_SAVE, (_e, log: Partial<DailyLog> & { date: string }) => saveLog(log))

  ipcMain.handle(IPC.TODOS_GET, (_e, date: string) => getTodos(date ?? todayStr()))

  ipcMain.handle(IPC.TODOS_SAVE, (_e, { date, todos }: { date: string; todos: TodoItem[] }) => {
    saveTodos(date, todos)
    // 同步更新当日日志里的 todos 字段
    saveLog({ date, todos })
  })

  ipcMain.handle(IPC.LOGS_RANGE, (_e, { start, end }: { start: string; end: string }) =>
    getLogsInRange(start, end)
  )

  // ── 窗口行为 ──────────────────────────────────
  ipcMain.on(IPC.WINDOW_SHOW, () => showMainWindow())

  ipcMain.on(IPC.OPEN_SETTINGS, () => openSettingsWindow())

  // ── 休息提醒交互 ──────────────────────────────
  ipcMain.on(IPC.SNOOZE_BREAK, (_e, minutes: number) => snoozeBreak(minutes))

  ipcMain.on('renderer:break-done', () => resetContinuousTime())
}

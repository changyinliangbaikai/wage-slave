/**
 * IPC 通信 Hook
 * 封装 window.electronAPI，提供类型安全的调用接口
 */

import { useEffect } from 'react'
import { IPC } from '@shared/ipc-channels'
import type {
  AppConfig, DailyLog, TodoItem,
  TriggerMorningPayload, TriggerBreakPayload, TriggerEveningPayload,
} from '@shared/types'

// 扩展 Window 类型
declare global {
  interface Window {
    electronAPI: {
      invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
      send: (channel: string, ...args: unknown[]) => void
      sendRaw: (channel: string, ...args: unknown[]) => void
      on: (channel: string, listener: (...args: unknown[]) => void) => () => void
    }
  }
}

const api = window.electronAPI

// ── 配置 ──────────────────────────────────────
export const getConfig = (): Promise<AppConfig> =>
  api.invoke(IPC.CONFIG_GET) as Promise<AppConfig>

export const setConfig = (config: Partial<AppConfig>): Promise<AppConfig> =>
  api.invoke(IPC.CONFIG_SET, config) as Promise<AppConfig>

export const getAPIKey = (): Promise<string> =>
  api.invoke(IPC.API_KEY_GET) as Promise<string>

export const setAPIKey = (key: string): Promise<void> =>
  api.invoke(IPC.API_KEY_SET, key) as Promise<void>

export const testAPI = (url: string, key: string, model: string) =>
  api.invoke(IPC.API_TEST, { url, key, model }) as Promise<{ ok: boolean; error?: string }>

// ── 数据读写 ──────────────────────────────────
export const getLog = (date: string): Promise<DailyLog | null> =>
  api.invoke(IPC.LOG_GET, date) as Promise<DailyLog | null>

export const saveLog = (log: Partial<DailyLog> & { date: string }): Promise<DailyLog> =>
  api.invoke(IPC.LOG_SAVE, log) as Promise<DailyLog>

export const getTodos = (date: string): Promise<TodoItem[]> =>
  api.invoke(IPC.TODOS_GET, date) as Promise<TodoItem[]>

export const saveTodos = (date: string, todos: TodoItem[]): Promise<void> =>
  api.invoke(IPC.TODOS_SAVE, { date, todos }) as Promise<void>

export const getLogsRange = (start: string, end: string): Promise<DailyLog[]> =>
  api.invoke(IPC.LOGS_RANGE, { start, end }) as Promise<DailyLog[]>

export const exportSummaryDocx = (text: string, periodLabel: string) =>
  api.invoke(IPC.EXPORT_SUMMARY_DOCX, { text, periodLabel }) as Promise<{ ok: boolean; filePath?: string; error?: string }>

// ── 窗口 & 系统 ────────────────────────────────
export const openSettings = () => api.send(IPC.OPEN_SETTINGS)
export const openLogs = () => api.send(IPC.OPEN_LOGS)
export const openTools = () => api.send(IPC.OPEN_TOOLS)
export const openAIChat = () => api.send(IPC.OPEN_AI_CHAT)
export const openAgentChat = () => api.send(IPC.AGENT_OPEN_WINDOW)
export const snoozeBreak = (minutes: number) => api.send(IPC.SNOOZE_BREAK, minutes)
export const notifyBreakDone = () => api.send(IPC.BREAK_DONE)

// 手动拖动窗口
export const startWindowDrag = () => api.sendRaw('window:drag-start')
export const moveWindowDrag = (deltaX: number, deltaY: number) =>
  api.sendRaw('window:drag-move', deltaX, deltaY)
export const endWindowDrag = () => api.sendRaw('window:drag-end')

// ── 事件监听 Hooks ─────────────────────────────
export function useOnMorningTrigger(cb: (payload: TriggerMorningPayload) => void) {
  useEffect(() => {
    const cleanup = api.on(IPC.TRIGGER_MORNING, cb as (...args: unknown[]) => void)
    return cleanup
  }, [cb])
}

export function useOnBreakTrigger(cb: (payload: TriggerBreakPayload) => void) {
  useEffect(() => {
    const cleanup = api.on(IPC.TRIGGER_BREAK, cb as (...args: unknown[]) => void)
    return cleanup
  }, [cb])
}

export function useOnEveningTrigger(cb: (payload: TriggerEveningPayload) => void) {
  useEffect(() => {
    const cleanup = api.on(IPC.TRIGGER_EVENING, cb as (...args: unknown[]) => void)
    return cleanup
  }, [cb])
}

export function useOnEvent(channel: string, cb: (...args: unknown[]) => void) {
  useEffect(() => {
    const cleanup = api.on(channel, cb)
    return cleanup
  }, [channel, cb])
}

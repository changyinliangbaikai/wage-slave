/**
 * IPC 通信 Hook
 * 封装 window.electronAPI，提供类型安全的调用接口
 */

import { useEffect } from 'react'
import { IPC } from '@shared/ipc-channels'
import type {
  AppConfig, DailyLog, TodoItem,
  TriggerMorningPayload, TriggerBreakPayload, TriggerEveningPayload,
  SkillWithState, MarketSkillItem,
  ScheduledTask,
} from '@shared/types'

/** Skill 安装/操作通用返回 */
export interface SkillOpResult {
  ok: boolean
  skill?: SkillWithState
  error?: string
  canceled?: boolean
}

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
export const openSkills = () => api.send(IPC.SKILL_OPEN_WINDOW)
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

// ── Agent Skill 系统（Phase 2） ─────────────
export const listSkills = (): Promise<SkillWithState[]> =>
  api.invoke(IPC.SKILL_LIST) as Promise<SkillWithState[]>

export const searchSkills = (query: string): Promise<SkillWithState[]> =>
  api.invoke(IPC.SKILL_SEARCH, query) as Promise<SkillWithState[]>

export const toggleSkill = (id: string, enabled?: boolean): Promise<SkillWithState | null> =>
  api.invoke(IPC.SKILL_TOGGLE, { id, enabled }) as Promise<SkillWithState | null>

export const installSkillFromFile = (): Promise<SkillOpResult> =>
  api.invoke(IPC.SKILL_INSTALL_FILE) as Promise<SkillOpResult>

export const installSkillFromUrl = (url: string): Promise<SkillOpResult> =>
  api.invoke(IPC.SKILL_INSTALL_URL, url) as Promise<SkillOpResult>

export const installSkillFromMarket = (id: string): Promise<SkillOpResult> =>
  api.invoke(IPC.SKILL_INSTALL_MARKET, id) as Promise<SkillOpResult>

export const uninstallSkill = (id: string): Promise<{ ok: boolean }> =>
  api.invoke(IPC.SKILL_UNINSTALL, id) as Promise<{ ok: boolean }>

export const fetchMarketSkills = (): Promise<{ ok: boolean; skills: MarketSkillItem[]; error?: string }> =>
  api.invoke(IPC.SKILL_MARKET_LIST) as Promise<{ ok: boolean; skills: MarketSkillItem[]; error?: string }>

// ── 定时任务（Phase 3：补充 Agent Cron 控制面） ─────────────
/** 中止单个正在运行的执行（Agent / shell 通用） */
export const stopScheduledExecution = (executionId: string): Promise<{ ok: boolean }> =>
  api.invoke(IPC.SCHEDULER_STOP_TASK, executionId) as Promise<{ ok: boolean }>

/** 查询当前正在运行的执行 */
export const listRunningExecutions = (): Promise<Array<{ executionId: string; kind: 'shell' | 'agent' }>> =>
  api.invoke(IPC.SCHEDULER_RUNNING) as Promise<Array<{ executionId: string; kind: 'shell' | 'agent' }>>

/** 自然语言 → 任务草稿（前端编辑后再保存） */
export const parseTaskFromNL = (
  text: string,
): Promise<{ ok: boolean; task?: Partial<ScheduledTask> & { name: string; userInput?: string }; error?: string }> =>
  api.invoke(IPC.SCHEDULER_PARSE_NL, text) as Promise<{
    ok: boolean
    task?: Partial<ScheduledTask> & { name: string; userInput?: string }
    error?: string
  }>

/** 订阅任务状态变化（运行中/成功/失败），用于 UI 实时高亮 */
export function useOnSchedulerTaskUpdate(cb: (payload: { taskId: string; status: 'running' | 'success' | 'failed' }) => void) {
  useEffect(() => {
    const cleanup = api.on(IPC.SCHEDULER_TASK_UPDATE, cb as (...args: unknown[]) => void)
    return cleanup
  }, [cb])
}

/** 订阅任务列表 CRUD 变化（Agent 在对话里创建/删除/启停时也会触发），用于 UI 立即 reload */
export function useOnSchedulerTasksChanged(cb: (payload: { action: 'create' | 'update' | 'delete' | 'toggle'; taskId?: string }) => void) {
  useEffect(() => {
    const cleanup = api.on(IPC.SCHEDULER_TASKS_CHANGED, cb as (...args: unknown[]) => void)
    return cleanup
  }, [cb])
}

/** 订阅 Agent 全局活跃状态变化（0↔>0），主窗口据此切小猫 busy/idle 动画 */
export function useOnAgentActiveChanged(cb: (payload: { active: boolean; count: number }) => void) {
  useEffect(() => {
    const cleanup = api.on(IPC.AGENT_ACTIVE_CHANGED, cb as (...args: unknown[]) => void)
    return cleanup
  }, [cb])
}

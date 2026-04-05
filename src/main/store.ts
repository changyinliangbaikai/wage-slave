/**
 * 本地数据读写模块
 * 所有文件存储于 %APPDATA%/xiao-niu-ma/
 * 采用"写临时文件→重命名"原子写入，防止写入中断损坏数据
 */

import { app } from 'electron'
import fs from 'fs'
import path from 'path'
import type { AppConfig, DailyLog, TodoItem } from '@shared/types'

// ── 目录结构 ──────────────────────────────────
const BASE_DIR = path.join(app.getPath('userData'))
const LOGS_DIR = path.join(BASE_DIR, 'logs')
const TODOS_DIR = path.join(BASE_DIR, 'todos')
const CONFIG_FILE = path.join(BASE_DIR, 'config.json')
const STATE_FILE = path.join(BASE_DIR, 'state.json')  // 每日触发状态

// 确保目录存在
;[BASE_DIR, LOGS_DIR, TODOS_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
})

// ── 原子写入 ──────────────────────────────────
function atomicWrite(filePath: string, data: unknown): void {
  const tmp = filePath + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8')
  fs.renameSync(tmp, filePath)
}

function readJSON<T>(filePath: string, fallback: T): T {
  try {
    if (!fs.existsSync(filePath)) return fallback
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T
  } catch {
    return fallback
  }
}

// ── 默认配置 ──────────────────────────────────
const DEFAULT_CONFIG: AppConfig = {
  work_start: '09:00',
  work_end: '18:00',
  focus_threshold_min: 30,
  away_threshold_min: 5,
  snooze_min: 10,
  llm_api_url: 'https://api.openai.com/v1',
  llm_model: 'gpt-4o',
  auto_launch: false,
  cat_position: { x: -1, y: -1 },  // -1 表示使用默认位置（屏幕右下角）
  cat_hidden: false,
  summary_export_docx: false,
  summary_export_dir: '',
}

// ── 配置 ──────────────────────────────────────
export function getConfig(): AppConfig {
  return { ...DEFAULT_CONFIG, ...readJSON<Partial<AppConfig>>(CONFIG_FILE, {}) }
}

export function setConfig(config: Partial<AppConfig>): AppConfig {
  const current = getConfig()
  const updated = { ...current, ...config }
  atomicWrite(CONFIG_FILE, updated)
  return updated
}

// ── 每日触发状态 ──────────────────────────────
interface DailyState {
  morning_triggered_date: string  // YYYY-MM-DD
  evening_triggered_date: string
}

const DEFAULT_STATE: DailyState = {
  morning_triggered_date: '',
  evening_triggered_date: '',
}

export function getDailyState(): DailyState {
  return { ...DEFAULT_STATE, ...readJSON<Partial<DailyState>>(STATE_FILE, {}) }
}

export function setDailyState(state: Partial<DailyState>): void {
  const current = getDailyState()
  atomicWrite(STATE_FILE, { ...current, ...state })
}

// ── 工作日志 ──────────────────────────────────
export function getLog(date: string): DailyLog | null {
  const file = path.join(LOGS_DIR, `${date}.json`)
  return readJSON<DailyLog | null>(file, null)
}

export function saveLog(log: Partial<DailyLog> & { date: string }): DailyLog {
  const file = path.join(LOGS_DIR, `${log.date}.json`)
  const existing = readJSON<DailyLog | null>(file, null)
  const updated: DailyLog = {
    date: log.date,
    plan_input: '',
    todos: [],
    morning_skipped: false,
    eod_log: '',
    created_at: existing?.created_at ?? new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...existing,
    ...log,
  }
  atomicWrite(file, updated)
  return updated
}

/** 读取指定日期范围内的所有日志（用于生成总结） */
export function getLogsInRange(startDate: string, endDate: string): DailyLog[] {
  const logs: DailyLog[] = []
  if (!fs.existsSync(LOGS_DIR)) return logs

  const files = fs.readdirSync(LOGS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace('.json', ''))
    .filter(d => d >= startDate && d <= endDate)
    .sort()

  for (const date of files) {
    const log = getLog(date)
    if (log) logs.push(log)
  }
  return logs
}

// ── 待办清单 ──────────────────────────────────
export function getTodos(date: string): TodoItem[] {
  const file = path.join(TODOS_DIR, `${date}.json`)
  return readJSON<TodoItem[]>(file, [])
}

export function saveTodos(date: string, todos: TodoItem[]): void {
  const file = path.join(TODOS_DIR, `${date}.json`)
  atomicWrite(file, todos)
}

export function todayStr(): string {
  return new Date().toISOString().slice(0, 10)
}

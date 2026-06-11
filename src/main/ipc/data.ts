/**
 * 日志/待办与 LLM 数据服务 IPC 注册
 */

import { ipcMain, dialog } from 'electron'
import { IPC } from '@shared/ipc-channels'
import {
  getLog, saveLog,
  getTodos, saveTodos,
  getLogsInRange, todayStr,
  getConfig,
} from '../store'
import { parsePlan, generateSummary } from '../llm-service'
import { exportSummaryDocx } from '../docx-export'
import { getMainWindow } from '../windows'
import type { DailyLog, TodoItem } from '@shared/types'

// ── 尝试加载 keytar ──────────────────────────────
let keytar: typeof import('keytar') | null = null
try {
  keytar = require('keytar')
} catch {
  // 降级由 config.ts 控制警告
}

const KEYTAR_SERVICE = 'xiao-niu-ma'
const KEYTAR_ACCOUNT = 'llm-api-key'

async function getApiKey(): Promise<string> {
  if (keytar) {
    return await keytar.getPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT) ?? ''
  }
  return ''
}

export function registerDataIPC(): void {
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

  // ── LLM 调用（在主进程执行，绕过 CORS）───────
  ipcMain.handle(IPC.LLM_PARSE_PLAN, async (_e, input: string) => {
    const apiKey = await getApiKey()
    return parsePlan(input, apiKey)
  })

  ipcMain.handle(IPC.LLM_SUMMARY, async (_e, { logs, periodLabel }: { logs: DailyLog[]; periodLabel: string }) => {
    const apiKey = await getApiKey()
    const win = getMainWindow()
    const result = await generateSummary(logs, periodLabel, apiKey, (accumulated) => {
      // 流式推送到渲染进程
      win?.webContents.send(IPC.LLM_SUMMARY_STREAM, accumulated)
    })
    return result
  })

  // ── 目录选择器 ──────────────────────────────
  ipcMain.handle(IPC.SELECT_DIRECTORY, async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      title: '选择工作总结导出目录',
    })
    if (result.canceled || result.filePaths.length === 0) return ''
    return result.filePaths[0]
  })

  // ── 导出总结为 Word ──────────────────────────
  ipcMain.handle(IPC.EXPORT_SUMMARY_DOCX, async (_e, { text, periodLabel }: { text: string; periodLabel: string }) => {
    try {
      const config = getConfig()
      if (!config.summary_export_dir) {
        return { ok: false, error: '未设置导出目录，请在设置中配置' }
      }
      const filePath = await exportSummaryDocx(text, periodLabel, config.summary_export_dir)
      return { ok: true, filePath }
    } catch (e: unknown) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })
}

/**
 * IPC 处理器注册
 * 所有 renderer → main 的请求在这里统一处理
 */

import { ipcMain, app, dialog } from 'electron'
import { IPC } from '@shared/ipc-channels'
import {
  getConfig, setConfig,
  getLog, saveLog,
  getTodos, saveTodos,
  getLogsInRange, todayStr,
} from './store'
import { openSettingsWindow, showMainWindow, openLogWindow, openToolWindow } from './windows'
import { snoozeBreak, resetContinuousTime } from './activity-monitor'
import { parsePlan, generateSummary } from './llm-service'
import { exportSummaryDocx } from './docx-export'
import { getMainWindow } from './windows'
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
      try {
        // 开发模式下 macOS 不允许未签名应用注册登录项，静默忽略
        if (app.isPackaged) {
          app.setLoginItemSettings({ openAtLogin: config.auto_launch ?? false })
        }
      } catch {
        console.warn('[IPC] 设置开机自启失败（开发模式下正常）')
      }
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

  // 测试 API 连通性（用 chat/completions 发最小请求，兼容所有 OpenAI 格式服务商）
  ipcMain.handle(IPC.API_TEST, async (_e, { url, key, model }: { url: string; key: string; model: string }) => {
    try {
      const baseUrl = url.replace(/\/$/, '')
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${key}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 1,
        }),
        signal: AbortSignal.timeout(15000),
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        const brief = text.slice(0, 120)
        return { ok: false, error: `HTTP ${res.status}${brief ? ': ' + brief : ''}` }
      }
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

  ipcMain.on(IPC.OPEN_LOGS, () => openLogWindow())

  ipcMain.on(IPC.OPEN_TOOLS, () => openToolWindow())

  // ── 休息提醒交互 ──────────────────────────────
  ipcMain.on(IPC.SNOOZE_BREAK, (_e, minutes: number) => snoozeBreak(minutes))
  ipcMain.on(IPC.BREAK_DONE, () => resetContinuousTime())

  ipcMain.on('renderer:break-done', () => resetContinuousTime())

  // ── LLM 调用（在主进程执行，绕过 CORS）───────
  ipcMain.handle(IPC.LLM_PARSE_PLAN, async (_e, input: string) => {
    const apiKey = keytar
      ? (await keytar.getPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT) ?? '')
      : ''
    return parsePlan(input, apiKey)
  })

  ipcMain.handle(IPC.LLM_SUMMARY, async (_e, { logs, periodLabel }: { logs: DailyLog[]; periodLabel: string }) => {
    const apiKey = keytar
      ? (await keytar.getPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT) ?? '')
      : ''
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

  // ── 小工具：打开文件选择对话框 ──────────────
  ipcMain.handle(IPC.TOOLS_OPEN_FILE_DIALOG, async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [
        { name: '文本文件', extensions: ['txt', 'md', 'docx', 'doc'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    })
    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false, canceled: true }
    }
    return { ok: true, filePath: result.filePaths[0] }
  })

  // ── 小工具：读取文件 ─────────────────────────
  ipcMain.handle(IPC.TOOLS_READ_FILE, async (_e, filePath: string) => {
    try {
      const { readFileContent } = await import('./tools/spell-check')
      const result = await readFileContent(filePath)
      return { ok: true, ...result }
    } catch (e: unknown) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  // ── 小工具：错别字检查 ───────────────────────
  ipcMain.handle(IPC.TOOLS_SPELL_CHECK, async (_e, { text, stream }: { text: string; stream?: boolean }) => {
    try {
      const { spellCheck } = await import('./tools/spell-check')
      const win = getMainWindow()

      if (stream && win) {
        // 流式模式
        return await spellCheck(text, (accumulated) => {
          win.webContents.send('main:tools-spell-check-chunk', accumulated)
        })
      } else {
        // 非流式模式
        return await spellCheck(text)
      }
    } catch (e: unknown) {
      return { errors: [], error: e instanceof Error ? e.message : String(e) }
    }
  })

  // ── 定时任务 ──────────────────────────────────
  ipcMain.handle(IPC.SCHEDULER_LIST_TASKS, async () => {
    const { listTasks } = await import('./tools/task-scheduler')
    return listTasks()
  })

  ipcMain.handle(IPC.SCHEDULER_SAVE_TASK, async (_e, task) => {
    const { saveTask } = await import('./tools/task-scheduler')
    return saveTask(task)
  })

  ipcMain.handle(IPC.SCHEDULER_DELETE_TASK, async (_e, taskId: string) => {
    const { deleteTask } = await import('./tools/task-scheduler')
    return deleteTask(taskId)
  })

  ipcMain.handle(IPC.SCHEDULER_TOGGLE_TASK, async (_e, taskId: string) => {
    const { toggleTask } = await import('./tools/task-scheduler')
    return toggleTask(taskId)
  })

  ipcMain.handle(IPC.SCHEDULER_RUN_TASK, async (_e, taskId: string) => {
    const { runTask } = await import('./tools/task-scheduler')
    try {
      return { ok: true, execution: runTask(taskId) }
    } catch (e: unknown) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle(IPC.SCHEDULER_GET_LOGS, async (_e, taskId: string) => {
    const { getTaskLogs } = await import('./tools/task-scheduler')
    return getTaskLogs(taskId)
  })

  ipcMain.handle(IPC.SCHEDULER_CLEAR_LOGS, async (_e, taskId: string) => {
    const { clearTaskLogs } = await import('./tools/task-scheduler')
    clearTaskLogs(taskId)
    return { ok: true }
  })

  ipcMain.handle(IPC.SCHEDULER_SELECT_DIR, async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      title: '选择任务工作目录',
    })
    if (result.canceled || result.filePaths.length === 0) return ''
    return result.filePaths[0]
  })
}

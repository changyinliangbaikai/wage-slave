/**
 * 普通任务调度器 IPC 注册
 */

import { ipcMain, dialog } from 'electron'
import { IPC } from '@shared/ipc-channels'

export function registerSchedulerIPC(): void {
  // ── 定时任务 ──────────────────────────────────
  ipcMain.handle(IPC.SCHEDULER_LIST_TASKS, async () => {
    const { listTasks } = await import('../tools/task-scheduler')
    return listTasks()
  })

  ipcMain.handle(IPC.SCHEDULER_SAVE_TASK, async (_e, task) => {
    const { saveTask } = await import('../tools/task-scheduler')
    return saveTask(task)
  })

  ipcMain.handle(IPC.SCHEDULER_DELETE_TASK, async (_e, taskId: string) => {
    const { deleteTask } = await import('../tools/task-scheduler')
    return deleteTask(taskId)
  })

  ipcMain.handle(IPC.SCHEDULER_TOGGLE_TASK, async (_e, taskId: string) => {
    const { toggleTask } = await import('../tools/task-scheduler')
    return toggleTask(taskId)
  })

  ipcMain.handle(IPC.SCHEDULER_RUN_TASK, async (_e, taskId: string) => {
    const { runTask } = await import('../tools/task-scheduler')
    try {
      return { ok: true, execution: runTask(taskId) }
    } catch (e: unknown) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  // 中止单个 shell 任务执行
  ipcMain.handle(IPC.SCHEDULER_STOP_TASK, async (_e, executionId: string) => {
    const { stopRunningTask } = await import('../tools/task-scheduler')
    const ok = stopRunningTask(executionId)
    return { ok }
  })

  // 查询当前正在运行 of 执行列表
  ipcMain.handle(IPC.SCHEDULER_RUNNING, async () => {
    const { listRunningExecutions } = await import('../tools/task-scheduler')
    return listRunningExecutions()
  })

  // 自然语言 → ScheduledTask（依赖已配置的 LLM API Key）
  ipcMain.handle(IPC.SCHEDULER_PARSE_NL, async (_e, naturalText: string) => {
    try {
      if (!naturalText || typeof naturalText !== 'string') {
        return { ok: false, error: '输入文本为空' }
      }
      const { parseNaturalLanguageToTask } = await import('../tools/task-nl-parser')
      const task = await parseNaturalLanguageToTask(naturalText.trim())
      console.log('[IPC] 自然语言解析任务成功:', task.name, task.kind ?? 'shell')
      return { ok: true, task }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error('[IPC] 自然语言解析失败:', msg)
      return { ok: false, error: msg }
    }
  })

  ipcMain.handle(IPC.SCHEDULER_GET_LOGS, async (_e, taskId: string) => {
    const { getTaskLogs } = await import('../tools/task-scheduler')
    return getTaskLogs(taskId)
  })

  ipcMain.handle(IPC.SCHEDULER_CLEAR_LOGS, async (_e, taskId: string) => {
    const { clearTaskLogs } = await import('../tools/task-scheduler')
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

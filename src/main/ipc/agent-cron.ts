/**
 * Agent Cron 调度器相关的 IPC 注册
 */

import { ipcMain } from 'electron'
import { IPC } from '@shared/ipc-channels'
import { openAgentCronWindow } from '../windows'
import { AGENT_CRON_TEMPLATES } from '../agent/cron/built-in-templates'
import {
  deleteAgentCron,
  listAgentCrons,
  runAgentCronNow,
  saveAgentCron,
  toggleAgentCron,
} from '../agent/cron/scheduler'
import { migrateScheduledTasksToAgentCrons } from '../agent/cron/migration'
import { registerAttachmentIPC } from '../ipc-handlers-attachment'

export function registerAgentCronIPC(): void {
  ipcMain.on(IPC.AGENT_CRON_OPEN_WINDOW, () => openAgentCronWindow())
  ipcMain.handle(IPC.AGENT_CRON_LIST, () => listAgentCrons())
  ipcMain.handle(IPC.AGENT_CRON_TEMPLATES, () => AGENT_CRON_TEMPLATES)
  ipcMain.handle(IPC.AGENT_CRON_SAVE, (_e, cron) => {
    try {
      return { ok: true, cron: saveAgentCron(cron) }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })
  ipcMain.handle(IPC.AGENT_CRON_DELETE, (_e, id: string) => ({ ok: deleteAgentCron(id) }))
  ipcMain.handle(IPC.AGENT_CRON_TOGGLE, (_e, id: string) => {
    const cron = toggleAgentCron(id)
    return cron ? { ok: true, cron } : { ok: false, error: '任务不存在' }
  })
  ipcMain.handle(IPC.AGENT_CRON_RUN_NOW, (_e, id: string) => {
    try {
      return { ok: true, execution: runAgentCronNow(id) }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })
  ipcMain.handle(IPC.AGENT_CRON_MIGRATE, (_e, params?: { taskIds?: string[]; disableOriginal?: boolean }) => {
    try {
      return { ok: true, ...migrateScheduledTasksToAgentCrons(params) }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  // 注册文件附件 IPC 处理器（跟随 cron 一同被挂载注册）
  registerAttachmentIPC()
}

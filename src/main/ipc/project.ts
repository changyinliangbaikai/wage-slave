/**
 * 项目（Project）管理 IPC
 *
 * 暴露给渲染端的能力：
 *  - 列出 / 新建 / 重命名 / 删除项目
 *  - 打开本地目录选择器（让用户挑选已有目录关联为项目）
 *
 * 删除项目时把归属该项目的所有 Agent 会话 projectId 重置为 'default'，
 * 物理目录保持不动，避免误删用户文件。
 */

import { dialog, ipcMain, BrowserWindow } from 'electron'
import log from 'electron-log/main'
import { IPC } from '@shared/ipc-channels'
import type { Project } from '@shared/types-project'
import {
  listProjects,
  createProject,
  renameProject,
  deleteProject,
  getProject,
  togglePinProject,
} from '../chat/project-store'
import { reassignSessionsToDefault } from '../agent/session-store'

function broadcastProjectChanged(): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(IPC.PROJECT_CHANGED)
  }
}

export function registerProjectIPC(): void {
  ipcMain.handle(IPC.PROJECT_LIST, (): Project[] => {
    return listProjects()
  })

  ipcMain.handle(IPC.PROJECT_CREATE, async (_e, input: { name: string; path?: string; createDir?: boolean }) => {
    try {
      const project = createProject(input)
      broadcastProjectChanged()
      return { ok: true, project }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      log.warn('[ProjectIPC] 创建项目失败:', msg)
      return { ok: false, error: msg }
    }
  })

  ipcMain.handle(IPC.PROJECT_RENAME, (_e, params: { id: string; name: string }) => {
    const ok = renameProject(params.id, params.name)
    if (ok) broadcastProjectChanged()
    return { ok }
  })

  ipcMain.handle(IPC.PROJECT_DELETE, (_e, id: string) => {
    const project = getProject(id)
    const ok = deleteProject(id)
    if (ok && project) {
      // 删除该项目下的所有会话
      const { deleteSessionsByProject } = require('../chat/chat-store')
      deleteSessionsByProject(id)
    }
    if (ok) broadcastProjectChanged()
    return { ok }
  })

  ipcMain.handle(IPC.PROJECT_PICK_DIR, async () => {
    const result = await dialog.showOpenDialog({
      title: '选择项目目录',
      properties: ['openDirectory', 'createDirectory'],
    })
    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false, canceled: true }
    }
    return { ok: true, path: result.filePaths[0] }
  })

  ipcMain.handle(IPC.PROJECT_TOGGLE_PIN, (_e, id: string) => {
    const ok = togglePinProject(id)
    if (ok) broadcastProjectChanged()
    return { ok }
  })

  ipcMain.handle(IPC.PROJECT_SHOW_IN_EXPLORER, async (_e, id: string) => {
    const project = getProject(id)
    if (!project) return { ok: false, error: '项目不存在' }
    try {
      const { shell } = require('electron')
      const fs = require('fs')
      if (fs.existsSync(project.path)) {
        shell.showItemInFolder(project.path)
        return { ok: true }
      } else {
        return { ok: false, error: '目录不存在' }
      }
    } catch (e) {
      return { ok: false, error: String(e) }
    }
  })
}

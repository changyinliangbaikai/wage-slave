/**
 * 小工具模块 - 主进程入口
 * 路由分发工具相关的 IPC 调用
 */

import { ipcMain, dialog } from 'electron'
import { IPC } from '@shared/ipc-channels'
import { readFileContent } from './spell-check'

/**
 * 注册所有工具相关的 IPC handler
 */
export function registerToolHandlers() {
  // 读取本地文件
  ipcMain.handle(IPC.TOOLS_READ_FILE, async (_event, filePath: string) => {
    try {
      const result = await readFileContent(filePath)
      return { ok: true, ...result }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { ok: false, error: msg }
    }
  })

  // 打开文件选择对话框
  ipcMain.handle('renderer:tools-open-file-dialog', async () => {
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
}

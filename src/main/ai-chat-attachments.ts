/**
 * AI 对话附件处理（兼容旧通道）
 *
 * - 打开多选文件对话框 + 读取：AI_CHAT_PICK_ATTACHMENTS
 * - 按路径读取（拖拽场景）：AI_CHAT_READ_ATTACHMENTS
 *
 * 现在使用新的 FileAttachmentService 以支持更多格式
 */

import { ipcMain } from 'electron'
import { IPC } from '@shared/ipc-channels'
import { fileAttachmentService } from './file-attachment/service'

export function registerAIChatAttachmentHandlers() {
  // 打开多选文件对话框 + 批量读取（使用新的服务）
  ipcMain.handle(IPC.AI_CHAT_PICK_ATTACHMENTS, async () => {
    return await fileAttachmentService.pickAttachmentsFromDialog()
  })

  // 按路径读取（拖拽场景，使用新的服务）
  ipcMain.handle(IPC.AI_CHAT_READ_ATTACHMENTS, async (_e, paths: string[]) => {
    if (!Array.isArray(paths) || paths.length === 0) {
      return { ok: true, attachments: [], errors: [], warnings: [] }
    }
    return await fileAttachmentService.readAttachments(paths)
  })

  console.log('[AIChatAttachments] 使用新的 FileAttachmentService 注册完成')
}

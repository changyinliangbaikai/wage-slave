/**
 * 文件附件 IPC 处理器
 *
 * 处理与文件上传相关的所有 IPC 请求
 */

import { ipcMain } from 'electron'
import { IPC } from '@shared/ipc-channels'
import { fileAttachmentService } from './file-attachment/service'
import type { AttachmentReadResult } from '@shared/types'

export function registerAttachmentIPC(): void {
  // ═══════════════════════════════════════════════
  // 新通道：统一的附件系统
  // ═══════════════════════════════════════════════

  // 从文件选择器读取附件
  ipcMain.handle(IPC.ATTACHMENT_PICK, async (): Promise<AttachmentReadResult> => {
    try {
      return await fileAttachmentService.pickAttachmentsFromDialog()
    } catch (error) {
      console.error('[AttachmentIPC] 选择附件失败:', error)
      return {
        ok: false,
        attachments: [],
        errors: [{ fileName: '', error: String(error), code: 'UNKNOWN' }],
        warnings: [],
      }
    }
  })

  // 从文件路径读取附件（用于拖拽）
  ipcMain.handle(IPC.ATTACHMENT_READ, async (_, filePaths: string[]): Promise<AttachmentReadResult> => {
    try {
      if (!Array.isArray(filePaths) || filePaths.length === 0) {
        return { ok: true, attachments: [], errors: [], warnings: [] }
      }
      return await fileAttachmentService.readAttachments(filePaths)
    } catch (error) {
      console.error('[AttachmentIPC] 读取附件失败:', error)
      return {
        ok: false,
        attachments: [],
        errors: [{ fileName: '', error: String(error), code: 'UNKNOWN' }],
        warnings: [],
      }
    }
  })

  // 注意：AI_CHAT_PICK_ATTACHMENTS 和 AI_CHAT_READ_ATTACHMENTS
  // 由 ai-chat-attachments.ts 中的 registerAIChatAttachmentHandlers() 注册
  // 避免重复注册

  console.log('[AttachmentIPC] 文件附件 IPC 处理器已注册（新通道 ATTACHMENT_PICK/ATTACHMENT_READ）')
}

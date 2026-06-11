/**
 * 文件附件管理 Hook
 *
 * 快速对话和 Agent 模式通用
 */

import { useState, useCallback } from 'react'
import { IPC } from '@shared/ipc-channels'
import type { AIChatAttachment, AttachmentReadResult } from '@shared/types'

const api = window.electronAPI

export interface UseFileAttachmentsResult {
  // 状态
  attachments: AIChatAttachment[]
  isReading: boolean
  lastErrors: AttachmentReadResult['errors']
  lastWarnings: AttachmentReadResult['warnings']

  // 操作
  pickFiles: () => Promise<void>
  addFilesFromDrop: (files: FileList | null) => Promise<void>
  removeAttachment: (id: string) => void
  clearAttachments: () => void
  clearErrors: () => void
}

export function useFileAttachments(): UseFileAttachmentsResult {
  const [attachments, setAttachments] = useState<AIChatAttachment[]>([])
  const [isReading, setIsReading] = useState(false)
  const [lastErrors, setLastErrors] = useState<AttachmentReadResult['errors']>([])
  const [lastWarnings, setLastWarnings] = useState<AttachmentReadResult['warnings']>([])

  /**
   * 打开文件选择器
   */
  const pickFiles = useCallback(async () => {
    setIsReading(true)
    setLastErrors([])
    setLastWarnings([])

    try {
      const result = (await api.invoke(IPC.ATTACHMENT_PICK)) as AttachmentReadResult

      if (result.attachments.length > 0) {
        setAttachments(prev => [...prev, ...result.attachments])
      }

      if (result.errors.length > 0) {
        setLastErrors(result.errors)
      }

      if (result.warnings.length > 0) {
        setLastWarnings(result.warnings)
      }
    } catch (error) {
      console.error('[useFileAttachments] 选择文件失败:', error)
      setLastErrors([{ fileName: '', error: String(error), code: 'UNKNOWN' }])
    } finally {
      setIsReading(false)
    }
  }, [])

  /**
   * 处理拖拽文件
   * 注意：在 Electron 中，File 对象通过 webUtils.getPathForFile 获取路径
   */
  const addFilesFromDrop = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return

    // 在 Electron 中，从 File 对象获取路径
    // 需要 renderer 进程通过 IPC 将 File 对象传给主进程
    // 或者 File 对象本身带有 path 属性（Electron 特性）
    const filePaths: string[] = []

    for (let i = 0; i < files.length; i++) {
      const file = files[i] as File & { path?: string }
      if (file.path) {
        filePaths.push(file.path)
      }
    }

    if (filePaths.length === 0) {
      console.warn('[useFileAttachments] 无法获取文件路径')
      return
    }

    setIsReading(true)
    setLastErrors([])
    setLastWarnings([])

    try {
      const result = (await api.invoke(IPC.ATTACHMENT_READ, filePaths)) as AttachmentReadResult

      if (result.attachments.length > 0) {
        setAttachments(prev => [...prev, ...result.attachments])
      }

      if (result.errors.length > 0) {
        setLastErrors(result.errors)
      }

      if (result.warnings.length > 0) {
        setLastWarnings(result.warnings)
      }
    } catch (error) {
      console.error('[useFileAttachments] 读取拖拽文件失败:', error)
      setLastErrors([{ fileName: '', error: String(error), code: 'UNKNOWN' }])
    } finally {
      setIsReading(false)
    }
  }, [])

  /**
   * 移除单个附件
   */
  const removeAttachment = useCallback((id: string) => {
    setAttachments(prev => prev.filter(a => a.id !== id))
  }, [])

  /**
   * 清空所有附件
   */
  const clearAttachments = useCallback(() => {
    setAttachments([])
    setLastErrors([])
    setLastWarnings([])
  }, [])

  /**
   * 清空错误信息
   */
  const clearErrors = useCallback(() => {
    setLastErrors([])
    setLastWarnings([])
  }, [])

  return {
    attachments,
    isReading,
    lastErrors,
    lastWarnings,
    pickFiles,
    addFilesFromDrop,
    removeAttachment,
    clearAttachments,
    clearErrors,
  }
}

/**
 * AI 对话附件处理
 *
 * - 打开多选文件对话框 + 读取：AI_CHAT_PICK_ATTACHMENTS
 * - 按路径读取（拖拽场景）：AI_CHAT_READ_ATTACHMENTS
 *
 * 支持的格式：txt / md / docx / doc（复用 spell-check 的 readFileContent）
 * 单文件文本超过 MAX_CHARS 时自动截断，并在返回结果中标记 truncated=true
 */

import * as fs from 'fs'
import { ipcMain, dialog } from 'electron'
import { IPC } from '@shared/ipc-channels'
import type { AIChatAttachment } from '@shared/types'
import { readFileContent } from './tools/spell-check'

// 单附件最大字符数（超过会被截断）
const MAX_CHARS = 50000
// 单次最多附件数
const MAX_FILES = 10

const ALLOWED_EXTS = ['txt', 'md', 'docx', 'doc'] as const

/** 由 readFileContent 的返回结构构造 AIChatAttachment */
async function buildAttachmentFromPath(filePath: string): Promise<AIChatAttachment> {
  // 文件大小（无法读取时用 content 长度兜底）
  let sizeBytes = 0
  try {
    sizeBytes = fs.statSync(filePath).size
  } catch (e) {
    console.warn('[AIChatAttachments] 读取文件大小失败:', filePath, e)
  }

  const { fileName, content: rawContent, fileType } = await readFileContent(filePath)
  const charCount = rawContent.length
  let content = rawContent
  let truncated = false
  if (charCount > MAX_CHARS) {
    content = rawContent.slice(0, MAX_CHARS)
    truncated = true
  }

  // 类型归一化（防止 readFileContent 返回非预期值）
  const ft = (ALLOWED_EXTS as readonly string[]).includes(fileType) ? fileType : 'txt'

  return {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    fileName,
    fileType: ft as AIChatAttachment['fileType'],
    sizeBytes,
    content,
    charCount,
    truncated,
  }
}

export function registerAIChatAttachmentHandlers() {
  // 打开多选文件对话框 + 批量读取
  ipcMain.handle(IPC.AI_CHAT_PICK_ATTACHMENTS, async () => {
    const result = await dialog.showOpenDialog({
      title: '选择附件（可多选）',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '文档', extensions: [...ALLOWED_EXTS] },
        { name: '所有文件', extensions: ['*'] },
      ],
    })

    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false, canceled: true, attachments: [] as AIChatAttachment[] }
    }

    const paths = result.filePaths.slice(0, MAX_FILES)
    const attachments: AIChatAttachment[] = []
    const errors: Array<{ fileName: string; error: string }> = []

    for (const fp of paths) {
      try {
        attachments.push(await buildAttachmentFromPath(fp))
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        const fileName = fp.split(/[\\/]/).pop() || fp
        console.error('[AIChatAttachments] 读取失败:', fp, msg)
        errors.push({ fileName, error: msg })
      }
    }

    console.log(`[AIChatAttachments] 选取 ${paths.length} 个文件，成功 ${attachments.length}，失败 ${errors.length}`)
    return { ok: true, attachments, errors }
  })

  // 按路径读取（渲染层已有 path，比如 drag-drop 场景）
  ipcMain.handle(IPC.AI_CHAT_READ_ATTACHMENTS, async (_e, paths: string[]) => {
    if (!Array.isArray(paths) || paths.length === 0) {
      return { ok: true, attachments: [] as AIChatAttachment[], errors: [] }
    }

    const capped = paths.slice(0, MAX_FILES)
    const attachments: AIChatAttachment[] = []
    const errors: Array<{ fileName: string; error: string }> = []

    for (const fp of capped) {
      try {
        attachments.push(await buildAttachmentFromPath(fp))
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        const fileName = fp.split(/[\\/]/).pop() || fp
        console.error('[AIChatAttachments] 拖拽读取失败:', fp, msg)
        errors.push({ fileName, error: msg })
      }
    }

    console.log(`[AIChatAttachments] 拖拽读取 ${capped.length} 个文件，成功 ${attachments.length}，失败 ${errors.length}`)
    return { ok: true, attachments, errors }
  })
}

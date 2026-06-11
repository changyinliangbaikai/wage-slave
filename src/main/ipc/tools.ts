/**
 * 桌面辅助小工具 IPC 注册
 */

import { ipcMain, dialog, shell, app } from 'electron'
import { IPC } from '@shared/ipc-channels'
import * as path from 'path'
import * as fs from 'fs'
import log from 'electron-log/main'

export function registerToolsIPC(): void {
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
      const { readFileContent } = await import('../tools/spell-check')
      const result = await readFileContent(filePath)
      return { ok: true, ...result }
    } catch (e: unknown) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  // ── 小工具：错别字检查 ───────────────────────
  // 当前活跃的 AbortController，供"取消检查" IPC 调用
  let spellCheckCtrl: AbortController | null = null

  ipcMain.handle(IPC.TOOLS_SPELL_CHECK, async (event, { text, stream }: { text: string; stream?: boolean }) => {
    try {
      const { spellCheck } = await import('../tools/spell-check')
      // 用调用方所在的窗口推送流式增量，避免 getMainWindow 在 toolsWindow 场景下错位
      const senderWin = event.sender
      // 如果上一次还没结束，先打断
      spellCheckCtrl?.abort()
      spellCheckCtrl = new AbortController()
      const ctrl = spellCheckCtrl

      try {
        if (stream) {
          return await spellCheck(text, (payload) => {
            try {
              if (!senderWin.isDestroyed()) {
                // 推送结构化进度，渲染端可分别展示"思考中 / 接收中"两个阶段
                senderWin.send(IPC.TOOLS_SPELL_CHECK_CHUNK, payload)
              }
            } catch { /* 渲染端已销毁则忽略 */ }
          }, ctrl.signal)
        } else {
          return await spellCheck(text, undefined, ctrl.signal)
        }
      } finally {
        if (spellCheckCtrl === ctrl) spellCheckCtrl = null
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error('[IPC] 错别字检查失败:', msg)
      return { errors: [], error: msg }
    }
  })

  // 取消错别字检查
  ipcMain.handle(IPC.TOOLS_SPELL_CHECK_CANCEL, () => {
    if (spellCheckCtrl) {
      console.log('[IPC] 用户主动取消错别字检查')
      spellCheckCtrl.abort()
      return { ok: true }
    }
    return { ok: false }
  })

  // 打开应用运行日志所在文件夹（便于排查"卡在检查中..."等问题）
  ipcMain.handle(IPC.OPEN_LOG_FILE, async () => {
    try {
      const logPath = log.transports.file.getFile().path
      const logDir = path.dirname(logPath)
      const fileExists = fs.existsSync(logPath)
      const dirExists = fs.existsSync(logDir)
      console.log(
        `[IPC] 打开日志请求 | logPath=${logPath} | fileExists=${fileExists} | dirExists=${dirExists}`,
      )

      // 优先在文件管理器中高亮 main.log；不存在则直接打开日志目录
      if (fileExists) {
        shell.showItemInFolder(logPath)
        return { ok: true, path: logPath }
      }
      if (dirExists) {
        const err = await shell.openPath(logDir)
        if (err) {
          console.error('[IPC] shell.openPath 失败:', err)
          return { ok: false, error: err }
        }
        return { ok: true, path: logDir, hint: '日志文件尚未生成，已打开日志目录' }
      }
      // 极端情况：连目录都没有，回退到 userData
      const userData = app.getPath('userData')
      console.warn('[IPC] 日志目录不存在，回退打开 userData:', userData)
      const err = await shell.openPath(userData)
      if (err) return { ok: false, error: err }
      return { ok: true, path: userData, hint: '日志目录不存在，已打开 userData' }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error('[IPC] 打开日志文件失败:', msg)
      return { ok: false, error: msg }
    }
  })
}

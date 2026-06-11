/**
 * 配置 IPC 注册
 */

import { ipcMain, app } from 'electron'
import { IPC } from '@shared/ipc-channels'
import { getConfig, setConfig } from '../store'
import type { AppConfig } from '@shared/types'

// ── 尝试加载 keytar（安全存储 API Key）──────────
let keytar: typeof import('keytar') | null = null
try {
  keytar = require('keytar')
} catch {
  console.warn('[IPC] keytar 未安装，API Key 将以明文存入 config.json（开发模式）')
}

const KEYTAR_SERVICE = 'xiao-niu-ma'
const KEYTAR_ACCOUNT = 'llm-api-key'

export function registerConfigIPC(): void {
  ipcMain.handle(IPC.CONFIG_GET, () => getConfig())

  ipcMain.handle(IPC.CONFIG_SET, async (_e, config: Partial<AppConfig>) => {
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
    // 动态变更 AI 对话快捷键时重新注册
    if ('ai_chat_hotkey' in config) {
      try {
        const { registerAIChatHotkey } = await import('../index')
        registerAIChatHotkey()
      } catch (e) {
        console.warn('[IPC] 重注册 AI 对话快捷键失败:', e)
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
}

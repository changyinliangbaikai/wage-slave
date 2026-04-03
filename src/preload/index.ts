/**
 * Preload 脚本
 * 在隔离的上下文中暴露安全的 IPC API 给渲染进程
 */

import { contextBridge, ipcRenderer } from 'electron'
import type { IPC } from '@shared/ipc-channels'

type Channel = typeof IPC[keyof typeof IPC]

contextBridge.exposeInMainWorld('electronAPI', {
  /** 渲染进程 → 主进程（有返回值） */
  invoke: (channel: Channel, ...args: unknown[]) =>
    ipcRenderer.invoke(channel, ...args),

  /** 渲染进程 → 主进程（无返回值） */
  send: (channel: Channel, ...args: unknown[]) =>
    ipcRenderer.send(channel, ...args),

  /** 渲染进程 → 主进程（无返回值，任意 channel） */
  sendRaw: (channel: string, ...args: unknown[]) =>
    ipcRenderer.send(channel, ...args),

  /** 监听主进程推送的事件 */
  on: (channel: Channel, listener: (...args: unknown[]) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, ...args: unknown[]) =>
      listener(...args)
    ipcRenderer.on(channel, wrapped)
    // 返回清理函数
    return () => ipcRenderer.removeListener(channel, wrapped)
  },
})

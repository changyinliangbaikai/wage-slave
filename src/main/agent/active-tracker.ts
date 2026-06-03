/**
 * Agent 全局活跃追踪器
 *
 * 维护「当前正在运行的 Agent 任务数量」，在跨越 0↔>0 阈值时广播
 * AGENT_ACTIVE_CHANGED 给所有渲染窗口（主窗口据此让小猫切 busy/idle）。
 *
 * 设计要点：
 *  - 计数模式：支持 AgentChat 与定时 Agent 并发；只在边界切换时广播一次，
 *    避免抖动（同时跑多个 Agent 不会让小猫一直反复切换动画）
 *  - 入口包装：调用方用 try/finally 包裹 `agentActivityStarted/Ended`，
 *    确保异常路径也能正确归零
 *  - 兼容性：模块级状态，热重载/重新打开窗口不会重置（生命周期与主进程一致）
 */

import { BrowserWindow } from 'electron'
import log from 'electron-log/main'
import { IPC } from '@shared/ipc-channels'

/** 当前活跃的 Agent 任务数（包括 AgentChat 对话与 Agent 定时任务） */
let activeCount = 0

/** 把当前状态广播给所有渲染窗口 */
function broadcast(active: boolean): void {
  try {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(IPC.AGENT_ACTIVE_CHANGED, { active, count: activeCount })
      }
    }
  } catch (err) {
    log.warn('[AgentTracker] 广播活跃状态失败:', err)
  }
}

/** 一次 Agent 任务开始时调用 */
export function agentActivityStarted(source: 'chat' | 'cron'): void {
  activeCount++
  log.info(`[AgentTracker] +1 source=${source} count=${activeCount}`)
  // 0 → >0：第一次进入活跃状态，广播 true
  if (activeCount === 1) broadcast(true)
}

/** 一次 Agent 任务结束时调用（成功/失败/中断都要调用） */
export function agentActivityEnded(source: 'chat' | 'cron'): void {
  activeCount = Math.max(0, activeCount - 1)
  log.info(`[AgentTracker] -1 source=${source} count=${activeCount}`)
  // >0 → 0：最后一个 Agent 结束，广播 false
  if (activeCount === 0) broadcast(false)
}

/** 给外部用：查询当前是否有 Agent 在活跃 */
export function isAgentActive(): boolean {
  return activeCount > 0
}

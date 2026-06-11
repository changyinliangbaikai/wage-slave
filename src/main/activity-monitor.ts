/**
 * 键鼠活跃监测模块
 *
 * 依赖 uiohook-napi 库监听全局键鼠事件（仅记录最近输入时间戳，不记录内容）。
 * uiohook-napi 需要 native binding，在 Windows 上使用预编译包，无需手动 rebuild。
 * 如需重新编译：npx electron-rebuild -f -w uiohook-napi
 *
 * ⚠️ 若 uiohook-napi 未安装，自动降级为"始终视为活跃"模式，
 *    功能不受影响，仅休息提醒精度降低。
 */

import { getConfig } from './store'

type BreakCallback = (elapsedMin: number) => void

let lastInputTime = Date.now()
let continuousActiveMs = 0
let lastCheckTime = Date.now()
let onBreak: BreakCallback | null = null
let checkInterval: NodeJS.Timeout | null = null
let snoozedUntil = 0
let hookLoaded = false
let hookInstance: any = null

/** 收到键鼠输入时更新时间戳 */
function onInput(): void {
  const now = Date.now()
  const config = getConfig()
  const awayMs = config.away_threshold_min * 60 * 1000

  if (now - lastInputTime > awayMs) {
    // 离开超过阈值，重置累计活跃时长
    continuousActiveMs = 0
  }
  lastInputTime = now
}

/** 每秒执行：累计活跃时长 & 触发休息提醒 */
function tick(): void {
  const now = Date.now()
  const config = getConfig()
  const awayMs = config.away_threshold_min * 60 * 1000
  const focusMs = config.focus_threshold_min * 60 * 1000
  const dt = now - lastCheckTime
  lastCheckTime = now

  const isActive = (now - lastInputTime) < awayMs || !hookLoaded

  if (isActive) {
    continuousActiveMs += dt
  } else {
    // 用户已离开，重置
    continuousActiveMs = 0
  }

  // 触发休息提醒
  // 注意：触发时不重置 continuousActiveMs。
  // 重置时机由用户行为决定：
  //   - 点"去休息" → IPC BREAK_DONE → resetContinuousTime()
  //   - 点"再等X分钟" → snoozeBreak(x) → snoozedUntil 延迟，continuousActiveMs 保持不变
  //     这样 snooze 到期后的下一个 tick 立即再次触发，实现精确延迟
  if (continuousActiveMs >= focusMs && now >= snoozedUntil) {
    const elapsedMin = Math.floor(continuousActiveMs / 60000)
    // 立即推进 snoozedUntil，防止在用户响应前（毫秒级）重复触发
    snoozedUntil = now + 5000
    onBreak?.(elapsedMin)
  }
}

export function startActivityMonitor(cb: BreakCallback): void {
  onBreak = cb
  lastCheckTime = Date.now()

  // 尝试加载 uiohook-napi
  try {
    const { uIOhook } = require('uiohook-napi')
    uIOhook.on('mousemove', onInput)
    uIOhook.on('keydown', onInput)
    uIOhook.start()
    hookInstance = uIOhook
    hookLoaded = true
    console.log('[ActivityMonitor] uiohook-napi 已启动')
  } catch {
    console.warn('[ActivityMonitor] uiohook-napi 未安装，降级为模拟活跃模式')
    hookLoaded = false
  }

  checkInterval = setInterval(tick, 1000)
}

export function stopActivityMonitor(): void {
  if (checkInterval) {
    clearInterval(checkInterval)
    checkInterval = null
  }
  if (hookInstance) {
    try {
      hookInstance.stop()
    } catch { /* ignore */ }
    hookInstance = null
  }
}

/**
 * 用户点击"再等一会儿"时调用。
 * 只延迟触发时间，不重置 continuousActiveMs。
 * 这样 snoozedUntil 到期后的第一个 tick 因为 continuousActiveMs 仍超阈值，会立即再次提醒。
 */
export function snoozeBreak(minutes: number): void {
  snoozedUntil = Date.now() + minutes * 60 * 1000
}

/**
 * 用户确认去休息时调用。
 * 重置连续工作计时，让用户休息后重新开始计时。
 */
export function resetContinuousTime(): void {
  continuousActiveMs = 0
  snoozedUntil = 0
}

/**
 * 键鼠活跃监测模块
 *
 * 依赖 iohook 库监听全局键鼠事件（仅记录最近输入时间戳，不记录内容）。
 * iohook 需要 native binding，安装方式：
 *   npm install iohook --save
 *   npx electron-rebuild -f -w iohook
 *
 * ⚠️ 开发阶段若 iohook 未安装，自动降级为"始终视为活跃"模式，
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
let iohookLoaded = false

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

  const isActive = (now - lastInputTime) < awayMs || !iohookLoaded

  if (isActive) {
    continuousActiveMs += dt
  } else {
    // 用户已离开，重置
    continuousActiveMs = 0
  }

  // 触发休息提醒
  if (continuousActiveMs >= focusMs && now >= snoozedUntil) {
    const elapsedMin = Math.floor(continuousActiveMs / 60000)
    continuousActiveMs = 0  // 触发后重置，避免重复提醒
    onBreak?.(elapsedMin)
  }
}

export function startActivityMonitor(cb: BreakCallback): void {
  onBreak = cb
  lastCheckTime = Date.now()

  // 尝试加载 iohook
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const iohook = require('iohook')
    iohook.on('mousemove', onInput)
    iohook.on('keydown', onInput)
    iohook.start(false)  // false = 不在日志输出事件
    iohookLoaded = true
    console.log('[ActivityMonitor] iohook 已启动')
  } catch {
    console.warn('[ActivityMonitor] iohook 未安装，降级为模拟活跃模式')
    iohookLoaded = false
  }

  checkInterval = setInterval(tick, 1000)
}

export function stopActivityMonitor(): void {
  if (checkInterval) {
    clearInterval(checkInterval)
    checkInterval = null
  }
  try {
    const iohook = require('iohook')
    iohook.stop()
  } catch { /* ignore */ }
}

/** 用户点击"再等一会儿"时调用 */
export function snoozeBreak(minutes: number): void {
  snoozedUntil = Date.now() + minutes * 60 * 1000
  continuousActiveMs = 0
}

export function resetContinuousTime(): void {
  continuousActiveMs = 0
}

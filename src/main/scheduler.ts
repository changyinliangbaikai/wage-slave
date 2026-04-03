/**
 * 定时触发器
 * 每分钟检查一次当前时间，到达上班/下班时间时触发对应事件
 * 使用 powerMonitor 监听睡眠/唤醒，唤醒后立即补检
 */

import { powerMonitor } from 'electron'
import { getDailyState, setDailyState, getConfig, getLog, todayStr } from './store'

type TriggerCallback = (type: 'morning' | 'evening', date: string, hasTodos: boolean) => void

let intervalId: NodeJS.Timeout | null = null
let onTrigger: TriggerCallback | null = null

/** 解析 "HH:mm" → { hour, minute } */
function parseTime(t: string): { hour: number; minute: number } {
  const [h, m] = t.split(':').map(Number)
  return { hour: h, minute: m }
}

/** 当前时间是否匹配目标时间（精确到分钟） */
function isNow(target: string): boolean {
  const now = new Date()
  const { hour, minute } = parseTime(target)
  return now.getHours() === hour && now.getMinutes() === minute
}

/** 是否为周末 */
function isWeekend(): boolean {
  const day = new Date().getDay()
  return day === 0 || day === 6
}

function check(): void {
  if (isWeekend()) return

  const config = getConfig()
  const state = getDailyState()
  const today = todayStr()

  // 晨间检查
  if (isNow(config.work_start) && state.morning_triggered_date !== today) {
    setDailyState({ morning_triggered_date: today })
    const hasTodos = (getLog(today)?.todos.length ?? 0) > 0
    onTrigger?.('morning', today, hasTodos)
  }

  // 晚间检查
  if (isNow(config.work_end) && state.evening_triggered_date !== today) {
    setDailyState({ evening_triggered_date: today })
    const hasTodos = (getLog(today)?.todos.length ?? 0) > 0
    onTrigger?.('evening', today, hasTodos)
  }
}

export function startScheduler(cb: TriggerCallback): void {
  onTrigger = cb

  // 每分钟检查一次
  intervalId = setInterval(check, 60 * 1000)

  // 睡眠唤醒后立即检查（处理电脑长时间休眠跳过触发时间的情况）
  powerMonitor.on('resume', () => {
    setTimeout(check, 2000)  // 延迟 2s 等系统时钟稳定
  })

  // 立即检查一次（处理刚开机时正好是上班时间的情况）
  check()
}

export function stopScheduler(): void {
  if (intervalId) {
    clearInterval(intervalId)
    intervalId = null
  }
}

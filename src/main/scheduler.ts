/**
 * 定时触发器
 * 每 30 秒检查一次，判断"今天的上班/下班时间点是否已过且尚未触发"。
 * 相比精确分钟匹配，这种区间检测能容忍 interval 漂移和休眠唤醒的时间跳跃，
 * 不会因错过某一分钟而永久丢失当天触发。
 */

import { powerMonitor } from 'electron'
import { getDailyState, setDailyState, getConfig, getLog, todayStr } from './store'

type TriggerCallback = (type: 'morning' | 'evening', date: string, hasTodos: boolean) => void

let intervalId: NodeJS.Timeout | null = null
let onTrigger: TriggerCallback | null = null

/** 解析 "HH:mm" → 今天该时间点的 Date 对象 */
function todayAt(hhmm: string): Date {
  const [h, m] = hhmm.split(':').map(Number)
  const d = new Date()
  d.setHours(h, m, 0, 0)
  return d
}

/** 是否为周末 */
function isWeekend(): boolean {
  const day = new Date().getDay()
  return day === 0 || day === 6
}

/**
 * 检查是否需要触发晨间/晚间事件。
 * 触发条件：目标时间点已过（当前时间 >= 目标时间）且今天还未触发过。
 * 上限保护：超过目标时间 2 小时后不再补触发（避免用户第二天开机时错误触发昨天的事件）。
 */
function check(): void {
  if (isWeekend()) return

  const config = getConfig()
  const state = getDailyState()
  const today = todayStr()
  const now = Date.now()
  const TWO_HOURS = 2 * 60 * 60 * 1000

  // 晨间检查
  const morningTime = todayAt(config.work_start).getTime()
  if (
    now >= morningTime &&
    now < morningTime + TWO_HOURS &&
    state.morning_triggered_date !== today
  ) {
    setDailyState({ morning_triggered_date: today })
    const hasTodos = (getLog(today)?.todos.length ?? 0) > 0
    onTrigger?.('morning', today, hasTodos)
  }

  // 晚间检查
  const eveningTime = todayAt(config.work_end).getTime()
  if (
    now >= eveningTime &&
    now < eveningTime + TWO_HOURS &&
    state.evening_triggered_date !== today
  ) {
    setDailyState({ evening_triggered_date: today })
    const hasTodos = (getLog(today)?.todos.length ?? 0) > 0
    onTrigger?.('evening', today, hasTodos)
  }
}

export function startScheduler(cb: TriggerCallback): void {
  onTrigger = cb

  // 每 30 秒检查一次，保证即使 interval 轻微漂移也能在 1 分钟内触发
  intervalId = setInterval(check, 30 * 1000)

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

/**
 * 小猫心情/饲食度系统
 *
 * 值域：
 *   - mood:   0-100 （心情：0 郁闷 ~ 100 幸福）
 *   - hunger: 0-100 （饱食度：0 饿瘪 ~ 100 饱腹）
 *
 * 随时间衰减：
 *   - 每分钟：hunger -= 0.3，mood -= 0.1
 *   - 衰减在前台真实刷新；离线期间由"上次更新时间戳"补算
 *
 * 可触发动作：
 *   - pet()          抚摸（点击小猫）   → mood +3
 *   - feed()         喂食（右键菜单）   → hunger +35, mood +8
 *   - planMade()     计划录入完成       → mood +5
 *   - celebrate()    晚间完成所有待办   → mood +10
 *
 * 持久化到 localStorage，key = `xiaoniu:cat-mood`
 */

import { useCallback, useEffect, useState } from 'react'

/** 状态值（导出以便其他模块做联动） */
export interface CatMoodState {
  mood: number
  hunger: number
  lastFedAt: number      // 毫秒时间戳
  lastInteractAt: number
  lastTickAt: number     // 上一次衰减计算时间
}

const STORAGE_KEY = 'xiaoniu:cat-mood'
const DEFAULT_STATE: CatMoodState = {
  mood: 70,
  hunger: 70,
  lastFedAt: 0,
  lastInteractAt: 0,
  lastTickAt: Date.now(),
}

// 每分钟衰减量
const HUNGER_DECAY_PER_MIN = 0.3
const MOOD_DECAY_PER_MIN = 0.1

// 衰减刷新间隔（毫秒）。前台每 30 秒做一次真实衰减；切到后台不跑，下次回到前台再按真实时间差补算
const TICK_INTERVAL_MS = 30_000

// Clamp [0, 100]
const clamp = (v: number) => Math.max(0, Math.min(100, v))

function loadInitial(): CatMoodState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_STATE }
    const parsed = JSON.parse(raw) as Partial<CatMoodState>
    return {
      mood: typeof parsed.mood === 'number' ? clamp(parsed.mood) : DEFAULT_STATE.mood,
      hunger: typeof parsed.hunger === 'number' ? clamp(parsed.hunger) : DEFAULT_STATE.hunger,
      lastFedAt: typeof parsed.lastFedAt === 'number' ? parsed.lastFedAt : 0,
      lastInteractAt: typeof parsed.lastInteractAt === 'number' ? parsed.lastInteractAt : 0,
      lastTickAt: typeof parsed.lastTickAt === 'number' ? parsed.lastTickAt : Date.now(),
    }
  } catch {
    return { ...DEFAULT_STATE }
  }
}

/**
 * 计算从 lastTickAt 到 now 之间的自然衰减
 */
function applyDecay(s: CatMoodState, now: number): CatMoodState {
  const diffMin = Math.max(0, (now - s.lastTickAt) / 60_000)
  if (diffMin < 0.01) return s
  return {
    ...s,
    mood: clamp(s.mood - MOOD_DECAY_PER_MIN * diffMin),
    hunger: clamp(s.hunger - HUNGER_DECAY_PER_MIN * diffMin),
    lastTickAt: now,
  }
}

export interface UseCatMood {
  state: CatMoodState
  /** 抚摸（点击小猫） */
  pet: () => void
  /** 喂食（右键菜单） */
  feed: () => void
  /** 计划录入完成 */
  planMade: () => void
  /** 单个待办完成 */
  taskDone: () => void
  /** 所有待办完成（晚间复盘高完成率时） */
  celebrate: () => void
  /** 手动强制刷新（一般不需要用） */
  refresh: () => void
  /** 衍生状态：心情档位（用于小猫默认动画等） */
  tier: 'hungry' | 'sad' | 'ok' | 'great'
}

/**
 * React hook：在组件挂载时挂上衰减计时器，返回状态与操作函数
 */
export function useCatMood(): UseCatMood {
  // 初始值从 localStorage 读，并立即补算离线期间的衰减
  const [state, setState] = useState<CatMoodState>(() => {
    const init = loadInitial()
    return applyDecay(init, Date.now())
  })

  // 持久化（每次 state 变化）
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
    } catch {
      // localStorage 不可用则静默忽略（不影响使用）
    }
  }, [state])

  // 定时衰减：每 TICK_INTERVAL_MS 做一次按真实时间差的衰减
  useEffect(() => {
    const timer = setInterval(() => {
      setState(prev => applyDecay(prev, Date.now()))
    }, TICK_INTERVAL_MS)
    // 窗口重新获得焦点时立刻补算一次（覆盖被系统暂停计时器的情况）
    const onFocus = () => setState(prev => applyDecay(prev, Date.now()))
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onFocus)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onFocus)
    }
  }, [])

  // 操作函数：在现有值基础上做 clamp + 记录时间戳，内部都先 applyDecay 补算历史
  const mutate = useCallback((fn: (s: CatMoodState, now: number) => CatMoodState) => {
    setState(prev => {
      const now = Date.now()
      const decayed = applyDecay(prev, now)
      return fn(decayed, now)
    })
  }, [])

  const pet = useCallback(() => {
    mutate((s, now) => ({
      ...s,
      mood: clamp(s.mood + 3),
      lastInteractAt: now,
    }))
    console.log('[CatMood] pet() 抚摸 → mood +3')
  }, [mutate])

  const feed = useCallback(() => {
    mutate((s, now) => ({
      ...s,
      hunger: clamp(s.hunger + 35),
      mood: clamp(s.mood + 8),
      lastFedAt: now,
    }))
    console.log('[CatMood] feed() 喂食 → hunger +35, mood +8')
  }, [mutate])

  const planMade = useCallback(() => {
    mutate(s => ({ ...s, mood: clamp(s.mood + 5) }))
    console.log('[CatMood] planMade() 计划录入 → mood +5')
  }, [mutate])

  const taskDone = useCallback(() => {
    mutate(s => ({ ...s, mood: clamp(s.mood + 1) }))
    console.log('[CatMood] taskDone() 完成一个待办 → mood +1')
  }, [mutate])

  const celebrate = useCallback(() => {
    mutate(s => ({ ...s, mood: clamp(s.mood + 10) }))
    console.log('[CatMood] celebrate() 庆祝 → mood +10')
  }, [mutate])

  const refresh = useCallback(() => {
    setState(prev => applyDecay(prev, Date.now()))
  }, [])

  // 衍生：心情档位（供默认动画与文案挑选使用）
  // 优先级：hungry > sad > ok > great
  const tier: UseCatMood['tier'] =
    state.hunger < 25
      ? 'hungry'
      : state.mood < 35
        ? 'sad'
        : state.mood > 75
          ? 'great'
          : 'ok'

  return { state, pet, feed, planMade, taskDone, celebrate, refresh, tier }
}

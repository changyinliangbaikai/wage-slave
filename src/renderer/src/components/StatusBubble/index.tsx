/**
 * StatusBubble：小猫空闲时的陪伴性工作状态气泡
 *
 * 工作流程：
 *   1. 启动后等一个 initialDelayMs 再首次显示（避免刚开应用就跳出来打扰）
 *   2. 从 pickBubble(ctx) 挑一条文案；没有合适的就跳过这一轮
 *   3. 显示 visibleMs 后淡出 → 随机 gapMin~gapMax 后再挑一轮
 *   4. 永远不挡点击：pointer-events: none
 *
 * 与 SpeechBubble 的区别：
 *   - 轻量、无关闭按钮、无 children、不中断任何操作
 *   - 专门用于 activeFlow === 'none' 时兜底小猫的"存在感"
 */

import { useEffect, useRef, useState } from 'react'
import { BubbleContext, BubbleLine, pickBubble } from './messages'
import './StatusBubble.css'

interface Props {
  context: BubbleContext
  /** 首次出现前的延迟（默认 15s） */
  initialDelayMs?: number
  /** 每条文案显示时长（默认 6s） */
  visibleMs?: number
  /** 下一次抽签的最小间隔（默认 25s） */
  gapMin?: number
  /** 下一次抽签的最大间隔（默认 55s） */
  gapMax?: number
  /** 点击气泡时的回调（可选，用于"轻拍"交互） */
  onTap?: () => void
  /** 即时抢跑计数器：每次递增会取消当前定时器立即重抽一条文案（用于抚摸/喂食后即时反馈） */
  triggerKey?: number
}

export default function StatusBubble({
  context,
  initialDelayMs = 15_000,
  visibleMs = 6_000,
  gapMin = 25_000,
  gapMax = 55_000,
  onTap,
  triggerKey = 0,
}: Props) {
  // 当前显示的文案（pickBubble 时已经根据 context 生成 text，之后 context 变化不再刷新这条，避免闪烁）
  const [current, setCurrent] = useState<{ line: BubbleLine; text: string } | null>(null)
  const [visible, setVisible] = useState(false)
  // 用 ref 保存最新 context；在 effect 里同步写入，避免在渲染期写 ref（符合 React 19 pure-render 规则）
  const ctxRef = useRef(context)
  useEffect(() => {
    ctxRef.current = context
  }, [context])

  // 抢跑函数引用 + 定时器引用：当 triggerKey 变化时，可以取消当前 gap 并立即重抽一次
  const runOnceRef = useRef<(() => void) | null>(null)
  const clearTimersRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    let showTimer: ReturnType<typeof setTimeout> | null = null
    let hideTimer: ReturnType<typeof setTimeout> | null = null
    let fadeTimer: ReturnType<typeof setTimeout> | null = null
    let cancelled = false

    const clearAll = () => {
      if (showTimer) { clearTimeout(showTimer); showTimer = null }
      if (hideTimer) { clearTimeout(hideTimer); hideTimer = null }
      if (fadeTimer) { clearTimeout(fadeTimer); fadeTimer = null }
    }
    clearTimersRef.current = clearAll

    const runOnce = () => {
      if (cancelled) return
      const ctx = ctxRef.current
      const line = pickBubble(ctx)
      if (!line) {
        // 没抽到合适的 → 等下一个 gap
        scheduleNext()
        return
      }
      setCurrent({ line, text: line.text(ctx) })
      setVisible(true)
      // 显示 visibleMs 后淡出
      hideTimer = setTimeout(() => {
        if (cancelled) return
        setVisible(false)
        // 淡出动画 400ms 后清空内容 + 排下一次
        fadeTimer = setTimeout(() => {
          if (!cancelled) scheduleNext()
        }, 400)
      }, visibleMs)
    }
    runOnceRef.current = runOnce

    const scheduleNext = () => {
      if (cancelled) return
      const gap = gapMin + Math.random() * (gapMax - gapMin)
      showTimer = setTimeout(runOnce, gap)
    }

    // 初次延迟 + 首轮
    showTimer = setTimeout(runOnce, initialDelayMs)

    return () => {
      cancelled = true
      runOnceRef.current = null
      clearTimersRef.current = null
      clearAll()
    }
  }, [initialDelayMs, visibleMs, gapMin, gapMax])

  // 抢跑：triggerKey 变化时，取消当前的 gap 定时器，立即重抽一次文案
  // 初始 triggerKey=0 时不抢跑，避免与 initialDelayMs 竞争
  useEffect(() => {
    if (triggerKey === 0) return
    const clearAll = clearTimersRef.current
    const runOnce = runOnceRef.current
    if (!clearAll || !runOnce) return
    clearAll()
    // 微延迟让 visible/hidden 态切换稳定，避免闪动
    const t = setTimeout(() => runOnce(), 80)
    return () => clearTimeout(t)
  }, [triggerKey])

  if (!current) return null

  return (
    <div className={`status-bubble ${visible ? 'visible' : 'hidden'}`} onClick={onTap} role="status">
      <span className="status-bubble-text">{current.text}</span>
      <div className="status-bubble-tail" />
    </div>
  )
}

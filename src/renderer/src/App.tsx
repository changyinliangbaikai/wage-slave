/**
 * App 根组件
 */

import { useState, useCallback, useRef, useEffect } from 'react'
import PixelCat from './components/PixelCat'
import ContextMenu, { MenuItem } from './components/ContextMenu'
import SpeechBubble from './components/SpeechBubble'
import MorningFlow from './pages/MorningFlow'
import BreakReminder from './pages/BreakReminder'
import EveningFlow from './pages/EveningFlow'
import SummaryFlow from './pages/SummaryFlow'
import {
  useOnMorningTrigger,
  useOnBreakTrigger,
  useOnEveningTrigger,
  useOnEvent,
  getTodos,
  saveTodos,
  openSettings,
  openLogs,
  notifyBreakDone,
  startWindowDrag,
  moveWindowDrag,
  endWindowDrag,
} from './hooks/useIPC'
import { CatAnimator } from './components/PixelCat/animator'
import type { CatState, TodoItem } from '@shared/types'
import './App.css'

/** 返回本地日期字符串 YYYY-MM-DD，避免 toISOString() 的 UTC 偏差 */
function localDateStr(d = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

type ActiveFlow = 'none' | 'morning' | 'break' | 'evening' | 'todos' | 'manual-log' | 'summary'

interface ContextMenuState {
  visible: boolean
  x: number
  y: number
}

/**
 * 用户正在输入数据的流程，不允许被自动触发器打断。
 * 自动触发（调度器/活跃监测）遇到这些流程时会排队等待，
 * 用户手动触发（右键菜单、托盘菜单）则直接切换。
 */
const PROTECTED_FLOWS = new Set<ActiveFlow>(['morning', 'evening', 'manual-log'])

export default function App() {
  const [activeFlow, setActiveFlow] = useState<ActiveFlow>('none')
  const [forceCatState, setForceCatState] = useState<CatState | undefined>(undefined)
  const [currentDate, setCurrentDate] = useState('')
  const [elapsedMin, setElapsedMin] = useState(0)
  const [todos, setTodos] = useState<TodoItem[]>([])
  const [todosDate, setTodosDate] = useState('')       // 当前展示的待办属于哪天
  const [eveningTodos, setEveningTodos] = useState<TodoItem[]>([])
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState>({ visible: false, x: 0, y: 0 })
  const animatorRef = useRef<CatAnimator | null>(null)
  const dragRef = useRef({ isDragging: false, startScreenX: 0, startScreenY: 0, didMove: false })
  const isIgnoringRef = useRef(true)

  // 用 ref 跟踪当前 flow，供 useCallback 内部读取最新值（避免闭包陈旧问题）
  const activeFlowRef = useRef<ActiveFlow>('none')
  // 自动触发器被阻断时，暂存一个待执行的回调
  const pendingTrigger = useRef<(() => void) | null>(null)

  // 同步更新 flow state + ref
  const setFlow = useCallback((flow: ActiveFlow) => {
    activeFlowRef.current = flow
    setActiveFlow(flow)
  }, [])

  // ── 透明区域穿透 ──────────────────────────────
  useEffect(() => {
    const api = window.electronAPI
    const handleMouseMove = (e: MouseEvent) => {
      if (dragRef.current.isDragging) return
      const el = document.elementFromPoint(e.clientX, e.clientY)
      const isOverContent = !!el?.closest('.cat-layer, .bubble-wrapper, .bubble, .context-menu')
      if (isOverContent && isIgnoringRef.current) {
        isIgnoringRef.current = false
        api.sendRaw('window:set-ignore-mouse-events', false)
      } else if (!isOverContent && !isIgnoringRef.current) {
        isIgnoringRef.current = true
        api.sendRaw('window:set-ignore-mouse-events', true)
      }
    }
    document.addEventListener('mousemove', handleMouseMove)
    return () => document.removeEventListener('mousemove', handleMouseMove)
  }, [])

  // ── 关闭流程：检查并执行排队的自动触发 ────────
  const drainPending = useCallback(() => {
    if (pendingTrigger.current) {
      const fn = pendingTrigger.current
      pendingTrigger.current = null
      // 小延迟让关闭动画先完成
      setTimeout(fn, 400)
    }
  }, [])

  const closeFlow = useCallback(() => {
    setFlow('none')
    setForceCatState(undefined)
    drainPending()
  }, [setFlow, drainPending])

  const onMorningDone = useCallback((newTodos: TodoItem[]) => {
    setTodos(newTodos)
    setFlow('none')
    setForceCatState(undefined)
    drainPending()
  }, [setFlow, drainPending])

  // ── 自动触发：晨间 ────────────────────────────
  useOnMorningTrigger(useCallback(({ date }) => {
    const activate = () => {
      setCurrentDate(date)
      setFlow('morning')
      setForceCatState('happy')
    }
    if (PROTECTED_FLOWS.has(activeFlowRef.current)) {
      // 用户正在输入，排队等待
      pendingTrigger.current = activate
    } else {
      activate()
    }
  }, [setFlow]))

  // ── 自动触发：休息提醒 ────────────────────────
  useOnBreakTrigger(useCallback(({ elapsed_min }) => {
    if (PROTECTED_FLOWS.has(activeFlowRef.current)) {
      // 用户正在填写流程中（本身已在工作），静默重置计时器
      notifyBreakDone()
      return
    }
    setElapsedMin(elapsed_min)
    setFlow('break')
    setForceCatState('worried')
  }, [setFlow]))

  // ── 自动触发：晚间 ────────────────────────────
  useOnEveningTrigger(useCallback(async ({ date, has_todos }) => {
    const activate = async () => {
      setCurrentDate(date)
      if (has_todos) {
        const t = await getTodos(date)
        setEveningTodos(t)
      } else {
        setEveningTodos([])
      }
      setFlow('evening')
      setForceCatState('happy')
    }
    if (PROTECTED_FLOWS.has(activeFlowRef.current)) {
      pendingTrigger.current = activate
    } else {
      await activate()
    }
  }, [setFlow]))

  // ── 托盘菜单手动触发（直接切换，清空排队） ────
  useOnEvent('main:show-todos', useCallback(async () => {
    pendingTrigger.current = null
    const today = localDateStr()
    const t = await getTodos(today)
    setTodos(t)
    setTodosDate(today)
    setFlow('todos')
  }, [setFlow]))

  useOnEvent('main:trigger-morning-plan', useCallback(() => {
    pendingTrigger.current = null
    const today = localDateStr()
    setCurrentDate(today)
    setFlow('morning')
    setForceCatState('happy')
  }, [setFlow]))

  useOnEvent('main:trigger-summary', useCallback(() => {
    pendingTrigger.current = null
    setFlow('summary')
    setForceCatState('talk')
  }, [setFlow]))

  useOnEvent('main:trigger-manual-log', useCallback(async () => {
    pendingTrigger.current = null
    const today = localDateStr()
    setCurrentDate(today)
    const t = await getTodos(today)
    setEveningTodos(t)
    setFlow('manual-log')
    setForceCatState('talk')
  }, [setFlow]))

  // ── 待办气泡：点击切换状态 ────────────────────
  const toggleTodoInView = useCallback((id: string) => {
    setTodos(prev => prev.map(t =>
      t.id === id ? { ...t, status: t.status === 'done' ? 'pending' : 'done' } : t
    ))
  }, [])

  // 关闭待办气泡时自动保存变更
  const closeTodosFlow = useCallback(async () => {
    if (todos.length > 0 && todosDate) {
      await saveTodos(todosDate, todos)
    }
    closeFlow()
  }, [todos, todosDate, closeFlow])

  // ── 拖动处理 ─────────────────────────────────
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return
    dragRef.current = {
      isDragging: true,
      startScreenX: e.screenX,
      startScreenY: e.screenY,
      didMove: false,
    }
    startWindowDrag()

    const handleMouseMove = (ev: MouseEvent) => {
      if (!dragRef.current.isDragging) return
      const dx = ev.screenX - dragRef.current.startScreenX
      const dy = ev.screenY - dragRef.current.startScreenY
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) dragRef.current.didMove = true
      dragRef.current.startScreenX = ev.screenX
      dragRef.current.startScreenY = ev.screenY
      moveWindowDrag(dx, dy)
    }

    const handleMouseUp = () => {
      dragRef.current.isDragging = false
      endWindowDrag()
      isIgnoringRef.current = true
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }, [])

  // ── 右键菜单 ─────────────────────────────────
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setCtxMenu({ visible: true, x: e.clientX, y: e.clientY })
  }, [])

  const handleCatClick = useCallback(() => {
    if (dragRef.current.didMove) return
    animatorRef.current?.setState('happy', true)
    setTimeout(() => animatorRef.current?.setState('idle'), 2000)
  }, [])

  // ── 右键菜单手动触发（直接切换，清空排队） ────
  const showTodos = useCallback(async () => {
    pendingTrigger.current = null
    const today = localDateStr()
    const t = await getTodos(today)
    setTodos(t)
    setTodosDate(today)
    setFlow('todos')
    setForceCatState('talk')
  }, [setFlow])

  const triggerManualLog = useCallback(async () => {
    pendingTrigger.current = null
    const today = localDateStr()
    setCurrentDate(today)
    const t = await getTodos(today)
    setEveningTodos(t)
    setFlow('manual-log')
    setForceCatState('talk')
  }, [setFlow])

  const triggerMorningPlan = useCallback(() => {
    pendingTrigger.current = null
    const today = localDateStr()
    setCurrentDate(today)
    setFlow('morning')
    setForceCatState('happy')
  }, [setFlow])

  const triggerSummary = useCallback(() => {
    pendingTrigger.current = null
    setFlow('summary')
    setForceCatState('talk')
  }, [setFlow])

  const ctxMenuItems: MenuItem[] = [
    { label: '录入今日计划', icon: '☀', onClick: triggerMorningPlan },
    { label: '查看今日待办', icon: '📋', onClick: showTodos },
    { label: '录入工作日志', icon: '📝', onClick: triggerManualLog },
    { label: '生成工作总结', icon: '📊', onClick: triggerSummary },
    { divider: true },
    { label: '查看工作日志', icon: '📒', onClick: () => openLogs() },
    { label: '设置', icon: '⚙', onClick: () => openSettings() },
  ]

  return (
    <div className="app-container">
      {/* 右键菜单 */}
      {ctxMenu.visible && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={ctxMenuItems}
          onClose={() => setCtxMenu(v => ({ ...v, visible: false }))}
        />
      )}

      {/* 气泡层 */}
      <div className="bubble-layer">
        {activeFlow === 'morning' && (
          <MorningFlow date={currentDate} onDone={onMorningDone} onSkip={closeFlow} />
        )}
        {activeFlow === 'break' && (
          <BreakReminder elapsedMin={elapsedMin} onDone={closeFlow} />
        )}
        {(activeFlow === 'evening' || activeFlow === 'manual-log') && (
          <EveningFlow date={currentDate} todos={eveningTodos} onDone={closeFlow} />
        )}
        {activeFlow === 'summary' && (
          <SummaryFlow onDone={closeFlow} />
        )}
        {activeFlow === 'todos' && (
          <SpeechBubble
            visible
            message={
              todos.length > 0
                ? `今日待办（点击可标记完成）：`
                : '今天还没有待办哦～'
            }
            onClose={closeTodosFlow}
          >
            {todos.length > 0 && (
              <div className="todos-display">
                {todos.map(t => (
                  <div
                    key={t.id}
                    className={`todo-item todo-item-clickable ${t.status}`}
                    onClick={() => toggleTodoInView(t.id)}
                    title={t.status === 'done' ? '点击标记为未完成' : '点击标记为已完成'}
                  >
                    <span className="todo-check">{t.status === 'done' ? '✓' : '○'}</span>
                    <span className="todo-title">{t.title}</span>
                    {t.priority === 'high' && <span className="tag-high">紧</span>}
                  </div>
                ))}
              </div>
            )}
          </SpeechBubble>
        )}
        {activeFlow === 'none' && (
          <div className="idle-hint">右键查看菜单</div>
        )}
      </div>

      {/* 像素猫 */}
      <div
        className="cat-layer"
        onClick={handleCatClick}
        onContextMenu={handleContextMenu}
        onMouseDown={handleMouseDown}
      >
        <PixelCat
          state={forceCatState}
          onAnimatorReady={a => { animatorRef.current = a }}
        />
      </div>
    </div>
  )
}

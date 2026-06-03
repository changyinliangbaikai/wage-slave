/**
 * App 根组件
 */

import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import PixelCat from './components/PixelCat'
import ContextMenu, { MenuItem } from './components/ContextMenu'
import SpeechBubble from './components/SpeechBubble'
import StatusBubble from './components/StatusBubble'
import type { BubbleContext } from './components/StatusBubble/messages'
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
  openTools,
  openAIChat,
  openAgentChat,
  notifyBreakDone,
  startWindowDrag,
  moveWindowDrag,
  endWindowDrag,
} from './hooks/useIPC'
import { useCatMood } from './hooks/useCatMood'
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

  // 心情/饲食度系统
  const catMood = useCatMood()
  // 窗口启动时间戳（供文案上下文里的"刚启动"类判断使用，lazy init 避免在渲染期调用 Date.now）
  const [mountAt] = useState<number>(() => Date.now())
  // StatusBubble 抢跑计数器：每次 pet/feed 递增，触发气泡立即弹一条"感谢"文案
  const [bubbleTrigger, setBubbleTrigger] = useState(0)
  const bumpBubble = useCallback(() => setBubbleTrigger(v => v + 1), [])

  // ── 今日待办：用于 StatusBubble 感知数量 ──
  const [todayTodos, setTodayTodos] = useState<TodoItem[]>([])
  useEffect(() => {
    // 加载今日待办，供文案上下文使用（只做只读访问，不影响 todos/eveningTodos）
    let cancelled = false
    const load = async () => {
      try {
        const t = await getTodos(localDateStr())
        if (!cancelled) setTodayTodos(t)
      } catch {
        /* ignore */
      }
    }
    load()
    // 每 2 分钟刷新一次今日待办（用户可能在 todos flow 里标记完成 → 反映到 StatusBubble）
    const timer = setInterval(load, 120_000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [])
  // 当 todos flow 里保存时也同步一下
  useEffect(() => {
    if (todosDate === localDateStr() && todos.length > 0) {
      // 这里是"派生 state 同步"的合理场景：todos 是某天的数据，只有当它恰好是今天时才同步
      // React 19 的 pure-effect 规则不鼓励 effect 里 setState，但派生一份"只读投影"本质就是 effect
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setTodayTodos(todos)
    }
  }, [todos, todosDate])

  // ── 心情 tier 变化 → 播一次情绪动画（仅在 idle 流程时，不打扰正在进行的流程） ──
  // 用 ref 记录上一次 tier；仅当 tier 真的变化才触发一次动画，避免反复播
  const prevTierRef = useRef(catMood.tier)
  useEffect(() => {
    const prev = prevTierRef.current
    prevTierRef.current = catMood.tier
    if (prev === catMood.tier) return
    if (activeFlowRef.current !== 'none') return
    const animator = animatorRef.current
    if (!animator) return
    // great：播一次庆祝（celebrate 是非循环，播完自动回 idle）
    if (catMood.tier === 'great') {
      animator.setState('celebrate', true)
      console.log('[CatMood] tier → great，播 celebrate 动画')
    }
    // hungry/sad：精简模型不再单独播负面动画，由 StatusBubble 文案承担表达
  // 注：旧版 worried 动画在 4 态模型中已合并入 idle
  }, [catMood.tier])

  // ── StatusBubble 文案上下文（每分钟刷新一次，降低 re-render） ──
  const [bubbleNowTick, setBubbleNowTick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setBubbleNowTick(x => x + 1), 60_000)
    return () => clearInterval(t)
  }, [])
  const bubbleContext: BubbleContext = useMemo(() => {
    // bubbleNowTick 是每分钟触发的"时间摆钟"，让 useMemo 对时间敏感；hour/sinceMountMs 据此刷新
    // Date.now 在这里故意被调用，依赖 bubbleNowTick 保证每分钟刷新一次；React purity 规则的担忧在此不适用
    // eslint-disable-next-line react-hooks/purity
    const now = Date.now()
    const d = new Date(now)
    const pending = todayTodos.filter(t => t.status !== 'done').length
    return {
      hour: d.getHours(),
      dayOfWeek: d.getDay(),
      todoTotal: todayTodos.length,
      todoPending: pending,
      mood: catMood.state.mood,
      hunger: catMood.state.hunger,
      tier: catMood.tier,
      sinceMountMs: now - mountAt,
      sinceFedMs: catMood.state.lastFedAt > 0 ? now - catMood.state.lastFedAt : Infinity,
      sinceInteractMs: catMood.state.lastInteractAt > 0 ? now - catMood.state.lastInteractAt : Infinity,
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    todayTodos,
    catMood.state.mood,
    catMood.state.hunger,
    catMood.state.lastFedAt,
    catMood.state.lastInteractAt,
    catMood.tier,
    bubbleNowTick,
    mountAt,
  ])

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
      const isOverContent = !!el?.closest('.cat-layer, .bubble-wrapper, .bubble, .context-menu, .status-bubble')
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
    setTodayTodos(newTodos)         // 计划录入完立即刷新 StatusBubble 上下文
    catMood.planMade()               // 心情 +5
    setFlow('none')
    setForceCatState(undefined)
    drainPending()
  }, [setFlow, drainPending, catMood])

  // ── 自动触发：晨间 ────────────────────────────
  useOnMorningTrigger(useCallback(({ date }) => {
    const activate = () => {
      setCurrentDate(date)
      setFlow('morning')
      // 流程激活：用 petting 让小猫表达「陪着你」的轻量在线感（循环，关闭流程后回 idle）
      setForceCatState('petting')
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
    // 休息提醒：不强制状态，保持 idle 默认表现；负面情绪由文案承担
    setForceCatState(undefined)
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
      setForceCatState('petting')
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
    setForceCatState('petting')
  }, [setFlow]))

  useOnEvent('main:trigger-summary', useCallback(() => {
    pendingTrigger.current = null
    setFlow('summary')
    // 总结流程会调 LLM 流式生成，小猫处于「工作中」状态
    setForceCatState('busy')
  }, [setFlow]))

  useOnEvent('main:trigger-manual-log', useCallback(async () => {
    pendingTrigger.current = null
    const today = localDateStr()
    setCurrentDate(today)
    const t = await getTodos(today)
    setEveningTodos(t)
    setFlow('manual-log')
    setForceCatState('busy')
  }, [setFlow]))

  // ── 待办气泡：点击切换状态 ────────────────────
  const toggleTodoInView = useCallback((id: string) => {
    setTodos(prev => {
      const target = prev.find(t => t.id === id)
      // 当从 pending → done 时，奖励心情 +1（用户完成了一件事）
      if (target && target.status !== 'done') {
        catMood.taskDone()
        console.log('[CatMood] 勾选完成待办 →', target.title)
      }
      return prev.map(t =>
        t.id === id ? { ...t, status: t.status === 'done' ? 'pending' : 'done' } : t
      )
    })
  }, [catMood])

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
      const wasDrag = dragRef.current.didMove
      dragRef.current.isDragging = false
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      // 只有真正拖动过才走 drag-end：保存位置 + 主进程主动恢复鼠标穿透。
      // 纯点击场景不调用，避免主进程立刻 setIgnoreMouseEvents(true) 导致
      // 紧随其后的 dblclick 第二次 mousedown 被挡掉（双击失效）。
      // 穿透态的恢复由 mousemove 处理器在光标离开内容时自动完成。
      if (wasDrag) {
        endWindowDrag()
        isIgnoringRef.current = true
      }
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
    // 点击：播 petting 一段轻量反馈，2 秒后回 idle
    animatorRef.current?.setState('petting', true)
    setTimeout(() => animatorRef.current?.setState('idle'), 2000)
    // 抚摸：心情 +3，并触发一次"呼噜噜"感谢气泡
    catMood.pet()
    bumpBubble()
  }, [catMood, bumpBubble])

  // 双击小猫 → 打开 AI 对话窗口（双击事件会先触发一次 click，忽略其 idle 回弹即可）
  const handleCatDoubleClick = useCallback(() => {
    if (dragRef.current.didMove) return
    openAIChat()
  }, [])

  // ── 右键菜单手动触发（直接切换，清空排队） ────
  const showTodos = useCallback(async () => {
    pendingTrigger.current = null
    const today = localDateStr()
    const t = await getTodos(today)
    setTodos(t)
    setTodosDate(today)
    setFlow('todos')
    // 查看待办列表：保持 idle 默认即可，不强制状态
    setForceCatState(undefined)
  }, [setFlow])

  const triggerManualLog = useCallback(async () => {
    pendingTrigger.current = null
    const today = localDateStr()
    setCurrentDate(today)
    const t = await getTodos(today)
    setEveningTodos(t)
    setFlow('manual-log')
    setForceCatState('busy')
  }, [setFlow])

  const triggerMorningPlan = useCallback(() => {
    pendingTrigger.current = null
    const today = localDateStr()
    setCurrentDate(today)
    setFlow('morning')
    setForceCatState('petting')
  }, [setFlow])

  const triggerSummary = useCallback(() => {
    pendingTrigger.current = null
    setFlow('summary')
    setForceCatState('busy')
  }, [setFlow])

  const triggerTools = useCallback(() => {
    // 打开独立工具窗口
    openTools()
  }, [])

  // 喂食：播 petting 一段反馈 + catMood.feed() + 即时弹"好吃"气泡
  const triggerFeed = useCallback(() => {
    animatorRef.current?.setState('petting', true)
    setTimeout(() => animatorRef.current?.setState('idle'), 2500)
    catMood.feed()
    bumpBubble()
  }, [catMood, bumpBubble])

  // 喂食菜单项的动态标签：根据饥饿度给个视觉反馈
  const feedLabel = useMemo(() => {
    const h = catMood.state.hunger
    if (h < 25) return '喂食（好饿）'
    if (h < 60) return '喂食'
    return '喂食（吃饱啦）'
  }, [catMood.state.hunger])

  const ctxMenuItems: MenuItem[] = [
    { label: '录入今日计划', icon: '☀', onClick: triggerMorningPlan },
    { label: '查看今日待办', icon: '📋', onClick: showTodos },
    { label: '录入工作日志', icon: '📝', onClick: triggerManualLog },
    { label: '生成工作总结', icon: '📊', onClick: triggerSummary },
    { divider: true },
    { label: 'AI 对话', icon: '💬', onClick: () => openAIChat() },
    { label: 'Agent 模式', icon: '🤖', onClick: () => openAgentChat() },
    { label: '小工具', icon: '🛠️', onClick: triggerTools },
    { divider: true },
    { label: feedLabel, icon: '🐟', onClick: triggerFeed },
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
          <EveningFlow
            date={currentDate}
            todos={eveningTodos}
            onDone={closeFlow}
            onReviewSubmitted={({ doneCount, totalCount }) => {
              // 完成率决定奖励：≥80% → celebrate(+10)；≥50% → taskDone 多播几次；否则只 planMade(+5) 鼓励
              if (totalCount === 0) {
                // 只写了日志、无待办统计：也给一点鼓励
                catMood.planMade()
              } else {
                const ratio = doneCount / totalCount
                if (ratio >= 0.8) {
                  catMood.celebrate()
                  // 高完成率：手动播一次庆祝动画（一次性，播完回 idle）
                  animatorRef.current?.setState('celebrate', true)
                  console.log('[CatMood] 晚间复盘 ≥80% → celebrate')
                } else if (ratio >= 0.5) {
                  catMood.planMade() // +5 中等鼓励
                  console.log('[CatMood] 晚间复盘 ≥50% → planMade(+5)')
                } else {
                  // 低完成率也给 +3 鼓励（已经坚持复盘本身就值得肯定）
                  catMood.pet()
                }
              }
            }}
          />
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
          <>
            {/* 陪伴性状态气泡：根据时间/待办/心情随机显示一句话，不阻塞交互 */}
            <StatusBubble
              context={bubbleContext}
              triggerKey={bubbleTrigger}
              onTap={() => {
                // 点击气泡 = 轻拍，等价于抚摸
                animatorRef.current?.setState('petting', true)
                setTimeout(() => animatorRef.current?.setState('idle'), 1500)
                catMood.pet()
                bumpBubble()
              }}
            />
            <div className="idle-hint">右键查看菜单 · 双击打开 AI 对话</div>
          </>
        )}
      </div>

      {/* 像素猫 */}
      <div
        className="cat-layer"
        onClick={handleCatClick}
        onDoubleClick={handleCatDoubleClick}
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

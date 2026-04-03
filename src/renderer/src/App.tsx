/**
 * App 根组件
 * 负责：
 * 1. 监听主进程 IPC 事件（晨间/休息/晚间触发）
 * 2. 管理当前流程状态（显示哪个气泡）
 * 3. 管理像素猫动画状态
 * 4. 展示待办清单
 */

import { useState, useCallback, useRef } from 'react'
import PixelCat from './components/PixelCat'
import ContextMenu, { MenuItem } from './components/ContextMenu'
import SpeechBubble from './components/SpeechBubble'
import MorningFlow from './pages/MorningFlow'
import BreakReminder from './pages/BreakReminder'
import EveningFlow from './pages/EveningFlow'
import {
  useOnMorningTrigger,
  useOnBreakTrigger,
  useOnEveningTrigger,
  useOnEvent,
  getTodos,
  openSettings,
  startWindowDrag,
  moveWindowDrag,
  endWindowDrag,
} from './hooks/useIPC'
import { CatAnimator } from './components/PixelCat/animator'
import type { CatState, TodoItem } from '@shared/types'
import './App.css'

type ActiveFlow = 'none' | 'morning' | 'break' | 'evening' | 'todos'

interface ContextMenuState {
  visible: boolean
  x: number
  y: number
}

export default function App() {
  const [activeFlow, setActiveFlow] = useState<ActiveFlow>('none')
  const [forceCatState, setForceCatState] = useState<CatState | undefined>(undefined)
  const [currentDate, setCurrentDate] = useState('')
  const [elapsedMin, setElapsedMin] = useState(0)
  const [todos, setTodos] = useState<TodoItem[]>([])
  const [eveningTodos, setEveningTodos] = useState<TodoItem[]>([])
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState>({ visible: false, x: 0, y: 0 })
  const animatorRef = useRef<CatAnimator | null>(null)
  const dragRef = useRef({ isDragging: false, lastX: 0, lastY: 0 })

  // 晨间触发
  useOnMorningTrigger(useCallback(({ date }) => {
    setCurrentDate(date)
    setActiveFlow('morning')
    setForceCatState('happy')
  }, []))

  // 休息提醒触发
  useOnBreakTrigger(useCallback(({ elapsed_min }) => {
    setElapsedMin(elapsed_min)
    setActiveFlow('break')
    setForceCatState('worried')
  }, []))

  // 晚间触发
  useOnEveningTrigger(useCallback(async ({ date, has_todos }) => {
    setCurrentDate(date)
    if (has_todos) {
      const t = await getTodos(date)
      setEveningTodos(t)
    }
    setActiveFlow('evening')
    setForceCatState('happy')
  }, []))

  // 托盘菜单：显示待办
  useOnEvent('main:show-todos', useCallback(async () => {
    const today = new Date().toISOString().slice(0, 10)
    const t = await getTodos(today)
    setTodos(t)
    setActiveFlow('todos')
  }, []))

  // 托盘菜单：手动录入日志（触发晚间流程的补录分支）
  useOnEvent('main:trigger-manual-log', useCallback(() => {
    const today = new Date().toISOString().slice(0, 10)
    setCurrentDate(today)
    setEveningTodos([])
    setActiveFlow('evening')
    setForceCatState('talk')
  }, []))

  const closeFlow = useCallback(() => {
    setActiveFlow('none')
    setForceCatState(undefined)
  }, [])

  const onMorningDone = useCallback((newTodos: TodoItem[]) => {
    setTodos(newTodos)
    setActiveFlow('none')
    setForceCatState(undefined)
  }, [])

  const handleCatClick = () => {
    // 点击猫咪时播放 happy 动画
    animatorRef.current?.setState('happy', true)
    setTimeout(() => animatorRef.current?.setState('idle'), 2000)
  }

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    setCtxMenu({ visible: true, x: e.clientX, y: e.clientY })
  }

  // 开始拖动窗口（鼠标左键按下时）
  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button === 0) {  // 左键
      e.preventDefault()
      startWindowDrag()
    }
  }

  const showTodos = async () => {
    const today = new Date().toISOString().slice(0, 10)
    const t = await getTodos(today)
    setTodos(t)
    setActiveFlow('todos')
  }

  const triggerManualLog = () => {
    const today = new Date().toISOString().slice(0, 10)
    setCurrentDate(today)
    setEveningTodos([])
    setActiveFlow('evening')
    setForceCatState('talk')
  }

  const ctxMenuItems: MenuItem[] = [
    { label: '查看今日待办', icon: '📋', onClick: showTodos },
    { label: '录入工作日志', icon: '📝', onClick: triggerManualLog },
    { label: '生成工作总结', icon: '📊', onClick: showTodos },
    { divider: true },
    { label: '设置', icon: '⚙', onClick: () => openSettings() },
  ]

  return (
    <div className="app-container">
      {/* 右键菜单（放在 app-container 内，但用 CSS 保证在最上层） */}
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

        {/* 晨间问候流程 */}
        {activeFlow === 'morning' && (
          <MorningFlow
            date={currentDate}
            onDone={onMorningDone}
            onSkip={closeFlow}
          />
        )}

        {/* 休息提醒 */}
        {activeFlow === 'break' && (
          <BreakReminder
            elapsedMin={elapsedMin}
            onDone={closeFlow}
          />
        )}

        {/* 晚间复盘 */}
        {activeFlow === 'evening' && (
          <EveningFlow
            date={currentDate}
            todos={eveningTodos}
            onDone={closeFlow}
          />
        )}

        {/* 待办清单展示 */}
        {activeFlow === 'todos' && (
          <SpeechBubble
            visible
            message={todos.length > 0 ? '今日待办：' : '今天还没有待办哦～'}
            onClose={closeFlow}
          >
            {todos.length > 0 && (
              <div className="todos-display">
                {todos.map(t => (
                  <div key={t.id} className={`todo-item ${t.status}`}>
                    <span className="todo-check">{t.status === 'done' ? '✓' : '○'}</span>
                    <span className="todo-title">{t.title}</span>
                    {t.priority === 'high' && <span className="tag-high">紧</span>}
                  </div>
                ))}
              </div>
            )}
            <div className="bubble-actions">
              <button className="btn-secondary" onClick={() => openSettings()}>⚙ 设置</button>
              <button className="btn-primary" onClick={closeFlow}>关闭</button>
            </div>
          </SpeechBubble>
        )}

        {/* 无流程时右键菜单提示 */}
        {activeFlow === 'none' && (
          <div className="idle-hint">右键查看菜单</div>
        )}
      </div>

      {/* 像素猫（可点击拖动） */}
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

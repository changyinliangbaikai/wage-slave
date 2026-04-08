/**
 * 晨间问候流程
 * 触发：到达上班时间 or 开机时在工作时段 or 手动录入
 */

import { useState, useCallback, useEffect, useRef } from 'react'
import SpeechBubble from '../components/SpeechBubble'
import { useParsePlan } from '../hooks/useLLM'
import { saveLog, saveTodos } from '../hooks/useIPC'
import type { TodoItem } from '@shared/types'

interface Props {
  date: string
  onDone: (todos: TodoItem[]) => void
  onSkip: () => void
}

type Step = 'greeting' | 'input' | 'parsing' | 'success' | 'fail' | 'done'

export default function MorningFlow({ date, onDone, onSkip }: Props) {
  const [step, setStep] = useState<Step>('greeting')
  const [input, setInput] = useState('')
  const [parsedTodos, setParsedTodos] = useState<TodoItem[]>([])
  const [failMsg, setFailMsg] = useState('')
  const { parse, loading, error } = useParsePlan()
  const autoCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 成功后自动关闭
  useEffect(() => {
    if (step === 'success') {
      autoCloseTimer.current = setTimeout(() => {
        onDone(parsedTodos)
      }, 2500)
    }
    return () => {
      if (autoCloseTimer.current) clearTimeout(autoCloseTimer.current)
    }
  }, [step, parsedTodos, onDone])

  const handleConfirm = useCallback(async () => {
    if (!input.trim()) { onSkip(); return }

    setStep('parsing')
    try {
      const todos = await parse(input)

      // parse 内部 catch 了错误并返回 []，需要额外判断
      if (todos.length === 0) {
        console.warn('[MorningFlow] Parse returned empty todos, likely failed')
        setFailMsg('解析结果为空，请检查输入内容或网络连接')
        setStep('fail')
        return
      }

      // 保存到本地
      await saveTodos(date, todos)
      await saveLog({ date, plan_input: input, todos, morning_skipped: false })

      setParsedTodos(todos)
      console.log('[MorningFlow] Plan parsed successfully, todo count:', todos.length)
      setStep('success')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error('[MorningFlow] Plan parse failed:', msg)
      setFailMsg(msg)
      setStep('fail')
    }
  }, [input, parse, date, onSkip])

  const handleSkip = useCallback(async () => {
    await saveLog({ date, morning_skipped: true })
    onSkip()
  }, [date, onSkip])

  if (step === 'greeting') {
    return (
      <SpeechBubble
        visible
        message={`早上好！☀️\n今天有什么工作计划吗？`}
        onClose={handleSkip}
      >
        <div className="bubble-actions">
          <button className="btn-secondary" onClick={handleSkip}>先跳过</button>
          <button className="btn-primary" onClick={() => setStep('input')}>来写计划</button>
        </div>
      </SpeechBubble>
    )
  }

  if (step === 'input') {
    return (
      <SpeechBubble
        visible
        message="今天要做什么？随便写，我来帮你整理～"
      >
        <textarea
          rows={4}
          placeholder="例如：上午开评审会，下午写周报，晚点回几封邮件..."
          value={input}
          onChange={e => setInput(e.target.value)}
          autoFocus
          onKeyDown={e => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) handleConfirm()
          }}
        />
        {error && (
          <div style={{ fontSize: 11, color: '#e05a3a', marginTop: 4 }}>
            {error}
          </div>
        )}
        <div className="bubble-actions">
          <button className="btn-secondary" onClick={handleSkip}>跳过</button>
          <button
            className="btn-primary"
            onClick={handleConfirm}
            disabled={loading || !input.trim()}
          >
            确认
          </button>
        </div>
      </SpeechBubble>
    )
  }

  if (step === 'parsing') {
    return (
      <SpeechBubble
        visible
        message="正在整理你的计划，稍等一下喵～"
      />
    )
  }

  if (step === 'success') {
    return (
      <SpeechBubble
        visible
        message={`整理好啦！✅ 共 ${parsedTodos.length} 条待办，加油喵～`}
        onClose={() => onDone(parsedTodos)}
      />
    )
  }

  if (step === 'fail') {
    return (
      <SpeechBubble
        visible
        message={`整理失败了…😿\n${failMsg || error || '未知错误'}`}
        onClose={onSkip}
      >
        <div className="bubble-actions">
          <button className="btn-secondary" onClick={onSkip}>关闭</button>
          <button className="btn-primary" onClick={() => setStep('input')}>重新输入</button>
        </div>
      </SpeechBubble>
    )
  }

  return null
}

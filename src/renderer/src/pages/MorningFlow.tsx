/**
 * 晨间问候流程
 * 触发：到达上班时间 or 开机时在工作时段
 */

import { useState, useCallback } from 'react'
import SpeechBubble from '../components/SpeechBubble'
import { useParsePlan } from '../hooks/useLLM'
import { saveLog, saveTodos } from '../hooks/useIPC'
import type { TodoItem } from '@shared/types'

interface Props {
  date: string
  onDone: (todos: TodoItem[]) => void
  onSkip: () => void
}

type Step = 'greeting' | 'input' | 'parsing' | 'done'

export default function MorningFlow({ date, onDone, onSkip }: Props) {
  const [step, setStep] = useState<Step>('greeting')
  const [input, setInput] = useState('')
  const { parse, loading } = useParsePlan()

  const handleConfirm = useCallback(async () => {
    if (!input.trim()) { onSkip(); return }

    setStep('parsing')
    const todos = await parse(input)

    // 保存到本地
    await saveTodos(date, todos)
    await saveLog({ date, plan_input: input, todos, morning_skipped: false })

    setStep('done')
    onDone(todos)
  }, [input, parse, date, onDone, onSkip])

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

  return null
}

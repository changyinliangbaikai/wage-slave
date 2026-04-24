/**
 * 晚间复盘流程
 * review-todos → supplement（补充日志）→ done
 */

import { useState, useCallback } from 'react'
import SpeechBubble from '../components/SpeechBubble'
import { saveLog, saveTodos } from '../hooks/useIPC'
import type { TodoItem } from '@shared/types'

interface Props {
  date: string
  todos: TodoItem[]          // 当天待办，可能为空（如早上跳过了）
  onDone: () => void
  /** 复盘实际提交成功后触发（区别于 onDone：onDone 在"跳过"/关闭时也会触发） */
  onReviewSubmitted?: (stats: { doneCount: number; totalCount: number }) => void
}

type Step = 'greeting' | 'review-todos' | 'supplement' | 'manual-log' | 'done'

export default function EveningFlow({ date, todos, onDone, onReviewSubmitted }: Props) {
  const [step, setStep] = useState<Step>('greeting')
  const [updatedTodos, setUpdatedTodos] = useState<TodoItem[]>(todos)
  const [logText, setLogText] = useState('')
  const [saving, setSaving] = useState(false)

  const hasTodos = todos.length > 0

  const handleGreetingNext = () => {
    setStep(hasTodos ? 'review-todos' : 'manual-log')
  }

  const toggleTodo = (id: string) => {
    setUpdatedTodos(prev => prev.map(t =>
      t.id === id ? { ...t, status: t.status === 'done' ? 'pending' : 'done' } : t
    ))
  }

  // 勾选完成后，进入补充日志步骤
  const handleTodosNext = useCallback(async () => {
    setSaving(true)
    await saveTodos(date, updatedTodos)
    setSaving(false)
    setStep('supplement')
  }, [date, updatedTodos])

  // 保存补充日志 + 最终提交
  const handleSubmitSupplement = useCallback(async () => {
    setSaving(true)
    const doneCount = updatedTodos.filter(t => t.status === 'done').length
    const summary = `完成 ${doneCount}/${updatedTodos.length} 项任务`
    const eodLog = logText.trim()
      ? `${summary}\n\n${logText.trim()}`
      : summary
    await saveLog({
      date,
      todos: updatedTodos,
      eod_log: eodLog,
      updated_at: new Date().toISOString(),
    })
    setSaving(false)
    setStep('done')
    onReviewSubmitted?.({ doneCount, totalCount: updatedTodos.length })
    setTimeout(onDone, 1500)
  }, [date, updatedTodos, logText, onDone, onReviewSubmitted])

  // 跳过补充，直接保存
  const handleSkipSupplement = useCallback(async () => {
    setSaving(true)
    const doneCount = updatedTodos.filter(t => t.status === 'done').length
    await saveLog({
      date,
      todos: updatedTodos,
      eod_log: `完成 ${doneCount}/${updatedTodos.length} 项任务`,
      updated_at: new Date().toISOString(),
    })
    setSaving(false)
    setStep('done')
    onReviewSubmitted?.({ doneCount, totalCount: updatedTodos.length })
    setTimeout(onDone, 1500)
  }, [date, updatedTodos, onDone, onReviewSubmitted])

  // 无待办时的手动日志
  const handleSubmitManualLog = useCallback(async () => {
    if (!logText.trim()) { onDone(); return }
    setSaving(true)
    await saveLog({ date, eod_log: logText, morning_skipped: true })
    setSaving(false)
    setStep('done')
    // 无待办时只算"写了日志"，用 0/0 表示没有待办统计
    onReviewSubmitted?.({ doneCount: 0, totalCount: 0 })
    setTimeout(onDone, 1500)
  }, [date, logText, onDone, onReviewSubmitted])

  if (step === 'greeting') {
    return (
      <SpeechBubble visible message={`下班啦！🌙\n来看看今天完成得怎么样？`} onClose={onDone}>
        <div className="bubble-actions">
          <button className="btn-secondary" onClick={onDone}>今天不想看</button>
          <button className="btn-primary" onClick={handleGreetingNext}>来复盘一下</button>
        </div>
      </SpeechBubble>
    )
  }

  if (step === 'review-todos') {
    const doneCount = updatedTodos.filter(t => t.status === 'done').length
    return (
      <SpeechBubble visible message={`今天的任务，完成了 ${doneCount}/${updatedTodos.length} 项：`}>
        <div className="todo-review-list">
          {updatedTodos.map(t => (
            <label key={t.id} className="todo-review-item">
              <input
                type="checkbox"
                checked={t.status === 'done'}
                onChange={() => toggleTodo(t.id)}
              />
              <span className={t.status === 'done' ? 'done' : ''}>{t.title}</span>
            </label>
          ))}
        </div>
        <div className="bubble-actions">
          <button className="btn-primary" onClick={handleTodosNext} disabled={saving}>
            {saving ? '保存中...' : '下一步'}
          </button>
        </div>
      </SpeechBubble>
    )
  }

  if (step === 'supplement') {
    return (
      <SpeechBubble visible message="还有什么想补充的吗？\n写下来，周报月报的时候会更丰富哦～">
        <textarea
          rows={4}
          placeholder="今天遇到的问题、推进的进展、临时处理的事项..."
          value={logText}
          onChange={e => setLogText(e.target.value)}
          autoFocus
        />
        <div className="bubble-actions">
          <button className="btn-secondary" onClick={handleSkipSupplement} disabled={saving}>
            跳过
          </button>
          <button className="btn-primary" onClick={handleSubmitSupplement} disabled={saving}>
            {saving ? '保存中...' : '保存'}
          </button>
        </div>
      </SpeechBubble>
    )
  }

  if (step === 'manual-log') {
    return (
      <SpeechBubble visible message="今天忘记写计划了？\n来简单记一下今天做了什么吧～" onClose={onDone}>
        <textarea
          rows={4}
          placeholder="今天主要做了..."
          value={logText}
          onChange={e => setLogText(e.target.value)}
          autoFocus
        />
        <div className="bubble-actions">
          <button className="btn-secondary" onClick={onDone}>算了，跳过</button>
          <button className="btn-primary" onClick={handleSubmitManualLog} disabled={saving}>
            {saving ? '保存中...' : '保存日志'}
          </button>
        </div>
      </SpeechBubble>
    )
  }

  if (step === 'done') {
    return (
      <SpeechBubble visible message="今天辛苦了，好好休息！🐾" />
    )
  }

  return null
}

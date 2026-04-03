/**
 * 晚间复盘流程
 */

import { useState, useCallback } from 'react'
import SpeechBubble from '../components/SpeechBubble'
import { saveLog, saveTodos } from '../hooks/useIPC'
import type { TodoItem } from '@shared/types'

interface Props {
  date: string
  todos: TodoItem[]          // 当天待办，可能为空（如早上跳过了）
  onDone: () => void
}

type Step = 'greeting' | 'review-todos' | 'manual-log' | 'done'

export default function EveningFlow({ date, todos, onDone }: Props) {
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

  const handleSubmitTodos = useCallback(async () => {
    setSaving(true)
    await saveTodos(date, updatedTodos)
    await saveLog({
      date,
      todos: updatedTodos,
      eod_log: `完成 ${updatedTodos.filter(t => t.status === 'done').length}/${updatedTodos.length} 项任务`,
      updated_at: new Date().toISOString(),
    })
    setSaving(false)
    setStep('done')
    setTimeout(onDone, 1500)
  }, [date, updatedTodos, onDone])

  const handleSubmitLog = useCallback(async () => {
    if (!logText.trim()) { onDone(); return }
    setSaving(true)
    await saveLog({ date, eod_log: logText, morning_skipped: true })
    setSaving(false)
    setStep('done')
    setTimeout(onDone, 1500)
  }, [date, logText, onDone])

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
          <button className="btn-primary" onClick={handleSubmitTodos} disabled={saving}>
            {saving ? '保存中...' : '提交复盘'}
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
          <button className="btn-primary" onClick={handleSubmitLog} disabled={saving}>
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

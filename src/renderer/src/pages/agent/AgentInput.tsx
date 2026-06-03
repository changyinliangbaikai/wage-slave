import { useEffect, useRef } from 'react'

interface Props {
  value: string
  onChange: (v: string) => void
  onSubmit: () => void
  onStop: () => void
  running: boolean
  disabled?: boolean
  placeholder?: string
}

/**
 * Agent 多行输入框
 * - Cmd/Ctrl + Enter 发送，Shift + Enter 换行
 * - 执行中替换为"停止"按钮
 */
export function AgentInput({
  value,
  onChange,
  onSubmit,
  onStop,
  running,
  disabled,
  placeholder = '描述你想完成的任务，例如：帮我整理今天的待办并写入日志',
}: Props) {
  const ref = useRef<HTMLTextAreaElement>(null)

  // 自动高度（最大 8 行）
  useEffect(() => {
    const ta = ref.current
    if (!ta) return
    ta.style.height = 'auto'
    const max = 8 * 22  // 约 8 行
    ta.style.height = Math.min(ta.scrollHeight, max) + 'px'
  }, [value])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Cmd / Ctrl + Enter 提交
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      if (!running && !disabled && value.trim()) onSubmit()
    }
  }

  return (
    <div className="agent-input">
      <textarea
        ref={ref}
        className="agent-input__textarea"
        value={value}
        onChange={e => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        rows={2}
        disabled={disabled}
      />
      <div className="agent-input__bar">
        <span className="agent-input__hint">Cmd/Ctrl + Enter 发送 · Shift + Enter 换行</span>
        {running ? (
          <button type="button" className="agent-input__btn agent-input__btn--stop" onClick={onStop}>
            停止
          </button>
        ) : (
          <button
            type="button"
            className="agent-input__btn agent-input__btn--send"
            onClick={onSubmit}
            disabled={disabled || !value.trim()}
          >
            发送
          </button>
        )}
      </div>
    </div>
  )
}

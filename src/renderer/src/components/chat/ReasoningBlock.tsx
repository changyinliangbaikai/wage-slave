import { useState } from 'react'
import { buildReasoningDisplay } from '../../utils/reasoning-display'

export function ReasoningBlock({ content }: { content: string }) {
  const [open, setOpen] = useState(false)
  const display = buildReasoningDisplay(content)
  if (!display.preview) return null

  const summary = display.truncated
    ? `💭 推理过程（${display.cleanedLength} 字，预览 ${display.preview.length} 字）`
    : `💭 推理过程（${display.cleanedLength} 字）`

  return (
    <details className="chat-reasoning" open={open} onToggle={e => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary>{summary}</summary>
      <pre className="chat-reasoning__pre">{display.preview}</pre>
      {display.truncated && (
        <div className="chat-reasoning__more">
          已省略 {display.hiddenLength} 字长推理
        </div>
      )}
    </details>
  )
}

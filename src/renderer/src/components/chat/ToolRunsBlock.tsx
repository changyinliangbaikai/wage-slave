import { useState } from 'react'
import type { UIChatMessage } from '../../hooks/useChat'
import { ToolCallCard } from '../../pages/agent/ToolCallCard'

export function ToolRunsBlock({ runs }: { runs: NonNullable<UIChatMessage['toolRuns']> }) {
  const [filterFailed, setFilterFailed] = useState(false)
  const visibleRuns = filterFailed ? runs.filter(r => r.status === 'error') : runs
  const failedCount = runs.filter(r => r.status === 'error').length

  return (
    <div className="chat-msg__tools">
      {runs.length >= 3 && (
        <div className="chat-msg__tools-bar">
          <span className="chat-msg__tools-count">🔧 {runs.length} 次工具调用{failedCount > 0 && ` · ${failedCount} 失败`}</span>
          {failedCount > 0 && (
            <label className="chat-msg__tools-filter">
              <input type="checkbox" checked={filterFailed} onChange={e => setFilterFailed(e.target.checked)} />
              仅看失败
            </label>
          )}
        </div>
      )}
      {visibleRuns.map(run => <ToolCallCard key={run.id} run={run} />)}
    </div>
  )
}

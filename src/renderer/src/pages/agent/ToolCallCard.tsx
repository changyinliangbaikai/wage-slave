import { useState } from 'react'
import type { ToolRunUI } from '../../hooks/useAgent'

/** 工具调用展示卡片：可折叠查看参数与输出 */
export function ToolCallCard({ run }: { run: ToolRunUI }) {
  const [expanded, setExpanded] = useState(false)
  const { name, arguments: args, status, output, error, durationMs, description } = run

  // 状态色与像素风暖色调对齐（橙棕 / 草绿 / 砖红）
  const statusInfo = {
    pending:  { icon: '⏳', label: '排队', color: '#8b7a5d' },
    running:  { icon: '⚙️', label: '执行中', color: '#c0733a' },
    success:  { icon: '✓',  label: '成功',  color: '#5a8f3c' },
    error:    { icon: '✗',  label: '失败',  color: '#c0392b' },
  }[status]

  return (
    <div className="agent-tool-card" data-status={status}>
      <button
        type="button"
        className="agent-tool-card__header"
        onClick={() => setExpanded(e => !e)}
      >
        <span className="agent-tool-card__icon" style={{ color: statusInfo.color }}>
          {statusInfo.icon}
        </span>
        <span className="agent-tool-card__name">{name}</span>
        <span className="agent-tool-card__status" style={{ color: statusInfo.color }}>
          {statusInfo.label}
        </span>
        {durationMs !== undefined && (
          <span className="agent-tool-card__duration">{durationMs}ms</span>
        )}
        <span className="agent-tool-card__chevron">{expanded ? '▾' : '▸'}</span>
      </button>

      {description && !expanded && (
        <div className="agent-tool-card__desc">{description}</div>
      )}

      {expanded && (
        <div className="agent-tool-card__body">
          <div className="agent-tool-card__section">
            <div className="agent-tool-card__section-title">参数</div>
            <pre className="agent-tool-card__pre">
              {JSON.stringify(args, null, 2)}
            </pre>
          </div>

          {(output || error) && (
            <div className="agent-tool-card__section">
              <div className="agent-tool-card__section-title">
                {error ? '错误' : '输出'}
              </div>
              <pre
                className="agent-tool-card__pre"
                data-variant={error ? 'error' : 'output'}
              >
                {error ?? output}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

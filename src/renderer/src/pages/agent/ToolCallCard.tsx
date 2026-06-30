import { useState } from 'react'
import type { ToolRunUI } from '../../hooks/useAgent'

/** 提取工具参数的精简摘要 */
function getToolArgsSummary(name: string, args: any): string {
  if (!args) return ''
  let parsed = args
  if (typeof args === 'string') {
    try {
      parsed = JSON.parse(args)
    } catch {
      return args.slice(0, 30)
    }
  }
  if (typeof parsed !== 'object') {
    return String(parsed).slice(0, 30)
  }

  const pathVal = parsed.path || parsed.filePath || parsed.targetFile || parsed.file || parsed.absolutePath || parsed.TargetFile
  const cmdVal = parsed.commandLine || parsed.command || parsed.cmd || parsed.CommandLine
  const queryVal = parsed.query || parsed.pattern || parsed.keyword || parsed.Query
  const dirVal = parsed.dir || parsed.directory || parsed.cwd || parsed.Cwd || parsed.DirectoryPath

  if (name.includes('command') && cmdVal) {
    return `cmd: "${truncate(cmdVal, 24)}"`
  }
  if ((name.includes('file') || name.includes('dir')) && pathVal) {
    const fileName = String(pathVal).split(/[\\/]/).pop() || pathVal
    return `path: "${truncate(fileName, 24)}"`
  }
  if ((name.includes('search') || name.includes('grep')) && queryVal) {
    return `query: "${truncate(queryVal, 24)}"`
  }
  if (name.includes('list_dir') && dirVal) {
    const dirName = String(dirVal).split(/[\\/]/).pop() || dirVal
    return `dir: "${truncate(dirName, 24)}"`
  }

  const keys = Object.keys(parsed)
  if (keys.length > 0) {
    const firstKey = keys[0]
    const val = parsed[firstKey]
    if (val !== undefined && val !== null) {
      return `${firstKey}: ${typeof val === 'object' ? '{...}' : `"${truncate(String(val), 20)}"`}`
    }
  }
  return ''
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str
  return str.slice(0, maxLen - 3) + '...'
}

/** 工具调用展示卡片：可折叠查看参数与输出 */
export function ToolCallCard({ run }: { run: ToolRunUI }) {
  const [expanded, setExpanded] = useState(false)
  const { name, arguments: args, status, output, error, durationMs, description, safetyLevel } = run

  const argsSummary = getToolArgsSummary(name, args)

  // 状态色与像素风暖色调对齐（橙棕 / 草绿 / 砖红）
  const statusInfo = {
    pending:  { icon: '⏳', label: '排队', color: '#8b7a5d' },
    running:  { icon: '⚙️', label: '执行中', color: '#c0733a' },
    success:  { icon: '✓',  label: '成功',  color: '#5a8f3c' },
    error:    { icon: '✗',  label: '失败',  color: '#c0392b' },
  }[status]
  const safetyInfo = safetyLevel ? {
    safe: { label: '只读', tone: 'safe' },
    cautious: { label: '写入', tone: 'cautious' },
    sensitive: { label: '敏感', tone: 'sensitive' },
  }[safetyLevel] : null

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
        {argsSummary && (
          <span className="agent-tool-card__args-summary" title={typeof args === 'string' ? args : JSON.stringify(args)}>
            ({argsSummary})
          </span>
        )}
        {safetyInfo && (
          <span className="agent-tool-card__safety" data-tone={safetyInfo.tone}>
            {safetyInfo.label}
          </span>
        )}
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

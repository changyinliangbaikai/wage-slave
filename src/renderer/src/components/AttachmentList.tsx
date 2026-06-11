/**
 * 附件列表组件
 *
 * 展示已添加的文件，支持删除、错误提示
 */

import type { AIChatAttachment } from '@shared/types'
import './AttachmentList.css'

interface AttachmentListProps {
  attachments: AIChatAttachment[]
  onRemove: (id: string) => void
  readOnly?: boolean
}

export function AttachmentList({ attachments, onRemove, readOnly }: AttachmentListProps) {
  if (attachments.length === 0) return null

  return (
    <div className="attachment-list">
      {attachments.map(att => (
        <div
          key={att.id}
          className={`attachment-chip ${att.truncated ? 'truncated' : ''} ${att.status === 'error' ? 'error' : ''}`}
          title={buildTooltip(att)}
        >
          <span className="attachment-icon">{getFileIcon(att.fileType)}</span>
          <span className="attachment-name">{att.fileName}</span>
          <span className="attachment-size">{formatSize(att.sizeBytes)}</span>
          {att.truncated && <span className="attachment-badge">截取</span>}
          {att.status === 'error' && <span className="attachment-badge error">错误</span>}
          {!readOnly && (
            <button
              className="attachment-remove"
              onClick={() => onRemove(att.id)}
              title="移除"
            >
              ×
            </button>
          )}
        </div>
      ))}
    </div>
  )
}

function buildTooltip(att: AIChatAttachment): string {
  const lines = [
    att.fileName,
    `大小: ${formatSize(att.sizeBytes)}`,
    `字符: ${att.charCount.toLocaleString()}`,
  ]
  if (att.truncated) {
    lines.push(`已截取前 ${att.content.length.toLocaleString()} 字符`)
  }
  if (att.error) {
    lines.push(`错误: ${att.error}`)
  }
  return lines.join('\n')
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

function getFileIcon(fileType: string): string {
  const iconMap: Record<string, string> = {
    pdf: '📄',
    doc: '📝',
    docx: '📝',
    xls: '📊',
    xlsx: '📊',
    csv: '📊',
    txt: '📃',
    md: '📃',
    markdown: '📃',
    json: '📋',
    xml: '📋',
    yaml: '📋',
    yml: '📋',
    js: '📜',
    ts: '📜',
    jsx: '📜',
    tsx: '📜',
    vue: '📜',
    py: '🐍',
    java: '☕',
    go: '🐹',
    rs: '🦀',
    c: '🔧',
    cpp: '🔧',
    html: '🌐',
    css: '🎨',
    scss: '🎨',
    sql: '🗃️',
    sh: '🔲',
    bash: '🔲',
    log: '📋',
    default: '📎',
  }
  return iconMap[fileType] || iconMap.default
}

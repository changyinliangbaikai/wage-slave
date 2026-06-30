import { useState } from 'react'

interface ChangedFile {
  path: string
  added: number
  deleted: number
}

interface GitChangeBoxProps {
  files: ChangedFile[]
  onUndo?: () => void
  onApprove?: () => void
}

export default function GitChangeBox({
  files,
  onUndo,
  onApprove,
}: GitChangeBoxProps) {
  const [expanded, setExpanded] = useState(false)

  if (!files || files.length === 0) return null

  const totalAdded = files.reduce((acc, f) => acc + f.added, 0)
  const totalDeleted = files.reduce((acc, f) => acc + f.deleted, 0)

  // Show up to 3 files by default, expand for more
  const visibleFiles = expanded ? files : files.slice(0, 3)
  const remainingCount = files.length - visibleFiles.length

  const getFileBasename = (filePath: string) => {
    return filePath.split(/[\\/]/).pop() || filePath
  }

  return (
    <div className="codex-git-card">
      <div className="git-card__header">
        <div className="git-card__status">
          <span className="git-card__icon">💾</span>
          <span className="git-card__title">已编辑 {files.length} 个文件</span>
          <span className="git-card__stats text-green-red">
            +{totalAdded} -{totalDeleted}
          </span>
        </div>
        <div className="git-card__actions">
          {onUndo && (
            <button type="button" className="git-btn git-btn--undo" onClick={onUndo}>
              撤销 ↩
            </button>
          )}
          {onApprove && (
            <button type="button" className="git-btn git-btn--approve" onClick={onApprove}>
              审核
            </button>
          )}
        </div>
      </div>

      <div className="git-card__file-list">
        {visibleFiles.map((file) => (
          <div className="git-file-item" key={file.path}>
            <span className="git-file-name" title={file.path}>
              {getFileBasename(file.path)}
            </span>
            <span className="git-file-diff">
              +{file.added} -{file.deleted}
            </span>
          </div>
        ))}
      </div>

      {remainingCount > 0 && (
        <button
          type="button"
          className="git-card__more-btn"
          onClick={() => setExpanded(!expanded)}
        >
          再显示 {remainingCount} 个文件 ▾
        </button>
      )}
      {expanded && files.length > 3 && (
        <button
          type="button"
          className="git-card__more-btn"
          onClick={() => setExpanded(false)}
        >
          收起列表 ▴
        </button>
      )}
    </div>
  )
}

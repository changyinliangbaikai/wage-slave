import { useState, useCallback } from 'react'
import { IPC } from '@shared/ipc-channels'
import { useClickOutside } from '../../hooks/useClickOutside'

interface FileCardProps {
  name: string
  truncated?: boolean
}

export default function FileCard({ name, truncated }: FileCardProps) {
  const [showMenu, setShowMenu] = useState(false)

  const closeMenu = useCallback(() => setShowMenu(false), [])
  const menuRef = useClickOutside<HTMLDivElement>(showMenu, closeMenu)

  const getFileExtension = (filename: string) => {
    return filename.split('.').pop()?.toUpperCase() || 'UNKNOWN'
  }

  const handleOpen = () => {
    window.electronAPI.invoke(IPC.SHELL_OPEN_PATH, name)
    setShowMenu(false)
  }

  return (
    <div className="codex-file-card">
      <div className="file-card__icon">📄</div>
      <div className="file-card__info">
        <div className="file-card__name" title={name}>{name.split(/[\\/]/).pop() || name}</div>
        <div className="file-card__meta">
          文档 · {getFileExtension(name)} {truncated && '· (已截取)'}
        </div>
      </div>
      <div className="file-card__actions" ref={menuRef}>
        <button
          type="button"
          className="file-card__menu-btn"
          onClick={() => setShowMenu(!showMenu)}
        >
          打开方式 ▾
        </button>
        {showMenu && (
          <div className="file-card__dropdown">
            <button type="button" className="file-card__dropdown-item" onClick={handleOpen}>
              系统默认打开
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

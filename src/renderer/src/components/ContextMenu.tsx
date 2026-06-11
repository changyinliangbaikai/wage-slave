import { useEffect, useRef, useCallback, useState } from 'react'
import type { CSSProperties } from 'react'
import './ContextMenu.css'

export interface MenuItem {
  label?: string
  icon?: string
  onClick?: () => void
  divider?: boolean
}

interface Props {
  x: number
  y: number
  items: MenuItem[]
  onClose: () => void
}

export default function ContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null)

  // 菜单项点击
  const handleItemClick = useCallback((e: React.MouseEvent, item: MenuItem) => {
    e.preventDefault()
    e.stopPropagation()
    item.onClick?.()
    onClose()
  }, [onClose])

  // 点击菜单外部关闭（使用 mousedown 而非 click，避免时机问题）
  const handleMouseDownOutside = useCallback((e: MouseEvent) => {
    if (ref.current && !ref.current.contains(e.target as Node)) {
      e.preventDefault()
      onClose()
    }
  }, [onClose])

  // ESC 关闭
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
  }, [onClose])

  useEffect(() => {
    // 使用 mousedown（右键点击也会触发），并设置为 useCapture
    window.addEventListener('mousedown', handleMouseDownOutside, true)
    window.addEventListener('keydown', handleKeyDown, true)

    return () => {
      window.removeEventListener('mousedown', handleMouseDownOutside, true)
      window.removeEventListener('keydown', handleKeyDown, true)
    }
  }, [handleMouseDownOutside, handleKeyDown, onClose])

  const [style, setStyle] = useState<CSSProperties>({
    visibility: 'hidden',
    left: x,
    top: y,
  })

  useEffect(() => {
    if (ref.current) {
      const rect = ref.current.getBoundingClientRect()
      const w = rect.width
      const h = rect.height
      const ax = Math.max(0, Math.min(x, window.innerWidth - w - 4))
      const ay = Math.max(0, Math.min(y, window.innerHeight - h - 4))
      setStyle({
        left: ax,
        top: ay,
        visibility: 'visible',
      })
    }
  }, [x, y, items.length])

  return (
    <div
      ref={ref}
      className="context-menu"
      style={style}
      onContextMenu={e => e.preventDefault()}
    >
      {items.map((item, i) =>
        item.divider ? (
          <div key={i} className="menu-divider" />
        ) : (
          <div
            key={i}
            className="menu-item"
            onMouseDown={e => e.stopPropagation()}
            onClick={e => handleItemClick(e, item)}
          >
            {item.icon && <span className="menu-icon">{item.icon}</span>}
            <span className="menu-label">{item.label}</span>
          </div>
        )
      )}
    </div>
  )
}

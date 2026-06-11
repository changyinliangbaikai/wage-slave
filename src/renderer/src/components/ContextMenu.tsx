import { useEffect, useRef, useCallback } from 'react'
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

  // 动态估算菜单的宽高度进行视口内限位，实现完全同步定位，防止 DOM 尚未渲染完成时零宽高引起的错位
  const itemCount = items.filter(item => !item.divider).length
  const dividerCount = items.filter(item => item.divider).length
  const estimatedHeight = itemCount * 31 + dividerCount * 10 + 8
  const estimatedWidth = 180

  const adjustedX = Math.max(0, Math.min(x, window.innerWidth - estimatedWidth - 4))
  const adjustedY = Math.max(0, Math.min(y, window.innerHeight - estimatedHeight - 4))

  return (
    <div
      ref={ref}
      className="context-menu"
      style={{ left: adjustedX, top: adjustedY }}
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

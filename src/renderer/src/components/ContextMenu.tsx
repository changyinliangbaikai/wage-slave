import { useEffect, useLayoutEffect, useRef, useCallback } from 'react'
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

  // ── 使用 useLayoutEffect 测量实际尺寸，精确定位 ──
  // 在浏览器绘制前同步执行：先隐藏菜单 → 测量真实宽高 → 计算位置 → 显示
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return

    // 1. 先放到鼠标位置、隐藏（用于浏览器计算真实布局尺寸）
    el.style.visibility = 'hidden'
    el.style.left = `${x}px`
    el.style.top = `${y}px`

    // 2. 强制布局并测量菜单实际宽高
    const menuW = el.offsetWidth
    const menuH = el.offsetHeight
    const vw = window.innerWidth
    const vh = window.innerHeight

    // 3. 计算最终位置
    // X 轴：默认菜单左边缘在光标位置，如果超出右侧则左移
    let left = x
    if (left + menuW > vw) {
      left = Math.max(0, vw - menuW - 4)
    }

    // Y 轴：默认菜单顶部在光标位置
    // 如果菜单放不下（超出窗口底部），向上推，并确保光标在菜单下方
    let top = y
    if (top + menuH > vh) {
      // 把菜单底部贴近光标上方（留 6px 间距），确保光标不落在菜单上
      top = Math.max(0, y - menuH - 6)
    }

    // 4. 应用最终位置并显示
    el.style.left = `${left}px`
    el.style.top = `${top}px`
    el.style.visibility = 'visible'
  }, [x, y, items])

  return (
    <div
      ref={ref}
      className="context-menu"
      style={{ left: x, top: y, visibility: 'hidden' }}
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

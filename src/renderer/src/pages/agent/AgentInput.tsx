import { useEffect, useMemo, useRef, useState } from 'react'
import { SLASH_COMMANDS, type SlashCommand } from '../ai-chat/slash-commands'

interface Props {
  value: string
  onChange: (v: string) => void
  onSubmit: () => void
  onStop: () => void
  running: boolean
  disabled?: boolean
  placeholder?: string
  onPickFiles?: () => void
  isReadingFiles?: boolean
  /**
   * 立即提交某段文本（用于斜杠菜单选中 immediate=true 的状态控制命令时）：
   * 由父组件直接走 submit 流程，避免依赖 controlled value 的异步 setState
   */
  onInstantSubmit?: (text: string) => void
}

/**
 * Agent 多行输入框
 * - Cmd/Ctrl + Enter 发送，Enter 换行
 * - 执行中替换为"停止"按钮
 * - 输入 `/` 触发斜杠命令菜单：上下键选择，Enter/Tab 选中，Esc 关闭
 * - 菜单中 `immediate: true` 的命令会通过 onInstantSubmit 立即提交（无需用户补充输入）
 */
export function AgentInput({
  value,
  onChange,
  onSubmit,
  onStop,
  running,
  disabled,
  placeholder = '描述你想完成的任务，例如：帮我整理今天的待办并写入日志',
  onPickFiles,
  isReadingFiles,
  onInstantSubmit,
}: Props) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [slashOpen, setSlashOpen] = useState(false)
  const [slashIndex, setSlashIndex] = useState(0)
  const [resolving, setResolving] = useState(false)

  // 保证选中的斜杠命令在可见滚动区域内
  useEffect(() => {
    if (slashOpen && menuRef.current) {
      const menu = menuRef.current
      const activeItem = menu.querySelector('.agent-slash-menu__item.is-active') as HTMLElement
      if (activeItem) {
        const hint = menu.querySelector('.agent-slash-menu__hint') as HTMLElement
        const hintHeight = hint ? hint.offsetHeight : 30

        const menuTop = menu.scrollTop
        const menuBottom = menuTop + menu.clientHeight
        const itemTop = activeItem.offsetTop
        const itemBottom = itemTop + activeItem.offsetHeight

        // 如果向上切换时光标被顶部的 sticky 提示栏盖住，向上滚动
        if (itemTop - hintHeight < menuTop) {
          menu.scrollTop = Math.max(0, itemTop - hintHeight)
        } 
        // 如果向下切换时超出了容器下边界，向下滚动
        else if (itemBottom > menuBottom) {
          menu.scrollTop = itemBottom - menu.clientHeight
        }
      }
    }
  }, [slashIndex, slashOpen])

  // 自动高度（最大 8 行）
  useEffect(() => {
    const ta = ref.current
    if (!ta) return
    ta.style.height = 'auto'
    const max = 8 * 22  // 约 8 行
    ta.style.height = Math.min(ta.scrollHeight, max) + 'px'
  }, [value])

  // 斜杠命令过滤：仅当 value 以 / 开头且光标在第一行时触发
  const slashMatches = useMemo<SlashCommand[]>(() => {
    if (!value.startsWith('/')) return []
    // 只在第一行输入 / 时触发（避免多行文本误触）
    const firstNewline = value.indexOf('\n')
    const firstLine = firstNewline === -1 ? value : value.slice(0, firstNewline)
    if (!firstLine.startsWith('/')) return []
    const query = firstLine.toLowerCase().trim()
    return SLASH_COMMANDS.filter(c => c.trigger.toLowerCase().includes(query.slice(1)) || c.label.includes(query.slice(1)))
  }, [value])

  useEffect(() => {
    const shouldOpen = slashMatches.length > 0 && value.startsWith('/') && !running
    setSlashOpen(shouldOpen)
    if (shouldOpen) setSlashIndex(0)
  }, [slashMatches, value, running])

  // 选中某条斜杠命令：resolve 异步取值或直接用 template
  // immediate=true 的命令直接通过 onInstantSubmit 提交，不在输入框停留
  const pickSlash = async (cmd: SlashCommand) => {
    setSlashOpen(false)
    let text: string | null = null
    if (cmd.resolve) {
      setResolving(true)
      try {
        text = await cmd.resolve()
      } finally {
        setResolving(false)
      }
    } else if (cmd.template != null) {
      text = cmd.template
    }

    if (text == null) {
      window.setTimeout(() => ref.current?.focus(), 0)
      return
    }

    // 状态控制型命令：立即提交，跳过输入框驻留
    if (cmd.immediate && onInstantSubmit && !running && !disabled) {
      // 清空输入框，避免遗留 / 触发的旧文本
      onChange('')
      onInstantSubmit(text.trim())
      return
    }

    onChange(text)
    // 选中后聚焦回输入框，让用户补充参数（针对模板型命令如 /plan、/model）
    window.setTimeout(() => {
      const ta = ref.current
      if (ta) {
        ta.focus()
        // 把光标放到末尾，方便用户继续输入
        const end = ta.value.length
        ta.setSelectionRange(end, end)
      }
    }, 0)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // 斜杠菜单导航：优先拦截
    if (slashOpen && slashMatches.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSlashIndex(i => (i + 1) % slashMatches.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSlashIndex(i => (i - 1 + slashMatches.length) % slashMatches.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        const cmd = slashMatches[slashIndex]
        if (cmd) void pickSlash(cmd)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setSlashOpen(false)
        return
      }
    }

    // Cmd / Ctrl + Enter 提交
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      if (!running && !disabled && value.trim()) onSubmit()
    }
  }

  return (
    <div className="input-capsule-container">
      {/* 斜杠命令浮层 */}
      {slashOpen && slashMatches.length > 0 && (
        <div ref={menuRef} className="agent-slash-menu" role="listbox" aria-label="斜杠命令">
          <div className="agent-slash-menu__hint">选择命令 · ↑↓ 导航 · Enter/Tab 选中 · Esc 关闭</div>
          {slashMatches.map((cmd, i) => (
            <button
              key={cmd.id}
              type="button"
              className={`agent-slash-menu__item ${i === slashIndex ? 'is-active' : ''}`}
              role="option"
              aria-selected={i === slashIndex}
              onMouseEnter={() => setSlashIndex(i)}
              onClick={() => void pickSlash(cmd)}
            >
              <span className="agent-slash-menu__icon">{cmd.icon}</span>
              <span className="agent-slash-menu__label">{cmd.label}</span>
              <span className="agent-slash-menu__trigger">{cmd.trigger}</span>
              <span className="agent-slash-menu__hint-text">{cmd.hint}</span>
            </button>
          ))}
        </div>
      )}

      <textarea
        ref={ref}
        className="input-capsule__textarea"
        value={value}
        onChange={e => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        rows={1}
        disabled={disabled || resolving}
      />
      
      <div className="input-capsule__toolbar">
        <div className="input-capsule__left">
          {onPickFiles && !running && (
            <button
              type="button"
              className="input-capsule__btn"
              onClick={onPickFiles}
              disabled={isReadingFiles || disabled}
              title="添加文件附件"
            >
              📎 {isReadingFiles ? '...' : '添加文件'}
            </button>
          )}
          <button 
            type="button" 
            className="input-capsule__pill"
            onClick={() => {
              onChange('/plan ')
              setTimeout(() => {
                ref.current?.focus()
                const len = ref.current?.value.length ?? 0
                ref.current?.setSelectionRange(len, len)
              }, 0)
            }}
          >
            📋 帮我规划
          </button>
          {resolving && <span className="agent-input__hint">⏳ 正在读取命令...</span>}
        </div>
        
        <div className="input-capsule__right">
          {running ? (
            <button 
              type="button" 
              className="input-capsule__send-btn" 
              onClick={onStop}
              title="停止执行"
              style={{ backgroundColor: 'var(--agent-error, #c0392b)', fontSize: '11px' }}
            >
              ■
            </button>
          ) : (
            <button
              type="button"
              className="input-capsule__send-btn"
              onClick={onSubmit}
              disabled={disabled || (!value.trim() && !onPickFiles)}
              title="发送任务 (Cmd/Ctrl + Enter)"
            >
              ↑
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

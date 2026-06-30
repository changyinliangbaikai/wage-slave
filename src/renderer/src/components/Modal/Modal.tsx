/**
 * Unified Modal / Confirm / Prompt component
 *
 * Replaces native alert/confirm/prompt with pixel-warm styled dialogs that
 * reuse the --agent-* color tokens defined in Chat.css.
 *
 * Usage:
 *   const { alert, confirm, prompt } = useModal()
 *   if (await confirm('删除？')) { ... }
 *   const name = await prompt('输入名称', '默认值')
 *   await alert('操作完成')
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import './Modal.css'

// ─────────────────────────────────────────────
// Modal root controller (singleton via React context-free event bus)
// ─────────────────────────────────────────────
interface ModalRequest {
  id: number
  kind: 'alert' | 'confirm' | 'prompt' | 'confirm-command'
  title: string
  message?: string
  defaultValue?: string
  placeholder?: string
  confirmText?: string
  cancelText?: string
  danger?: boolean
  command?: string
  workDir?: string
  timeoutMs?: number
  reason?: string
  resolve: (value: boolean | string | null) => void
}

let _seq = 0
const _queue: ModalRequest[] = []
type Listener = (queue: ModalRequest[]) => void
const _listeners = new Set<Listener>()
function emit() { _listeners.forEach(l => l([..._queue])) }

function push(req: Omit<ModalRequest, 'id'>): Promise<boolean | string | null> {
  const id = ++_seq
  const promise = new Promise<boolean | string | null>(resolve => {
    _queue.push({ ...req, id, resolve })
    emit()
  })
  return promise
}

function settle(id: number, value: boolean | string | null) {
  const idx = _queue.findIndex(r => r.id === id)
  if (idx === -1) return
  const [req] = _queue.splice(idx, 1)
  req.resolve(value)
  emit()
}

/** Show an alert dialog (single OK button). Resolves to true when dismissed. */
export function alert(message: string, title = '提示'): Promise<boolean> {
  return push({ kind: 'alert', title, message, resolve: () => {} }) as Promise<boolean>
}

/** Show a confirm dialog. Resolves to true (confirm) or false (cancel). */
export function confirm(message: string, title = '确认', danger = false): Promise<boolean> {
  return push({ kind: 'confirm', title, message, danger, resolve: () => {} }) as Promise<boolean>
}

/** Show a prompt dialog with a text input. Resolves to the string, or null if cancelled. */
export function prompt(message: string, defaultValue = '', title = '输入', placeholder?: string): Promise<string | null> {
  return push({ kind: 'prompt', title, message, defaultValue, placeholder, resolve: () => {} }) as Promise<string | null>
}

/** Show a command confirmation dialog. Resolves to true (confirm) or false (cancel). */
export function confirmCommand(command: string, workDir?: string, timeoutMs = 30000, reason?: string): Promise<boolean> {
  return push({ kind: 'confirm-command', title: '🤖 Agent 请求执行命令', command, workDir, timeoutMs, reason, resolve: () => {} }) as Promise<boolean>
}

/** Hook: returns the same alert/confirm/prompt/confirmCommand functions (stable refs). */
export function useModal() {
  return { alert, confirm, prompt, confirmCommand }
}

// ─────────────────────────────────────────────
// Modal renderer: mount once at the app root.
// ─────────────────────────────────────────────
export function ModalRoot() {
  const [queue, setQueue] = useState<ModalRequest[]>([])
  useEffect(() => {
    const l: Listener = q => setQueue(q)
    _listeners.add(l)
    return () => { _listeners.delete(l) }
  }, [])

  const current = queue[0]
  return current ? <ModalDialog key={current.id} req={current} onSettle={settle} /> : null
}

function ModalDialog({ req, onSettle }: { req: ModalRequest; onSettle: (id: number, value: boolean | string | null) => void }) {
  const [text, setText] = useState(req.defaultValue ?? '')
  const [copied, setCopied] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const confirmBtnRef = useRef<HTMLButtonElement>(null)

  // Auto-focus: prompt → input; otherwise → confirm button
  useEffect(() => {
    const t = window.setTimeout(() => {
      if (req.kind === 'prompt') inputRef.current?.focus()
      else confirmBtnRef.current?.focus()
    }, 0)
    return () => window.clearTimeout(t)
  }, [req.kind])

  // Esc → cancel; Enter → confirm (prompt: input Enter)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onSettle(req.id, req.kind === 'prompt' ? null : false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [req.id, req.kind, onSettle])

  const handleConfirm = useCallback(() => {
    if (req.kind === 'prompt') onSettle(req.id, text)
    else onSettle(req.id, true)
  }, [req.id, req.kind, text, onSettle])

  const handleCancel = useCallback(() => {
    onSettle(req.id, req.kind === 'prompt' ? null : false)
  }, [req.id, req.kind, onSettle])

  const handleCopy = useCallback(() => {
    if (req.command) {
      navigator.clipboard.writeText(req.command)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }, [req.command])

  const isCommand = req.kind === 'confirm-command'
  const confirmLabel = req.confirmText ?? (req.kind === 'alert' ? '知道了' : isCommand ? '允许执行' : '确定')
  const cancelLabel = req.cancelText ?? (isCommand ? '拒绝' : '取消')

  return (
    <div className="modal-overlay" onClick={handleCancel} role="dialog" aria-modal="true" aria-label={req.title}>
      {isCommand ? (
        <div className="modal-panel modal-panel--command" onClick={e => e.stopPropagation()}>
          <div className="modal-header">
            <span className="modal-title">🤖 Agent 请求执行命令</span>
            <button type="button" className="modal-close" onClick={handleCancel} aria-label="关闭">×</button>
          </div>
          
          <div className="modal-command-meta">
            <div className="meta-item">
              <span className="meta-label">工作目录:</span>
              <code className="meta-value" title={req.workDir}>{req.workDir || '项目根目录'}</code>
            </div>
            <div className="meta-item">
              <span className="meta-label">超时限制:</span>
              <span className="meta-value">{req.timeoutMs ? `${req.timeoutMs / 1000} 秒` : '无限制'}</span>
            </div>
          </div>

          <div className="modal-command-box-wrapper">
            <pre className="modal-command-pre">
              <code>{req.command}</code>
            </pre>
            <button 
              type="button" 
              className="command-copy-btn" 
              onClick={handleCopy}
            >
              {copied ? '已复制 ✓' : '复制'}
            </button>
          </div>

          {req.reason && (
            <div className="modal-command-reason">
              <span className="reason-icon">🚫</span>
              <span className="reason-text">{req.reason}</span>
            </div>
          )}

          <div className="modal-command-warning">
            ⚠️ 命令将在你本机执行。请务必审核核对，确认该操作安全再放行！
          </div>

          <div className="modal-footer">
            <button type="button" className="modal-btn modal-btn--cancel" onClick={handleCancel}>
              {cancelLabel}
            </button>
            <button
              type="button"
              ref={confirmBtnRef}
              className="modal-btn modal-btn--confirm-execute"
              onClick={handleConfirm}
            >
              {confirmLabel}
            </button>
          </div>
        </div>
      ) : (
        <div className="modal-panel" data-danger={req.danger ?? false} onClick={e => e.stopPropagation()}>
          <div className="modal-header">
            <span className="modal-title">{req.title}</span>
            <button type="button" className="modal-close" onClick={handleCancel} aria-label="关闭">×</button>
          </div>
          {req.message && <div className="modal-body">{req.message}</div>}
          {req.kind === 'prompt' && (
            <div className="modal-body">
              <input
                ref={inputRef}
                className="modal-input"
                type="text"
                value={text}
                placeholder={req.placeholder}
                onChange={e => setText(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') { e.preventDefault(); handleConfirm() }
                }}
              />
            </div>
          )}
          <div className="modal-footer">
            {req.kind !== 'alert' && (
              <button type="button" className="modal-btn modal-btn--cancel" onClick={handleCancel}>
                {cancelLabel}
              </button>
            )}
            <button
              type="button"
              ref={confirmBtnRef}
              className={`modal-btn modal-btn--confirm ${req.danger ? 'modal-btn--danger' : ''}`}
              onClick={handleConfirm}
              disabled={req.kind === 'prompt' && !text.trim() && !req.defaultValue}
            >
              {confirmLabel}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

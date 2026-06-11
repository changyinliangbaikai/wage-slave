import { useEffect, useRef, useState } from 'react'
import './MessageCopyButton.css'

interface MessageCopyButtonProps {
  text: string
  className?: string
}

async function writeClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return
    } catch {
      // Fall through to the textarea fallback for older Electron contexts.
    }
  }

  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.top = '-9999px'
  textarea.style.left = '-9999px'
  document.body.appendChild(textarea)
  textarea.focus()
  textarea.select()
  const copied = document.execCommand('copy')
  document.body.removeChild(textarea)
  if (!copied) throw new Error('copy command failed')
}

export default function MessageCopyButton({ text, className = '' }: MessageCopyButtonProps) {
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<number | null>(null)
  const disabled = text.trim().length === 0

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    }
  }, [])

  const handleCopy = async (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.stopPropagation()
    if (disabled) return

    try {
      await writeClipboard(text)
      setCopied(true)
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
      timerRef.current = window.setTimeout(() => setCopied(false), 1200)
    } catch {
      setCopied(false)
    }
  }

  return (
    <button
      type="button"
      className={`message-copy-button ${copied ? 'is-copied' : ''} ${className}`.trim()}
      onClick={handleCopy}
      disabled={disabled}
      aria-label={copied ? '已复制' : '复制消息'}
      title={copied ? '已复制' : '复制消息'}
    >
      {copied ? '✓' : '⧉'}
    </button>
  )
}

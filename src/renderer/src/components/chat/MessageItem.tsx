import { memo, useMemo } from 'react'
import type { UIChatMessage } from '../../hooks/useChat'
import MessageCopyButton from '../MessageCopyButton'
import { MarkdownRenderer } from '../MarkdownRenderer'
import { alert as modalAlert } from '../Modal/Modal'
import FileCard from './FileCard'
import GitChangeBox from './GitChangeBox'
import { ReasoningBlock } from './ReasoningBlock'
import { ToolRunsBlock } from './ToolRunsBlock'
import { formatTime } from '../../utils/format-time'
import { getMessageCopyText } from '../../utils/chat-helpers'

interface MessageItemProps {
  message: UIChatMessage
  onRegenerate?: () => void
  canRegenerate?: boolean
}

export const MessageItem = memo(function MessageItem({ message, onRegenerate, canRegenerate }: MessageItemProps) {
  const copyText = getMessageCopyText(message)

  // Extract edited files from successful write_file/edit_file tool runs for Git change display
  const editedFiles = useMemo(() => {
    if (!message.toolRuns) return []
    const filesMap = new Map<string, { added: number; deleted: number }>()
    for (const run of message.toolRuns) {
      if (run.status === 'success' && (run.name === 'write_file' || run.name === 'edit_file')) {
        try {
          const args = typeof run.arguments === 'string' ? JSON.parse(run.arguments) : run.arguments
          const filePath = args?.TargetFile || args?.targetFile || args?.path || args?.filePath
          if (filePath) {
            const output = run.output || ''
            let added = 5
            let deleted = 0
            const addedMatch = output.match(/(\d+)\s*insertions?/i) || output.match(/\+(\d+)/)
            const deletedMatch = output.match(/(\d+)\s*deletions?/i) || output.match(/-(\d+)/)
            if (addedMatch) added = parseInt(addedMatch[1], 10)
            if (deletedMatch) deleted = parseInt(deletedMatch[1], 10)

            const key = String(filePath)
            const existing = filesMap.get(key)
            if (existing) {
              filesMap.set(key, { added: existing.added + added, deleted: existing.deleted + deleted })
            } else {
              filesMap.set(key, { added, deleted })
            }
          }
        } catch (e) {
          // Ignore argument parsing errors
        }
      }
    }
    return Array.from(filesMap.entries()).map(([path, stats]) => ({
      path,
      added: stats.added,
      deleted: stats.deleted,
    }))
  }, [message.toolRuns])

  if (message.role === 'user') {
    return (
      <div className="chat-msg chat-msg--user">
        <div className="chat-msg__bubble">
          <MessageCopyButton text={copyText} />
          {message.content}
          {message.attachments && message.attachments.length > 0 && (
            <div className="chat-msg__attachments">
              {message.attachments.map(att => (
                <FileCard key={att.id} name={att.fileName} truncated={att.truncated} />
              ))}
            </div>
          )}
        </div>
        {message.createdAt && <time className="chat-msg__time">{formatTime(message.createdAt)}</time>}
      </div>
    )
  }

  if (message.role === 'assistant') {
    const isLastAssistant = onRegenerate != null
    return (
      <div className="chat-msg chat-msg--assistant">
        <div className="chat-msg__avatar">🐱</div>
        <div className="chat-msg__body">
          <div className="chat-msg__card">
            <MessageCopyButton text={copyText} />
            {message.reasoning && <ReasoningBlock content={message.reasoning} />}

            {editedFiles.length > 0 && (
              <GitChangeBox
                files={editedFiles}
                onApprove={() => {
                  modalAlert('所有变更已审核通过！', '变更审核')
                }}
              />
            )}

            {message.toolRuns && message.toolRuns.length > 0 && (
              <ToolRunsBlock runs={message.toolRuns} />
            )}
            {message.content && (
              <div className="chat-msg__content">
                <MarkdownRenderer content={message.content} streaming={message.streaming} />
              </div>
            )}
            {message.streaming && !message.content && !message.toolRuns?.length && (
              <div className="chat-msg__placeholder">
                <span className="chat__spinner" /> 思考中...
              </div>
            )}
          </div>
          {isLastAssistant && !message.streaming && message.iteration !== -1 && (
            <div className="chat-msg__actions">
              {canRegenerate && (
                <button
                  type="button"
                  className="chat-msg__action-btn"
                  onClick={() => onRegenerate?.()}
                  disabled={!canRegenerate}
                  title="重新生成最后一条回复"
                >
                  ↻ 重新生成
                </button>
              )}
              <MessageCopyButton text={copyText} className="chat-msg__action-btn" />
              {message.createdAt && <time className="chat-msg__time chat-msg__time--inline">{formatTime(message.createdAt)}</time>}
            </div>
          )}
        </div>
      </div>
    )
  }

  return null
})

import type { UIChatMessage } from '../hooks/useChat'

/** 提取消息的可复制纯文本 */
export function getMessageCopyText(message: UIChatMessage): string {
  const parts: string[] = []
  if (message.content.trim()) parts.push(message.content)
  if (message.attachments?.length) {
    parts.push(message.attachments.map(att => `[附件] ${att.fileName}`).join('\n'))
  }
  return parts.join('\n\n')
}

/**
 * 从消息列表里反向找出最近一条带 promptTokens 的 assistant 消息，计算上下文占比
 */
export function computeTokenInfo(messages: UIChatMessage[]): { prompt: number; max: number; ratio: number; cacheHit: number } | null {
  const last = [...messages].reverse().find(m => m.role === 'assistant' && m.metadata?.promptTokens)
  const meta = last?.metadata
  if (!meta?.promptTokens) return null
  const prompt = meta.promptTokens
  const max = meta.maxTokens || 32_768
  const ratio = Math.max(0, Math.min(100, Math.round((prompt / max) * 100)))
  const cacheHit = meta.cacheHitTokens || 0
  return { prompt, max, ratio, cacheHit }
}

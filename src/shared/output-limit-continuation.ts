export const LEGACY_OUTPUT_LIMIT_CONTINUATION_PROMPT =
  '[System Reminder: Output token limit hit. Please resume your response directly from where you were cut off. Do not apologize, do not summarize, just pick up mid-thought and continue.]'

export const OUTPUT_LIMIT_CONTINUATION_PROMPT =
  '[Internal Continuation: Previous model response reached the output token limit. Continue the task from the last assistant state without repeating prior text. Produce only the next required tool call or final answer.]'

const OUTPUT_LIMIT_PROMPTS = [
  LEGACY_OUTPUT_LIMIT_CONTINUATION_PROMPT,
  OUTPUT_LIMIT_CONTINUATION_PROMPT,
] as const

export function isOutputLimitContinuationPrompt(message: { role?: string; content?: string }): boolean {
  if (message.role !== 'user' && message.role !== 'system') return false
  const content = (message.content ?? '').trim()
  if (!content) return false
  if (OUTPUT_LIMIT_PROMPTS.includes(content as typeof OUTPUT_LIMIT_PROMPTS[number])) return true
  return /^\[System Reminder:\s*Output token limit hit\.[\s\S]*?continue\.\]$/i.test(content)
}

export function stripOutputLimitContinuationPrompts(content: string): { text: string; removedCount: number } {
  let text = content
  let removedCount = 0

  for (const prompt of OUTPUT_LIMIT_PROMPTS) {
    const parts = text.split(prompt)
    if (parts.length > 1) {
      removedCount += parts.length - 1
      text = parts.join('')
    }
  }

  text = text.replace(/\[System Reminder:\s*Output token limit hit\.[\s\S]*?continue\.\]/gi, () => {
    removedCount++
    return ''
  })

  return {
    text: text
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
    removedCount,
  }
}

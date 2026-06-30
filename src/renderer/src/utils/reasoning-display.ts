import { stripOutputLimitContinuationPrompts } from '@shared/output-limit-continuation'

const DEFAULT_REASONING_PREVIEW_CHARS = 4000

export interface ReasoningDisplay {
  preview: string
  originalLength: number
  cleanedLength: number
  hiddenLength: number
  truncated: boolean
  removedSystemReminder: boolean
}

export function buildReasoningDisplay(
  content: string,
  previewChars = DEFAULT_REASONING_PREVIEW_CHARS,
): ReasoningDisplay {
  const originalLength = content.length
  const cleaned = stripOutputLimitContinuationPrompts(content)
  const cleanedText = cleaned.text
  const limit = Math.max(0, previewChars)
  const truncated = cleanedText.length > limit
  const preview = truncated ? cleanedText.slice(0, limit).trimEnd() : cleanedText

  return {
    preview,
    originalLength,
    cleanedLength: cleanedText.length,
    hiddenLength: truncated ? cleanedText.length - preview.length : 0,
    truncated,
    removedSystemReminder: cleaned.removedCount > 0,
  }
}

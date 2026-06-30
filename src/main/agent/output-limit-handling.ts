import type { AgentToolCall } from '@shared/types'

export const MAX_OUTPUT_LIMIT_CONTINUATIONS = 1

interface OutputLimitResultLike {
  finishReason: string | null
  content: string
  toolCalls: AgentToolCall[]
}

export function shouldAutoContinueAfterOutputLimit(
  result: OutputLimitResultLike,
  usedContinuations: number,
): boolean {
  return result.finishReason === 'length' &&
    result.toolCalls.length === 0 &&
    usedContinuations < MAX_OUTPUT_LIMIT_CONTINUATIONS
}

export function getToolArgumentParseError(call: Pick<AgentToolCall, 'arguments'>): { error: string; raw: string } | null {
  const args = call.arguments as Record<string, unknown> | undefined
  if (!args || typeof args !== 'object') return null
  const error = args.__parse_error
  if (typeof error !== 'string' || !error) return null
  const raw = typeof args.__raw === 'string' ? args.__raw : ''
  return { error, raw }
}

export function buildToolArgumentParseErrorMessage(call: AgentToolCall): string {
  const parsed = getToolArgumentParseError(call)
  const rawLength = parsed?.raw.length ?? 0
  return [
    `工具 ${call.name} 的参数 JSON 不完整，无法安全执行。`,
    `解析错误：${parsed?.error ?? 'unknown'}`,
    rawLength > 0 ? `已接收的半截参数约 ${rawLength} 字符。` : '',
    '这通常是一次性输出过长的 write_file/edit_file 参数被模型输出上限截断导致的。',
    '不要继续输出同一个超长 JSON；请改为分块写入、缩短单次 content，或先用较小范围的 edit_file/write_file 完成任务。',
  ].filter(Boolean).join('\n')
}

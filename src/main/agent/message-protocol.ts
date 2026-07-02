import type { AgentMessage } from '@shared/types'

const TOOL_RESULT_PREVIEW_CHARS = 1200
const TOOL_ARGUMENT_PREVIEW_CHARS = 500

export interface ToolProtocolRepairResult {
  messages: AgentMessage[]
  repairedCount: number
}

export function hasValidToolProtocol(messages: AgentMessage[]): boolean {
  let pendingToolIds: Set<string> | null = null

  for (const message of messages) {
    if (pendingToolIds && message.role !== 'tool') {
      if (pendingToolIds.size > 0) return false
      pendingToolIds = null
    }

    if (hasToolCalls(message)) {
      if (pendingToolIds && pendingToolIds.size > 0) return false
      const ids = message.tool_calls.map(tc => tc.id).filter(Boolean)
      if (ids.length !== message.tool_calls.length) return false
      pendingToolIds = new Set(ids)
      if (pendingToolIds.size !== ids.length) return false
      continue
    }

    if (message.role === 'tool') {
      const toolCallId = message.tool_call_id
      if (!pendingToolIds || !toolCallId || !pendingToolIds.has(toolCallId)) return false
      pendingToolIds.delete(toolCallId)
    }
  }

  return !pendingToolIds || pendingToolIds.size === 0
}

export function findSafeSuffixStart(
  messages: AgentMessage[],
  preferredStart: number,
  minStart = 0,
): number {
  const lower = clampIndex(minStart, messages.length)
  const start = clampIndex(Math.max(preferredStart, lower), messages.length)
  for (let i = start; i >= lower; i--) {
    if (hasValidToolProtocol(messages.slice(i))) return i
  }
  return lower
}

export function repairToolProtocolHistory(messages: AgentMessage[]): ToolProtocolRepairResult {
  const repaired: AgentMessage[] = []
  let repairedCount = 0

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]

    if (hasToolCalls(message)) {
      const matchingTools = collectMatchingToolResponses(messages, i)
      if (matchingTools.complete) {
        repaired.push(message, ...matchingTools.tools)
        i += matchingTools.tools.length
      } else {
        repaired.push(toolCallingAssistantToPlainMessage(message))
        repairedCount++
      }
      continue
    }

    if (message.role === 'tool') {
      repaired.push(orphanToolToUserMessage(message))
      repairedCount++
      continue
    }

    repaired.push(message)
  }

  return { messages: repaired, repairedCount }
}

export function estimatePromptTokensForMessages(messages: AgentMessage[], extraChars = 0): number {
  const chars = messages.reduce((sum, message) => {
    const toolCallChars = message.tool_calls?.reduce((tcSum, tc) => (
      tcSum + tc.id.length + tc.name.length + tc.arguments.length
    ), 0) ?? 0
    return sum +
      message.role.length +
      (message.content?.length ?? 0) +
      (message.reasoning?.length ?? 0) +
      (message.tool_call_id?.length ?? 0) +
      (message.tool_name?.length ?? 0) +
      toolCallChars
  }, extraChars)
  return Math.max(1, Math.ceil(chars / 4))
}

function hasToolCalls(message: AgentMessage): message is AgentMessage & { tool_calls: NonNullable<AgentMessage['tool_calls']> } {
  return message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0
}

function collectMatchingToolResponses(
  messages: AgentMessage[],
  assistantIndex: number,
): { complete: boolean; tools: AgentMessage[] } {
  const assistant = messages[assistantIndex]
  if (!hasToolCalls(assistant)) return { complete: true, tools: [] }

  const expected = new Set(assistant.tool_calls.map(tc => tc.id))
  const tools: AgentMessage[] = []
  for (let i = assistantIndex + 1; i < messages.length && expected.size > 0; i++) {
    const message = messages[i]
    if (message.role !== 'tool') break
    const toolCallId = message.tool_call_id
    if (!toolCallId || !expected.has(toolCallId)) break
    tools.push(message)
    expected.delete(toolCallId)
  }

  return { complete: expected.size === 0, tools }
}

function toolCallingAssistantToPlainMessage(message: AgentMessage): AgentMessage {
  const { tool_calls: toolCalls, ...rest } = message
  const toolSummary = toolCalls
    .map(tc => `${tc.name}(${trimText(tc.arguments, TOOL_ARGUMENT_PREVIEW_CHARS)})`)
    .join('; ')
  const content = [
    message.content?.trim(),
    `[历史工具调用已转为普通上下文] ${toolSummary}`,
  ].filter(Boolean).join('\n')
  return { ...rest, content }
}

function orphanToolToUserMessage(message: AgentMessage): AgentMessage {
  const {
    tool_call_id: _toolCallId,
    tool_name: _toolName,
    metadata: _metadata,
    ...rest
  } = message
  const toolName = message.tool_name ?? 'unknown'
  return {
    ...rest,
    id: `repaired_${message.id}`,
    role: 'user',
    content: [
      '[历史工具结果已转为普通上下文]',
      `工具：${toolName}`,
      `结果：${trimText(message.content, TOOL_RESULT_PREVIEW_CHARS)}`,
    ].join('\n'),
  }
}

function clampIndex(value: number, max: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(max, Math.floor(value)))
}

function trimText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  return `${value.slice(0, maxChars)}...`
}

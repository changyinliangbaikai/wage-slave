const DEFAULT_TEXT_LIMIT = 1200
const SYSTEM_TEXT_LIMIT = 2000
const GENERIC_TEXT_LIMIT = 4000

export interface TraceMessageLike {
  role: string
  content?: string
  tool_calls?: Array<{
    id: string
    type?: string
    function?: {
      name?: string
      arguments?: string
    }
  }>
  tool_call_id?: string
  name?: string
}

export interface CompactTraceMessage {
  role: string
  content: string
  contentChars: number
  contentTruncated: boolean
  tool_calls?: Array<{
    id: string
    type: string
    function: {
      name: string
      arguments: string
      argumentsChars: number
      argumentsTruncated: boolean
    }
  }>
  tool_call_id?: string
  name?: string
}

export function compactTraceText(text: string, maxChars = DEFAULT_TEXT_LIMIT): string {
  if (text.length <= maxChars) return text

  const marker = `\n[已截断 ${text.length - maxChars} 字]\n`
  const headLen = Math.max(0, Math.floor((maxChars - marker.length) * 0.7))
  const tailLen = Math.max(0, maxChars - marker.length - headLen)
  return `${text.slice(0, headLen)}${marker}${tailLen > 0 ? text.slice(-tailLen) : ''}`
}

export function compactTraceMessages(messages: TraceMessageLike[]): CompactTraceMessage[] {
  return messages.map(message => {
    const content = message.content ?? ''
    const limit = message.role === 'system' ? SYSTEM_TEXT_LIMIT : DEFAULT_TEXT_LIMIT
    const compacted: CompactTraceMessage = {
      role: message.role,
      content: compactTraceText(content, limit),
      contentChars: content.length,
      contentTruncated: content.length > limit,
    }

    if (message.tool_calls && message.tool_calls.length > 0) {
      compacted.tool_calls = message.tool_calls.map(toolCall => {
        const args = toolCall.function?.arguments ?? ''
        const compactArgs = compactTraceText(args, 240)
        return {
          id: toolCall.id,
          type: toolCall.type ?? 'function',
          function: {
            name: toolCall.function?.name ?? '',
            arguments: compactArgs,
            argumentsChars: args.length,
            argumentsTruncated: compactArgs.length !== args.length,
          },
        }
      })
    }

    if (message.tool_call_id) compacted.tool_call_id = message.tool_call_id
    if (message.name) compacted.name = message.name
    return compacted
  })
}

export function summarizeTraceTools(tools: Array<Record<string, any>>): {
  count: number
  names: string[]
  tools: Array<{
    type: string
    function: {
      name: string
      description?: string
    }
  }>
} {
  const summaries = tools.map(tool => {
    const fn = tool.function ?? {}
    return {
      type: String(tool.type ?? 'function'),
      function: {
        name: String(fn.name ?? ''),
        ...(typeof fn.description === 'string'
          ? { description: compactTraceText(fn.description, 200) }
          : {}),
      },
    }
  })

  return {
    count: summaries.length,
    names: summaries.map(tool => tool.function.name),
    tools: summaries,
  }
}

export function compactContextSegments(segments: Array<Record<string, any>>): Array<Record<string, any>> {
  return segments.map(segment => {
    const compacted = { ...segment }
    if (typeof compacted.preview === 'string') {
      compacted.preview = compactTraceText(compacted.preview, 2000)
      compacted.previewChars = segment.preview.length
    }
    if (Array.isArray(compacted.tools)) {
      const toolSummary = summarizeTraceTools(compacted.tools)
      compacted.tools = toolSummary
      compacted.metadata_json = JSON.stringify(toolSummary)
    } else if (typeof compacted.metadata_json === 'string') {
      compacted.metadata_json = compactTraceText(compacted.metadata_json, 2000)
    }
    return compacted
  })
}

export function compactTraceValue(value: unknown, maxChars = GENERIC_TEXT_LIMIT): unknown {
  if (typeof value === 'string') {
    return compactTraceText(value, maxChars)
  }

  if (Array.isArray(value)) {
    return value.map(item => compactTraceValue(item, maxChars))
  }

  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, nested] of Object.entries(value)) {
      result[key] = compactTraceValue(nested, maxChars)
    }
    return result
  }

  return value
}

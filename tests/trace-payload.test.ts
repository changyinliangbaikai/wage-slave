import assert from 'node:assert/strict'
import {
  compactTraceMessages,
  compactTraceText,
  compactTraceValue,
  summarizeTraceTools,
} from '../src/main/agent/trace-payload'

const longText = 'x'.repeat(5000)

const compactedText = compactTraceText(longText, 120)
assert.ok(compactedText.length < 220)
assert.ok(compactedText.includes('[已截断'))

const compactedMessages = compactTraceMessages([
  { role: 'system', content: longText },
  {
    role: 'assistant',
    content: '',
    tool_calls: [
      {
        id: 'call_1',
        type: 'function',
        function: {
          name: 'read_file',
          arguments: JSON.stringify({ path: '/tmp/example.ts', body: longText }),
        },
      },
    ],
  },
])

assert.equal(compactedMessages[0].role, 'system')
assert.equal(compactedMessages[0].contentChars, 5000)
assert.ok(compactedMessages[0].content.length < 2200)
assert.equal(compactedMessages[0].contentTruncated, true)
assert.equal(compactedMessages[1].tool_calls?.[0].function.name, 'read_file')
assert.ok(compactedMessages[1].tool_calls?.[0].function.arguments.length < 300)

const tools = summarizeTraceTools([
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: longText,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: longText },
        },
      },
    },
  },
])

assert.deepEqual(tools.names, ['read_file'])
assert.equal(tools.count, 1)
assert.equal(JSON.stringify(tools).includes(longText), false)

const syntheticTracePayload = {
  events: Array.from({ length: 10 }, (_, i) => ({
    eventType: 'llm.call',
    payload: {
      input: {
        messages: compactTraceMessages(Array.from({ length: 40 }, () => ({ role: 'user', content: longText }))),
        tools,
      },
      output: {
        content: longText,
      },
      iteration: i + 1,
    },
  })),
}

const compactedPayload = compactTraceValue(syntheticTracePayload)
assert.ok(JSON.stringify(compactedPayload).length < 600_000)

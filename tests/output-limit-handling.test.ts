import assert from 'node:assert/strict'
import {
  MAX_OUTPUT_LIMIT_CONTINUATIONS,
  buildToolArgumentParseErrorMessage,
  getToolArgumentParseError,
  shouldAutoContinueAfterOutputLimit,
} from '../src/main/agent/output-limit-handling'

const truncatedWriteCall = {
  id: 'call_1',
  name: 'write_file',
  arguments: {
    __parse_error: 'Unexpected end of JSON input',
    __raw: '{"path": "/tmp/report.md", "content": "# very long',
  },
}

assert.equal(
  shouldAutoContinueAfterOutputLimit({
    finishReason: 'length',
    content: '',
    toolCalls: [],
  }, 0),
  true,
)

assert.equal(
  shouldAutoContinueAfterOutputLimit({
    finishReason: 'length',
    content: '',
    toolCalls: [],
  }, MAX_OUTPUT_LIMIT_CONTINUATIONS),
  false,
)

assert.equal(
  shouldAutoContinueAfterOutputLimit({
    finishReason: 'length',
    content: '',
    toolCalls: [truncatedWriteCall],
  }, 0),
  false,
)

assert.deepEqual(getToolArgumentParseError(truncatedWriteCall), {
  error: 'Unexpected end of JSON input',
  raw: '{"path": "/tmp/report.md", "content": "# very long',
})

const errorMessage = buildToolArgumentParseErrorMessage(truncatedWriteCall)
assert.equal(errorMessage.includes('write_file'), true)
assert.equal(errorMessage.includes('参数 JSON 不完整'), true)
assert.equal(errorMessage.includes('分块'), true)
assert.equal(errorMessage.includes('不要继续输出同一个超长 JSON'), true)

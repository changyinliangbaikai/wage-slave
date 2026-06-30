import assert from 'node:assert/strict'
import {
  LEGACY_OUTPUT_LIMIT_CONTINUATION_PROMPT,
  OUTPUT_LIMIT_CONTINUATION_PROMPT,
  isOutputLimitContinuationPrompt,
  stripOutputLimitContinuationPrompts,
} from '../src/shared/output-limit-continuation'
import { buildReasoningDisplay } from '../src/renderer/src/utils/reasoning-display'

const noisyReasoning = [
  '开始分析',
  LEGACY_OUTPUT_LIMIT_CONTINUATION_PROMPT,
  '继续处理',
  OUTPUT_LIMIT_CONTINUATION_PROMPT,
  '完成结论',
].join('\n')

const stripped = stripOutputLimitContinuationPrompts(noisyReasoning)
assert.equal(stripped.removedCount, 2)
assert.equal(stripped.text.includes('System Reminder'), false)
assert.equal(stripped.text.includes('Output token limit hit'), false)
assert.equal(stripped.text.includes('开始分析'), true)
assert.equal(stripped.text.includes('完成结论'), true)

assert.equal(isOutputLimitContinuationPrompt({ role: 'user', content: LEGACY_OUTPUT_LIMIT_CONTINUATION_PROMPT }), true)
assert.equal(isOutputLimitContinuationPrompt({ role: 'user', content: OUTPUT_LIMIT_CONTINUATION_PROMPT }), true)
assert.equal(isOutputLimitContinuationPrompt({ role: 'assistant', content: LEGACY_OUTPUT_LIMIT_CONTINUATION_PROMPT }), false)

const longDisplay = buildReasoningDisplay(`${noisyReasoning}\n${'长推理'.repeat(1200)}`, 120)
assert.equal(longDisplay.removedSystemReminder, true)
assert.equal(longDisplay.truncated, true)
assert.equal(longDisplay.preview.includes('System Reminder'), false)
assert.equal(longDisplay.preview.includes('Output token limit hit'), false)
assert.ok(longDisplay.preview.length <= 180)
assert.ok(longDisplay.hiddenLength > 0)
assert.ok(longDisplay.originalLength > longDisplay.cleanedLength)

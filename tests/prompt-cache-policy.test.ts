import assert from 'node:assert/strict'
import {
  appendRuntimeContextToUserContent,
  buildRunScopedHistory,
  scaleCompressionConfigForContextWindow,
} from '../src/main/agent/prompt-cache-policy'

const priorHistory = [
  { id: 'u1', role: 'user', content: 'first task', createdAt: 1 },
  { id: 'a1', role: 'assistant', content: 'first answer', createdAt: 2 },
]

const compressedPriorHistory = [
  { id: 'compressed-summary', role: 'user', content: '[早期对话摘要]', createdAt: 3 },
]

const currentRunMessages = [
  { id: 'u2', role: 'user', content: 'current task', createdAt: 4 },
  { id: 'a2', role: 'assistant', content: '', createdAt: 5, tool_calls: [] },
  { id: 't2', role: 'tool', content: 'tool result', createdAt: 6 },
]

assert.deepEqual(
  buildRunScopedHistory([...priorHistory, ...currentRunMessages], priorHistory.length, compressedPriorHistory),
  [...compressedPriorHistory, ...currentRunMessages],
)

assert.equal(
  appendRuntimeContextToUserContent('current task', 'runtime snapshot', '\n# === 激活技能 ===\nskill prompt'),
  'current task\nruntime snapshot\n# === 激活技能 ===\nskill prompt',
)

assert.equal(appendRuntimeContextToUserContent('current task'), 'current task')

assert.deepEqual(
  scaleCompressionConfigForContextWindow({
    keepRecent: 20,
    maxToolChars: 8000,
    keepRecentTools: 6,
    triggerLevel1Chars: 24000,
    triggerLevel2Chars: 48000,
    triggerLevel3Chars: 80000,
    triggerCount: 50,
  }, 200000, 64000),
  {
    keepRecent: 20,
    maxToolChars: 8000,
    keepRecentTools: 6,
    triggerLevel1Chars: 75000,
    triggerLevel2Chars: 150000,
    triggerLevel3Chars: 250000,
    triggerCount: 156,
  },
)

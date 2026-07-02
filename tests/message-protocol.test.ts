import assert from 'node:assert/strict'
import type { AgentMessage } from '../src/shared/types'
import {
  estimatePromptTokensForMessages,
  findSafeSuffixStart,
  hasValidToolProtocol,
  repairToolProtocolHistory,
} from '../src/main/agent/message-protocol'

const validToolRun: AgentMessage[] = [
  msg('user', 'u1', 'run three commands'),
  {
    ...msg('assistant', 'a1', ''),
    tool_calls: [
      { id: 'call_a', name: 'run_command', arguments: '{"command":"pwd"}' },
      { id: 'call_b', name: 'run_command', arguments: '{"command":"date"}' },
      { id: 'call_c', name: 'run_command', arguments: '{"command":"uname"}' },
    ],
  },
  tool('t1', 'call_a', 'pwd result'),
  tool('t2', 'call_b', 'date result'),
  tool('t3', 'call_c', 'uname result'),
  msg('assistant', 'a2', 'done'),
]

assert.equal(hasValidToolProtocol(validToolRun), true)

assert.equal(
  findSafeSuffixStart(validToolRun, 2, 1),
  1,
  'safe suffix must expand backward to include the assistant tool_calls message',
)

const brokenManualCompact: AgentMessage[] = [
  msg('user', 'u1', 'initial request'),
  msg('user', 'compact', '[早期会话已手动压缩，以下为前情概要]'),
  tool('t1', 'call_a', 'pwd result'),
  tool('t2', 'call_b', 'date result'),
  tool('t3', 'call_c', 'uname result'),
  msg('assistant', 'a2', 'done'),
  msg('user', 'u2', 'continue'),
]

assert.equal(hasValidToolProtocol(brokenManualCompact), false)

const repaired = repairToolProtocolHistory(brokenManualCompact)
assert.equal(repaired.repairedCount, 3)
assert.equal(hasValidToolProtocol(repaired.messages), true)
assert.deepEqual(
  repaired.messages.slice(2, 5).map(m => m.role),
  ['user', 'user', 'user'],
  'orphan tool results are preserved as ordinary context instead of API tool messages',
)

const incompleteToolRun: AgentMessage[] = [
  msg('user', 'u1', 'run command'),
  {
    ...msg('assistant', 'a1', ''),
    tool_calls: [{ id: 'call_a', name: 'run_command', arguments: '{"command":"pwd"}' }],
  },
  msg('user', 'u2', 'next request'),
]

assert.equal(hasValidToolProtocol(incompleteToolRun), false)
assert.equal(hasValidToolProtocol(repairToolProtocolHistory(incompleteToolRun).messages), true)
assert.ok(estimatePromptTokensForMessages(repaired.messages) > 0)

function msg(role: AgentMessage['role'], id: string, content: string): AgentMessage {
  return { id, role, content, createdAt: Number(id.replace(/\D/g, '') || 1) }
}

function tool(id: string, toolCallId: string, content: string): AgentMessage {
  return {
    id,
    role: 'tool',
    content,
    tool_call_id: toolCallId,
    tool_name: 'run_command',
    createdAt: Number(id.replace(/\D/g, '') || 1),
  }
}

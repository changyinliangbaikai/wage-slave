/**
 * Agent 主进程类型入口。
 *
 * 具体 IPC / 持久化类型定义在 @shared/types 中，主进程通过本文件保持 Agent 模块结构稳定。
 */

export type {
  AgentChunkPayload,
  AgentDonePayload,
  AgentErrorPayload,
  AgentMessage,
  AgentSession,
  AgentToolCall,
  AgentToolExecutedPayload,
  AgentToolExecutingPayload,
  AgentToolResult,
  AgentToolStartPayload,
} from '@shared/types'

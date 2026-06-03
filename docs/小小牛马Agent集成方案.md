# 小小牛马 Agent 能力集成方案

> 基于像素猫现有架构，设计可自主规划、执行、纠错的 Agent 系统

---

## 一、现状分析

### 现有架构（已非常完善）

```
小小牛马 v2.0.0
├── Electron 29 + React 18 + TypeScript 5.3
├── 主进程: 窗口管理 / IPC / 定时器 / 键鼠监测 / LLM服务 / AI对话服务 / 桌宠包
├── 渲染进程: 像素猫 / 气泡 / 晨间/晚间流程 / AI对话(~1770行) / 设置 / 工具
├── 数据层: JSON 原子写入 (config/logs/todos/ai-chats/scheduler)
└── LLM 集成: 计划解析 + 总结生成 + 完整AI对话(流式SSE/多角色/斜杠命令)
```

### 当前 LLM 使用方式的局限

| 现状 | 局限 |
|------|------|
| 计划解析：单次 system + user → 一次性返回 | 无多轮推理，无法处理复杂任务 |
| 总结生成：单次 system + user → 流式返回 | 只能做总结，不能执行操作 |
| AI 对话：多轮对话 + 角色 + 斜杠命令 | 只能聊天，不能操作本地文件和系统 |
| 斜杠命令：硬编码 12 条 | 无法扩展，无法组合 |

### Agent 要解决的核心问题

**让小猫从"能聊天"变成"能干活"**：
- 用户说"帮我整理今天的会议记录" → Agent 自动读取文件 → 整理 → 写入日志
- 用户说"帮我看看这个代码有什么问题" → Agent 读取代码 → 分析 → 给出建议
- 用户说"每周五下午自动生成本周工作总结" → Agent 规划 → 定时执行 → 通知用户

---

## 二、整体设计

### 2.1 架构总览

```
┌─────────────────────────────────────────────────────────────────┐
│                        渲染进程 (React)                          │
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │  Agent 对话页 │  │  任务看板    │  │  执行日志面板        │  │
│  │  (新窗口)     │  │  (组件)      │  │  (组件)              │  │
│  └──────┬───────┘  └──────┬───────┘  └──────────┬───────────┘  │
│         │ IPC             │ IPC                  │ IPC          │
├─────────┼─────────────────┼──────────────────────┼──────────────┤
│         ▼                 ▼                      ▼              │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                   主进程 Agent 引擎                       │   │
│  │                                                          │   │
│  │  ┌────────────┐  ┌────────────┐  ┌────────────────────┐ │   │
│  │  │ Agent      │  │ Tool       │  │ Skill              │ │   │
│  │  │ Orchestrator│  │ Executor   │  │ Registry           │ │   │
│  │  │ (编排器)   │  │ (工具执行) │  │ (技能注册)         │ │   │
│  │  └─────┬──────┘  └─────┬──────┘  └─────────┬──────────┘ │   │
│  │        │               │                    │            │   │
│  │  ┌─────▼───────────────▼────────────────────▼──────────┐ │   │
│  │  │              Context Manager (上下文管理)            │ │   │
│  │  │  System Prompt Builder + Tool Schema + History      │ │   │
│  │  └─────────────────────┬───────────────────────────────┘ │   │
│  │                        │                                  │   │
│  │  ┌─────────────────────▼───────────────────────────────┐ │   │
│  │  │              LLM Client (复用现有 llm-service)       │ │   │
│  │  │  流式 SSE + 多轮对话 + Token 统计 + 错误重试        │ │   │
│  │  └─────────────────────────────────────────────────────┘ │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                 │
│  现有模块 (复用): llm-service.ts / ai-chat-service.ts / store.ts │
│                  activity-monitor.ts / scheduler.ts / windows.ts │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 核心设计原则

1. **复用优先**：不重写 LLM 调用、流式处理、Token 统计，在现有 `llm-service.ts` 和 `ai-chat-service.ts` 上扩展
2. **渐进增强**：Agent 是新增能力，不影响现有晨间/晚间/AI对话功能
3. **主进程执行**：工具调用在主进程执行（已有 IPC 基础设施），渲染进程只负责 UI
4. **小猫人格一致**：Agent 的 System Prompt 延续"小小牛马"的角色设定

---

## 三、核心模块设计

### 3.1 Agent Orchestrator（编排器）

**位置**：`src/main/agent/orchestrator.ts`

这是 Agent 的大脑，负责：
- 构建每次 LLM 请求的完整上下文（System Prompt + Tool Schema + 对话历史）
- 解析 LLM 返回的工具调用请求
- 调度工具执行
- 处理执行结果并决定是否继续
- 错误恢复和重试

```typescript
// src/main/agent/orchestrator.ts

import { getConfig } from '../store'
import { executeTool, type ToolCall, type ToolResult } from './tool-executor'
import { buildSystemPrompt, type AgentContext } from './system-prompt'
import { getActiveToolSchemas } from './tool-registry'
import type { AgentMessage, AgentSession } from './types'

/**
 * Agent 编排器
 * 
 * 执行循环:
 *   1. 构建上下文 (System Prompt + Tools + History)
 *   2. 发送 LLM 请求 (流式)
 *   3. 解析 LLM 返回 → 如果有工具调用 → 执行工具 → 将结果注入上下文 → 回到步骤 2
 *   4. 如果 LLM 返回纯文本 → 任务完成 → 返回结果
 */
export class AgentOrchestrator {

  private history: AgentMessage[] = []
  private abortController: AbortController | null = null
  private sessionId: string

  constructor(sessionId: string) {
    this.sessionId = sessionId
  }

  /**
   * 执行 Agent 任务
   * @param userInput 用户输入
   * @param context Agent 上下文（当前文件、配置等）
   * @param callbacks 流式回调
   */
  async run(
    userInput: string,
    context: AgentContext,
    callbacks: AgentCallbacks,
  ): Promise<AgentResult> {
    
    this.abortController = new AbortController()
    
    // 添加用户消息到历史
    this.history.push({ role: 'user', content: userInput })

    let iteration = 0
    const maxIterations = 20  // 防止无限循环
    let finalOutput = ''

    while (iteration < maxIterations) {
      iteration++
      
      // ── 步骤 1: 构建完整上下文 ──
      const systemPrompt = buildSystemPrompt(context)
      const toolSchemas = getActiveToolSchemas()
      
      const messages = [
        { role: 'system' as const, content: systemPrompt },
        ...this.history.map(m => ({ role: m.role, content: m.content })),
      ]

      // ── 步骤 2: 调用 LLM (流式) ──
      let accumulatedContent = ''
      let accumulatedReasoning = ''
      let toolCalls: ToolCall[] = []

      await this.streamLLM({
        messages,
        tools: toolSchemas,
        signal: this.abortController.signal,
        onChunk: (content, reasoning) => {
          accumulatedContent = content
          accumulatedReasoning = reasoning
          // 实时推送给 UI
          callbacks.onChunk({
            sessionId: this.sessionId,
            content,
            reasoning,
            iteration,
          })
        },
        onToolCall: (calls) => {
          toolCalls = calls
        },
      })

      // ── 步骤 3: 判断是否有工具调用 ──
      if (toolCalls.length === 0) {
        // 没有工具调用 → 任务完成
        finalOutput = accumulatedContent
        this.history.push({
          role: 'assistant',
          content: finalOutput,
          reasoning: accumulatedReasoning || undefined,
        })
        break
      }

      // ── 步骤 4: 执行工具 ──
      callbacks.onToolExecutionStart({
        sessionId: this.sessionId,
        toolCalls: toolCalls.map(tc => ({
          id: tc.id,
          name: tc.name,
          description: getToolDescription(tc.name),
        })),
      })

      const toolResults: ToolResult[] = []
      for (const tc of toolCalls) {
        callbacks.onToolExecuting({
          sessionId: this.sessionId,
          toolId: tc.id,
          toolName: tc.name,
        })

        const result = await executeTool(tc, context)
        toolResults.push(result)

        callbacks.onToolExecuted({
          sessionId: this.sessionId,
          toolId: tc.id,
          toolName: tc.name,
          success: !result.error,
          output: result.output,
          error: result.error,
        })

        // 如果工具执行失败且标记为不可恢复，提前退出
        if (result.error && result.fatal) {
          callbacks.onError({
            sessionId: this.sessionId,
            error: `工具 ${tc.name} 执行失败: ${result.error}`,
            fatal: true,
          })
          return { success: false, error: result.error, iterations: iteration }
        }
      }

      // ── 步骤 5: 将工具结果注入历史，继续循环 ──
      this.history.push({
        role: 'assistant',
        content: accumulatedContent || '(执行工具调用)',
        tool_calls: toolCalls.map(tc => ({
          id: tc.id,
          name: tc.name,
          arguments: JSON.stringify(tc.arguments),
        })),
      })

      for (const tr of toolResults) {
        this.history.push({
          role: 'tool',
          content: tr.error ? `错误: ${tr.error}` : tr.output,
          tool_call_id: tr.toolCallId,
          tool_name: tr.toolName,
        })
      }
    }

    // 通知完成
    callbacks.onDone({
      sessionId: this.sessionId,
      content: finalOutput,
      iterations,
    })

    return { success: true, output: finalOutput, iterations }
  }

  /**
   * 中断当前执行
   */
  abort(): void {
    this.abortController?.abort()
  }

  /**
   * 流式调用 LLM
   * 复用现有 llm-service.ts 的 SSE 基础设施
   */
  private async streamLLM(params: StreamLLMParams): Promise<void> {
    const config = getConfig()
    const baseUrl = config.llm_api_url.replace(/\/$/, '')
    const apiKey = await this.getApiKey()

    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: config.llm_model,
        messages: params.messages,
        tools: params.tools,
        tool_choice: 'auto',
        temperature: 0.3,
        max_tokens: 4096,
        stream: true,
      }),
      signal: params.signal,
    })

    if (!res.ok) {
      throw new Error(`LLM API 返回 ${res.status}: ${await res.text()}`)
    }

    // 复用现有的 SSE 解析逻辑
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let accumulated = ''
    let accumulatedReasoning = ''
    let toolCallBuffer: Map<number, { id: string; name: string; arguments: string }> = new Map()

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      const chunk = decoder.decode(value, { stream: true })
      const lines = chunk.split('\n').filter(l => l.startsWith('data: '))

      for (const line of lines) {
        const json = line.slice(6).trim()
        if (json === '[DONE]') break

        try {
          const delta = JSON.parse(json)
          const choice = delta.choices?.[0]
          
          // 文本内容
          const content = choice?.delta?.content ?? ''
          accumulated += content
          
          // 推理内容
          const reasoning = choice?.delta?.reasoning_content ?? ''
          accumulatedReasoning += reasoning

          // 工具调用 (OpenAI 格式: tool_calls 数组)
          const toolCallDeltas = choice?.delta?.tool_calls
          if (toolCallDeltas) {
            for (const tc of toolCallDeltas) {
              const idx = tc.index
              if (!toolCallBuffer.has(idx)) {
                toolCallBuffer.set(idx, { id: tc.id ?? '', name: tc.function?.name ?? '', arguments: '' })
              }
              const buf = toolCallBuffer.get(idx)!
              if (tc.id) buf.id = tc.id
              if (tc.function?.name) buf.name = tc.function.name
              if (tc.function?.arguments) buf.arguments += tc.function.arguments
            }
          }

          params.onChunk(accumulated, accumulatedReasoning)
        } catch { /* 跳过非 JSON 行 */ }
      }
    }

    // 解析完整的工具调用
    const toolCalls: ToolCall[] = []
    for (const [, buf] of toolCallBuffer) {
      if (buf.id && buf.name) {
        toolCalls.push({
          id: buf.id,
          name: buf.name,
          arguments: JSON.parse(buf.arguments || '{}'),
        })
      }
    }
    params.onToolCall(toolCalls)
  }
}
```

### 3.2 Tool Executor（工具执行器）

**位置**：`src/main/agent/tool-executor.ts`

工具执行是 Agent 区别于普通聊天的关键。每个工具对应一个具体的本地操作能力。

```typescript
// src/main/agent/tool-executor.ts

import { exec, execFile, spawn } from 'child_process'
import { promisify } from 'util'
import * as fs from 'fs/promises'
import * as path from 'path'
import log from 'electron-log/main'

const execAsync = promisify(exec)

export interface ToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

export interface ToolResult {
  toolCallId: string
  toolName: string
  output: string
  error?: string
  fatal?: boolean  // 是否不可恢复
}

/**
 * 工具执行入口
 * 根据工具名称分发到对应的处理函数
 */
export async function executeTool(
  call: ToolCall,
  context: AgentContext,
): Promise<ToolResult> {
  const startTime = Date.now()
  
  try {
    log.info(`[Agent Tool] 执行: ${call.name}`, call.arguments)
    
    let result: string
    
    switch (call.name) {
      // ── 文件操作 ──
      case 'read_file':
        result = await toolReadFile(call.arguments as ReadFileArgs)
        break
      case 'write_file':
        result = await toolWriteFile(call.arguments as WriteFileArgs)
        break
      case 'edit_file':
        result = await toolEditFile(call.arguments as EditFileArgs)
        break
      case 'list_files':
        result = await toolListFiles(call.arguments as ListFilesArgs)
        break
      case 'search_files':
        result = await toolSearchFiles(call.arguments as SearchFilesArgs)
        break
        
      // ── 命令执行 ──
      case 'run_command':
        result = await toolRunCommand(call.arguments as RunCommandArgs)
        break
        
      // ── 小牛马数据操作 ──
      case 'get_today_log':
        result = await toolGetTodayLog()
        break
      case 'get_todos':
        result = await toolGetTodos()
        break
      case 'save_todo':
        result = await toolSaveTodo(call.arguments as SaveTodoArgs)
        break
      case 'update_todo':
        result = await toolUpdateTodo(call.arguments as UpdateTodoArgs)
        break
      case 'append_log':
        result = await toolAppendLog(call.arguments as AppendLogArgs)
        break
      case 'get_logs_range':
        result = await toolGetLogsRange(call.arguments as GetLogsRangeArgs)
        break
        
      // ── 系统操作 ──
      case 'open_file':
        result = await toolOpenFile(call.arguments as OpenFileArgs)
        break
      case 'show_notification':
        result = await toolShowNotification(call.arguments as ShowNotificationArgs)
        break
        
      // ── 等待/延迟 ──
      case 'wait':
        await new Promise(r => setTimeout(r, (call.arguments as WaitArgs).ms))
        result = `等待了 ${(call.arguments as WaitArgs).ms}ms`
        break
        
      default:
        return {
          toolCallId: call.id,
          toolName: call.name,
          output: '',
          error: `未知工具: ${call.name}`,
          fatal: false,
        }
    }

    const elapsed = Date.now() - startTime
    log.info(`[Agent Tool] ${call.name} 完成 (${elapsed}ms)`)
    
    return {
      toolCallId: call.id,
      toolName: call.name,
      output: result,
    }
    
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    log.error(`[Agent Tool] ${call.name} 失败:`, msg)
    return {
      toolCallId: call.id,
      toolName: call.name,
      output: '',
      error: msg,
      fatal: false,
    }
  }
}

// ═══════════════════════════════════════════════════════
// 工具实现
// ═══════════════════════════════════════════════════════

async function toolReadFile(args: ReadFileArgs): Promise<string> {
  const content = await fs.readFile(args.path, 'utf-8')
  if (args.max_lines && args.max_lines > 0) {
    const lines = content.split('\n')
    const start = args.offset ?? 0
    const end = start + args.max_lines
    return lines.slice(start, end).join('\n')
  }
  return content
}

async function toolWriteFile(args: WriteFileArgs): Promise<string> {
  // 安全检查：不允许写入系统目录
  assertSafePath(args.path)
  
  // 确保目录存在
  await fs.mkdir(path.dirname(args.path), { recursive: true })
  await fs.writeFile(args.path, args.content, 'utf-8')
  return `文件已写入: ${args.path} (${args.content.length} 字符)`
}

async function toolEditFile(args: EditFileArgs): Promise<string> {
  assertSafePath(args.path)
  
  const content = await fs.readFile(args.path, 'utf-8')
  
  if (args.replace_all) {
    const count = (content.match(new RegExp(escapeRegex(args.old_string), 'g')) || []).length
    const newContent = content.split(args.old_string).join(args.new_string)
    await fs.writeFile(args.path, newContent, 'utf-8')
    return `替换了 ${count} 处`
  } else {
    if (!content.includes(args.old_string)) {
      throw new Error(`未找到文本: "${args.old_string.slice(0, 50)}..."`)
    }
    const newContent = content.replace(args.old_string, args.new_string)
    await fs.writeFile(args.path, newContent, 'utf-8')
    return `替换成功`
  }
}

async function toolListFiles(args: ListFilesArgs): Promise<string> {
  const entries = await fs.readdir(args.path, { withFileTypes: true })
  const items = entries
    .filter(e => {
      if (args.pattern) {
        const regex = globToRegex(args.pattern)
        return regex.test(e.name)
      }
      return true
    })
    .map(e => `${e.isDirectory() ? '[DIR]' : '[FILE]'} ${e.name}`)
    .join('\n')
  return items || '(空目录)'
}

async function toolSearchFiles(args: SearchFilesArgs): Promise<string> {
  // 使用 grep -r 或 find 搜索文件内容
  const { stdout } = await execAsync(
    `grep -r -l "${args.query}" ${args.path} ${args.file_pattern ? '--include=' + args.file_pattern : ''}`,
    { timeout: 10000 }
  )
  return stdout.trim() || '未找到匹配文件'
}

async function toolRunCommand(args: RunCommandArgs): Promise<string> {
  const timeout = args.timeout_ms ?? 30000
  
  // 安全检查
  if (isDangerousCommand(args.command)) {
    throw new Error('命令被安全策略阻止')
  }

  const { stdout, stderr } = await execAsync(args.command, {
    timeout,
    cwd: args.work_dir,
    maxBuffer: 1024 * 1024, // 1MB
  })
  
  return [stdout, stderr].filter(Boolean).join('\n')
}

// ── 小牛马数据操作工具 ──

async function toolGetTodayLog(): Promise<string> {
  const { getLog } = await import('../store')
  const today = new Date().toISOString().slice(0, 10)
  const log = getLog(today)
  if (!log) return '今天还没有工作日志'
  return JSON.stringify(log, null, 2)
}

async function toolGetTodos(): Promise<string> {
  const { getTodos } = await import('../store')
  const todos = getTodos()
  if (todos.length === 0) return '当前没有待办事项'
  return todos.map(t => 
    `[${t.status === 'done' ? '✓' : '✗'}] ${t.title} (优先级: ${t.priority})`
  ).join('\n')
}

async function toolSaveTodo(args: SaveTodoArgs): Promise<string> {
  const { getTodos, saveTodos } = await import('../store')
  const todos = getTodos()
  const newTodo = {
    id: String(Date.now()),
    title: args.title,
    priority: args.priority ?? 'medium',
    estimated_min: args.estimated_min ?? null,
    status: 'pending' as const,
  }
  todos.push(newTodo)
  saveTodos(todos)
  return `已添加待办: ${newTodo.title}`
}

async function toolUpdateTodo(args: UpdateTodoArgs): Promise<string> {
  const { getTodos, saveTodos } = await import('../store')
  const todos = getTodos()
  const idx = todos.findIndex(t => t.id === args.id)
  if (idx === -1) throw new Error(`未找到待办: ${args.id}`)
  
  if (args.status) todos[idx].status = args.status
  if (args.title) todos[idx].title = args.title
  if (args.priority) todos[idx].priority = args.priority
  
  saveTodos(todos)
  return `已更新待办: ${todos[idx].title}`
}

async function toolAppendLog(args: AppendLogArgs): Promise<string> {
  const { getLog, saveLog } = await import('../store')
  const today = new Date().toISOString().slice(0, 10)
  const log = getLog(today) || createEmptyLog(today)
  
  if (args.append_to === 'eod_log') {
    log.eod_log = (log.eod_log ? log.eod_log + '\n' : '') + args.content
  } else {
    // 追加到自定义字段
    log[args.append_to] = args.content
  }
  
  saveLog(log)
  return `已追加到 ${today} 的工作日志`
}

async function toolGetLogsRange(args: GetLogsRangeArgs): Promise<string> {
  const { getLogsInRange } = await import('../store')
  const logs = getLogsInRange(args.start_date, args.end_date)
  if (logs.length === 0) return '该时间段没有日志'
  return logs.map(l => 
    `## ${l.date}\n待办: ${l.todos.length} 条\n记录: ${l.eod_log.slice(0, 100)}...`
  ).join('\n\n')
}

async function toolOpenFile(args: OpenFileArgs): Promise<string> {
  const { shell } = await import('electron')
  await shell.openPath(args.path)
  return `已打开: ${args.path}`
}

async function toolShowNotification(args: ShowNotificationArgs): Promise<string> {
  // 通过 IPC 通知渲染进程显示通知
  const { getMainWindow } = await import('../windows')
  const win = getMainWindow()
  win?.webContents.send('agent:notification', {
    title: args.title,
    body: args.body,
  })
  return `已发送通知: ${args.title}`
}

// ═══════════════════════════════════════════════════════
// 安全工具
// ═══════════════════════════════════════════════════════

function assertSafePath(filePath: string): void {
  const resolved = path.resolve(filePath)
  const allowedPrefixes = [
    path.join(process.env.APPDATA || '', 'xiao-niu-ma'),
    path.join(process.env.HOME || process.env.USERPROFILE || '', 'Desktop'),
    path.join(process.env.HOME || process.env.USERPROFILE || '', 'Documents'),
    path.join(process.env.HOME || process.env.USERPROFILE || '', 'Downloads'),
    '/tmp',
  ]
  
  const isAllowed = allowedPrefixes.some(prefix => resolved.startsWith(prefix))
  if (!isAllowed) {
    throw new Error(`安全限制: 不允许访问路径 ${resolved}`)
  }
}

function isDangerousCommand(command: string): boolean {
  const dangerous = [
    'rm -rf /', 'rm -rf ~', 'mkfs', 'dd if=', ':(){:|:&};:',
    '> /dev/sda', 'shutdown', 'reboot', 'format',
  ]
  return dangerous.some(d => command.toLowerCase().includes(d))
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function globToRegex(pattern: string): RegExp {
  const regex = pattern
    .replace(/\./g, '\\.')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  return new RegExp(`^${regex}$`)
}
```

### 3.3 Tool Registry & Schema（工具注册表）

**位置**：`src/main/agent/tool-registry.ts`

定义 Agent 可用的工具列表（OpenAI function calling 格式）：

```typescript
// src/main/agent/tool-registry.ts

/**
 * Agent 工具定义（OpenAI function calling 格式）
 * 
 * 设计原则：
 * 1. 每个工具只做一件事
 * 2. 参数尽量简单，复杂逻辑在工具内部处理
 * 3. 返回值统一为字符串（LLM 读得懂）
 */

export const AGENT_TOOL_SCHEMAS: ToolSchema[] = [
  // ── 文件操作 ──
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: '读取本地文件内容。支持指定起始行和最大行数，避免读取超大文件。',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: '文件的绝对路径或相对路径',
          },
          offset: {
            type: 'integer',
            description: '起始行号（从 0 开始），默认 0',
          },
          max_lines: {
            type: 'integer',
            description: '最大读取行数，默认读取全部',
          },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: '写入内容到文件。如果文件已存在则覆盖，不存在则创建。会自动创建父目录。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径' },
          content: { type: 'string', description: '要写入的内容' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: '精确替换文件中的文本。old_string 必须在文件中精确匹配。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径' },
          old_string: { type: 'string', description: '要被替换的精确文本' },
          new_string: { type: 'string', description: '替换后的新文本' },
          replace_all: {
            type: 'boolean',
            description: '是否替换所有匹配项，默认 false（只替换第一个）',
          },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: '列出目录中的文件和子目录。支持 glob 模式过滤。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '目录路径' },
          pattern: {
            type: 'string',
            description: 'glob 过滤模式，如 "*.ts", "*.md"',
          },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_files',
      description: '在目录中搜索包含指定文本的文件（grep -r）。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '搜索目录' },
          query: { type: 'string', description: '搜索关键词' },
          file_pattern: {
            type: 'string',
            description: '文件过滤模式，如 "*.ts"',
          },
        },
        required: ['path', 'query'],
      },
    },
  },

  // ── 命令执行 ──
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: '在系统终端执行 Shell 命令。有 30 秒超时和安全限制。不允许执行破坏性命令（rm -rf / 等）。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的命令' },
          work_dir: {
            type: 'string',
            description: '工作目录，默认为用户主目录',
          },
          timeout_ms: {
            type: 'integer',
            description: '超时时间（毫秒），默认 30000',
          },
        },
        required: ['command'],
      },
    },
  },

  // ── 小牛马数据操作 ──
  {
    type: 'function',
    function: {
      name: 'get_today_log',
      description: '获取今天的工作日志（包括待办和复盘内容）。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_todos',
      description: '获取当前所有待办事项列表。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_todo',
      description: '添加新的待办事项。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '待办标题' },
          priority: {
            type: 'string',
            enum: ['high', 'medium', 'low'],
            description: '优先级，默认 medium',
          },
          estimated_min: {
            type: 'integer',
            description: '预估耗时（分钟），可选',
          },
        },
        required: ['title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_todo',
      description: '更新待办事项的状态或内容。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '待办 ID' },
          status: {
            type: 'string',
            enum: ['pending', 'done'],
            description: '新状态',
          },
          title: { type: 'string', description: '新标题' },
          priority: {
            type: 'string',
            enum: ['high', 'medium', 'low'],
            description: '新优先级',
          },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'append_log',
      description: '向今天的工作日志追加内容。',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: '要追加的内容' },
          append_to: {
            type: 'string',
            enum: ['eod_log'],
            description: '追加到哪个字段，默认 eod_log',
          },
        },
        required: ['content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_logs_range',
      description: '获取指定日期范围内的工作日志。',
      parameters: {
        type: 'object',
        properties: {
          start_date: {
            type: 'string',
            description: '开始日期 (YYYY-MM-DD)',
          },
          end_date: {
            type: 'string',
            description: '结束日期 (YYYY-MM-DD)',
          },
        },
        required: ['start_date', 'end_date'],
      },
    },
  },

  // ── 系统操作 ──
  {
    type: 'function',
    function: {
      name: 'open_file',
      description: '用系统默认程序打开文件。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'show_notification',
      description: '在桌面显示通知消息。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '通知标题' },
          body: { type: 'string', description: '通知内容' },
        },
        required: ['title', 'body'],
      },
    },
  },

  // ── 流程控制 ──
  {
    type: 'function',
    function: {
      name: 'wait',
      description: '等待指定的毫秒数。用于在多个操作之间添加延迟。',
      parameters: {
        type: 'object',
        properties: {
          ms: {
            type: 'integer',
            description: '等待毫秒数，最大 60000（1分钟）',
          },
        },
        required: ['ms'],
      },
    },
  },
]

/**
 * 获取当前激活的工具列表
 * 可以根据配置动态启用/禁用工具
 */
export function getActiveToolSchemas(): ToolSchema[] {
  // 未来可以根据用户配置过滤
  return AGENT_TOOL_SCHEMAS
}

export function getToolDescription(name: string): string {
  const tool = AGENT_TOOL_SCHEMAS.find(t => t.function.name === name)
  return tool?.function.description ?? name
}
```

### 3.4 System Prompt Builder

**位置**：`src/main/agent/system-prompt.ts`

```typescript
// src/main/agent/system-prompt.ts

import * as os from 'os'
import * as path from 'path'
import { getConfig } from '../store'

export interface AgentContext {
  /** 当前工作目录 */
  cwd: string
  /** 用户桌面路径 */
  desktopPath: string
  /** 用户文档路径 */
  documentsPath: string
  /** 小牛马数据目录 */
  appDataPath: string
  /** 当前时间 */
  currentTime: string
  /** 今天是星期几 */
  dayOfWeek: string
  /** 当前已有的待办数量 */
  todoCount: number
  /** 今天是否已写日志 */
  hasTodayLog: boolean
}

/**
 * 构建 Agent 的 System Prompt
 * 
 * 关键设计：
 * 1. 延续"小小牛马"的角色设定（像素猫助手）
 * 2. 注入当前环境上下文（时间、待办、日志状态）
 * 3. 明确工具使用规范
 * 4. 定义输出格式要求
 */
export function buildSystemPrompt(ctx: AgentContext): string {
  return `# 角色

你是"小小牛马"——一个运行在用户桌面上的 AI 助手，以像素风格橘猫的形象陪伴用户工作。

你不是一个只会聊天的助手，你是一个**能干活的 Agent**。你可以：
- 读取、创建、编辑本地文件
- 执行系统命令
- 管理工作日志和待办事项
- 搜索和分析信息
- 自主规划并执行多步骤任务

# 当前环境

- 操作系统: ${os.platform()} ${os.release()}
- 当前时间: ${ctx.currentTime} (${ctx.dayOfWeek})
- 工作目录: ${ctx.cwd}
- 桌面路径: ${ctx.desktopPath}
- 文档路径: ${ctx.documentsPath}
- 数据目录: ${ctx.appDataPath}
- 当前待办: ${ctx.todoCount} 条
- 今日日志: ${ctx.hasTodayLog ? '已记录' : '未记录'}

# 行为准则

1. **先理解再行动**: 复杂任务先分析需求，再制定执行计划
2. **逐步执行**: 每次调用 1-2 个工具，观察结果后再继续
3. **安全第一**: 
   - 不删除用户文件（除非明确要求）
   - 不执行破坏性命令
   - 写入文件前确认路径安全
4. **结果可验证**: 每个操作后检查结果是否符合预期
5. **错误不静默**: 遇到错误要报告，并尝试替代方案
6. **简洁高效**: 不要做不必要的工具调用

# 工具使用规范

- 文件操作路径优先使用绝对路径
- 读取大文件时使用 offset + max_lines 分段读取
- 编辑文件时 old_string 必须精确匹配
- run_command 有 30 秒超时，长时间任务需要拆分
- 小牛马数据操作工具（get_today_log, save_todo 等）直接操作本地 JSON 存储

# 输出格式

- 用中文回复
- 执行过程中简要说明你在做什么
- 最终结果用清晰的格式呈现
- 如果任务需要多步骤，列出执行计划

# 语言

始终使用简体中文回复。技术术语保持原文。`
}

/**
 * 构建 AgentContext
 */
export function buildAgentContext(): AgentContext {
  const home = os.homedir()
  const now = new Date()
  const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  
  const { getLog, getTodos } = require('../store')
  const today = now.toISOString().slice(0, 10)
  
  return {
    cwd: process.cwd(),
    desktopPath: path.join(home, 'Desktop'),
    documentsPath: path.join(home, 'Documents'),
    appDataPath: path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'xiao-niu-ma'),
    currentTime: now.toLocaleString('zh-CN'),
    dayOfWeek: weekdays[now.getDay()],
    todoCount: getTodos().length,
    hasTodayLog: !!getLog(today),
  }
}
```

### 3.5 Agent 类型定义

**位置**：`src/main/agent/types.ts`

```typescript
// src/main/agent/types.ts

/** Agent 消息（扩展现有 AIChatMessage） */
export interface AgentMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  reasoning?: string
  tool_calls?: Array<{
    id: string
    name: string
    arguments: string
  }>
  tool_call_id?: string
  tool_name?: string
  createdAt?: number
}

/** Agent 会话 */
export interface AgentSession {
  id: string
  title: string
  messages: AgentMessage[]
  status: 'idle' | 'running' | 'completed' | 'error' | 'aborted'
  createdAt: number
  updatedAt: number
  /** 执行统计 */
  stats: {
    iterations: number
    toolCalls: number
    totalDurationMs: number
  }
}

/** Agent 执行回调 */
export interface AgentCallbacks {
  onChunk: (payload: AgentChunkPayload) => void
  onDone: (payload: AgentDonePayload) => void
  onError: (payload: AgentErrorPayload) => void
  onToolExecutionStart: (payload: AgentToolStartPayload) => void
  onToolExecuting: (payload: AgentToolExecutingPayload) => void
  onToolExecuted: (payload: AgentToolExecutedPayload) => void
}

export interface AgentChunkPayload {
  sessionId: string
  content: string
  reasoning: string
  iteration: number
}

export interface AgentDonePayload {
  sessionId: string
  content: string
  iterations: number
}

export interface AgentErrorPayload {
  sessionId: string
  error: string
  fatal: boolean
}

export interface AgentToolStartPayload {
  sessionId: string
  toolCalls: Array<{ id: string; name: string; description: string }>
}

export interface AgentToolExecutingPayload {
  sessionId: string
  toolId: string
  toolName: string
}

export interface AgentToolExecutedPayload {
  sessionId: string
  toolId: string
  toolName: string
  success: boolean
  output: string
  error?: string
}

export interface AgentResult {
  success: boolean
  output?: string
  error?: string
  iterations: number
}
```

---

## 四、IPC 集成

### 4.1 新增 IPC 通道

**位置**：`src/shared/ipc-channels.ts`（扩展现有文件）

```typescript
// 在现有 IPC 对象中添加 Agent 相关通道

export const IPC = {
  // ... 现有通道 ...
  
  // ── Agent ──
  AGENT_START: 'agent:start',
  AGENT_STOP: 'agent:stop',
  AGENT_STATUS: 'agent:status',
  
  // 主进程 → 渲染进程 (push)
  AGENT_CHUNK: 'agent:chunk',
  AGENT_DONE: 'agent:done',
  AGENT_ERROR: 'agent:error',
  AGENT_TOOL_START: 'agent:tool:start',
  AGENT_TOOL_EXECUTING: 'agent:tool:executing',
  AGENT_TOOL_EXECUTED: 'agent:tool:executed',
  AGENT_NOTIFICATION: 'agent:notification',
  
  // 会话管理
  AGENT_SESSIONS_LIST: 'agent:sessions:list',
  AGENT_SESSION_GET: 'agent:session:get',
  AGENT_SESSION_DELETE: 'agent:session:delete',
  AGENT_SESSION_RENAME: 'agent:session:rename',
} as const
```

### 4.2 IPC 处理器注册

**位置**：`src/main/ipc-handlers.ts`（扩展现有文件）

```typescript
// 在 registerIPCHandlers() 函数末尾添加

import { AgentOrchestrator } from './agent/orchestrator'
import { buildAgentContext } from './agent/system-prompt'
import { listAgentSessions, getAgentSession, deleteAgentSession, renameAgentSession } from './agent/session-store'

// 活跃 Agent 实例表（支持多会话并发）
const activeAgents = new Map<string, AgentOrchestrator>()

// ── Agent 对话 ──────────────────────────────────

ipcMain.handle(IPC.AGENT_START, async (event, params: {
  sessionId: string
  userInput: string
}) => {
  const { sessionId, userInput } = params
  
  // 如果已有同会话的 Agent 在运行，先停止
  const existing = activeAgents.get(sessionId)
  if (existing) {
    existing.abort()
  }

  const agent = new AgentOrchestrator(sessionId)
  activeAgents.set(sessionId, agent)

  const context = buildAgentContext()
  const sender = event.sender

  // 异步执行（不阻塞 IPC 返回）
  agent.run(userInput, context, {
    onChunk: (payload) => {
      sender.send(IPC.AGENT_CHUNK, payload)
    },
    onDone: (payload) => {
      sender.send(IPC.AGENT_DONE, payload)
      activeAgents.delete(sessionId)
    },
    onError: (payload) => {
      sender.send(IPC.AGENT_ERROR, payload)
      activeAgents.delete(sessionId)
    },
    onToolExecutionStart: (payload) => {
      sender.send(IPC.AGENT_TOOL_START, payload)
    },
    onToolExecuting: (payload) => {
      sender.send(IPC.AGENT_TOOL_EXECUTING, payload)
    },
    onToolExecuted: (payload) => {
      sender.send(IPC.AGENT_TOOL_EXECUTED, payload)
    },
  }).catch(err => {
    sender.send(IPC.AGENT_ERROR, {
      sessionId,
      error: err.message,
      fatal: true,
    })
    activeAgents.delete(sessionId)
  })

  return { ok: true }
})

ipcMain.handle(IPC.AGENT_STOP, (_e, { sessionId }: { sessionId: string }) => {
  const agent = activeAgents.get(sessionId)
  if (agent) {
    agent.abort()
    activeAgents.delete(sessionId)
    return { ok: true }
  }
  return { ok: false, error: '未找到活跃的 Agent' }
})

ipcMain.handle(IPC.AGENT_STATUS, (_e, { sessionId }: { sessionId: string }) => {
  return {
    running: activeAgents.has(sessionId),
  }
})

// ── Agent 会话管理 ──────────────────────────────

ipcMain.handle(IPC.AGENT_SESSIONS_LIST, () => listAgentSessions())
ipcMain.handle(IPC.AGENT_SESSION_GET, (_e, { id }: { id: string }) => getAgentSession(id))
ipcMain.handle(IPC.AGENT_SESSION_DELETE, (_e, { id }: { id: string }) => deleteAgentSession(id))
ipcMain.handle(IPC.AGENT_SESSION_RENAME, (_e, { id, title }: { id: string; title: string }) => {
  return renameAgentSession(id, title)
})
```

---

## 五、前端 UI 设计

### 5.1 Agent 对话页面

**位置**：`src/renderer/src/pages/AgentChat.tsx`（新建，参考现有 AIChat.tsx 架构）

```
┌─────────────────────────────────────────────────────────────────┐
│  🐱 Agent 模式                                      [设置] [×] │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─ 用户 ──────────────────────────────────────────────────┐   │
│  │ 帮我整理桌面上的会议记录文件，提取关键决策添加到工作日志  │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌─ 小小牛马 ──────────────────────────────────────────────┐   │
│  │                                                         │   │
│  │ 好的，我来帮你整理。先看看桌面上有哪些会议记录文件。     │   │
│  │                                                         │   │
│  │ 🔧 执行中...                                            │   │
│  │ ┌───────────────────────────────────────────────────┐   │   │
│  │ │ 📁 list_files                                     │   │   │
│  │ │ 路径: ~/Desktop                                    │   │   │
│  │ │ 模式: *会议*                                       │   │   │
│  │ │ ✅ 找到 3 个文件                                    │   │   │
│  │ └───────────────────────────────────────────────────┘   │   │
│  │                                                         │   │
│  │ 找到了 3 个会议记录文件，逐个读取分析...                │   │
│  │                                                         │   │
│  │ 🔧 执行中...                                            │   │
│  │ ┌───────────────────────────────────────────────────┐   │   │
│  │ │ 📄 read_file                                      │   │   │
│  │ │ 路径: ~/Desktop/周会记录-0518.md                   │   │   │
│  │ │ ✅ 读取成功 (1200 字符)                            │   │   │
│  │ └───────────────────────────────────────────────────┘   │   │
│  │                                                         │   │
│  │ ... 分析中 ...                                          │   │
│  │                                                         │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌─ 小小牛马 ──────────────────────────────────────────────┐   │
│  │                                                         │   │
│  │ ✅ 任务完成！共执行 8 步，耗时 12.3 秒                  │   │
│  │                                                         │   │
│  │ 📋 执行摘要:                                            │   │
│  │ · 扫描桌面找到 3 个会议记录文件                         │   │
│  │ · 提取了 5 条关键决策                                   │   │
│  │ · 已追加到今天的工作日志                                │   │
│  │ · 新增了 2 条待办事项                                   │   │
│  │                                                         │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                 │
├─────────────────────────────────────────────────────────────────┤
│  [📎] 输入任务描述...                              [发送] [停止] │
└─────────────────────────────────────────────────────────────────┘
```

### 5.2 核心组件结构

```
src/renderer/src/pages/
├── AgentChat.tsx              # Agent 对话页面（主入口）
├── agent/
│   ├── AgentMessage.tsx       # 消息渲染（含工具调用卡片）
│   ├── ToolCallCard.tsx       # 工具调用执行卡片
│   ├── AgentInput.tsx         # 输入框（支持附件）
│   ├── AgentSessionList.tsx   # 会话列表
│   └── AgentSettings.tsx      # Agent 设置
```

### 5.3 前端 Hook

```typescript
// src/renderer/src/hooks/useAgent.ts

import { useState, useCallback, useRef } from 'react'
import { IPC } from '@shared/ipc-channels'
import type { AgentMessage, AgentSession } from '@shared/types'

const api = (window as any).electronAPI

export function useAgent() {
  const [messages, setMessages] = useState<AgentMessage[]>([])
  const [isRunning, setIsRunning] = useState(false)
  const [currentTool, setCurrentTool] = useState<string | null>(null)
  const [toolResults, setToolResults] = useState<ToolResult[]>([])
  const sessionIdRef = useRef<string>(generateId())

  // 发送任务
  const sendTask = useCallback(async (input: string) => {
    const sessionId = sessionIdRef.current
    
    // 添加用户消息
    setMessages(prev => [...prev, {
      role: 'user',
      content: input,
      createdAt: Date.now(),
    }])
    
    setIsRunning(true)
    setToolResults([])

    // 启动 Agent
    await api.invoke(IPC.AGENT_START, {
      sessionId,
      userInput: input,
    })
  }, [])

  // 停止执行
  const stopTask = useCallback(async () => {
    await api.invoke(IPC.AGENT_STOP, { sessionId: sessionIdRef.current })
    setIsRunning(false)
  }, [])

  // 监听流式事件
  useEffect(() => {
    const unsubs = [
      // 文本流式输出
      api.on(IPC.AGENT_CHUNK, (payload: AgentChunkPayload) => {
        setMessages(prev => {
          const last = prev[prev.length - 1]
          if (last?.role === 'assistant') {
            return [...prev.slice(0, -1), { ...last, content: payload.content }]
          }
          return [...prev, {
            role: 'assistant',
            content: payload.content,
            reasoning: payload.reasoning,
            createdAt: Date.now(),
          }]
        })
      }),
      
      // 工具调用开始
      api.on(IPC.AGENT_TOOL_START, (payload: AgentToolStartPayload) => {
        setToolResults(prev => [...prev, ...payload.toolCalls.map(tc => ({
          ...tc,
          status: 'pending' as const,
        }))])
      }),
      
      // 工具执行中
      api.on(IPC.AGENT_TOOL_EXECUTING, (payload: AgentToolExecutingPayload) => {
        setCurrentTool(payload.toolName)
        setToolResults(prev => prev.map(r =>
          r.id === payload.toolId ? { ...r, status: 'running' as const } : r
        ))
      }),
      
      // 工具执行完成
      api.on(IPC.AGENT_TOOL_EXECUTED, (payload: AgentToolExecutedPayload) => {
        setCurrentTool(null)
        setToolResults(prev => prev.map(r =>
          r.id === payload.toolId ? {
            ...r,
            status: payload.success ? 'success' as const : 'error' as const,
            output: payload.output,
            error: payload.error,
          } : r
        ))
      }),
      
      // 完成
      api.on(IPC.AGENT_DONE, () => {
        setIsRunning(false)
        setCurrentTool(null)
      }),
      
      // 错误
      api.on(IPC.AGENT_ERROR, (payload: AgentErrorPayload) => {
        setIsRunning(false)
        setCurrentTool(null)
        if (payload.fatal) {
          setMessages(prev => [...prev, {
            role: 'assistant',
            content: `❌ 执行出错: ${payload.error}`,
            createdAt: Date.now(),
          }])
        }
      }),
    ]

    return () => unsubs.forEach(unsub => unsub())
  }, [])

  return {
    messages,
    isRunning,
    currentTool,
    toolResults,
    sendTask,
    stopTask,
  }
}
```

---

## 六、会话持久化

**位置**：`src/main/agent/session-store.ts`

```typescript
// src/main/agent/session-store.ts

import * as fs from 'fs/promises'
import * as path from 'path'
import { app } from 'electron'
import type { AgentSession } from './types'

const SESSIONS_DIR = path.join(app.getPath('userData'), 'agent-sessions')

async function ensureDir() {
  await fs.mkdir(SESSIONS_DIR, { recursive: true })
}

function sessionFile(id: string) {
  return path.join(SESSIONS_DIR, `${id}.json`)
}

export async function saveAgentSession(session: AgentSession): Promise<void> {
  await ensureDir()
  session.updatedAt = Date.now()
  await fs.writeFile(sessionFile(session.id), JSON.stringify(session, null, 2))
}

export async function listAgentSessions(): Promise<AgentSession[]> {
  await ensureDir()
  const files = await fs.readdir(SESSIONS_DIR)
  const sessions: AgentSession[] = []
  
  for (const file of files.filter(f => f.endsWith('.json'))) {
    try {
      const content = await fs.readFile(path.join(SESSIONS_DIR, file), 'utf-8')
      sessions.push(JSON.parse(content))
    } catch { /* 跳过损坏的文件 */ }
  }
  
  return sessions.sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function getAgentSession(id: string): Promise<AgentSession | null> {
  try {
    const content = await fs.readFile(sessionFile(id), 'utf-8')
    return JSON.parse(content)
  } catch {
    return null
  }
}

export async function deleteAgentSession(id: string): Promise<void> {
  try {
    await fs.unlink(sessionFile(id))
  } catch { /* 文件不存在 */ }
}

export async function renameAgentSession(id: string, title: string): Promise<void> {
  const session = await getAgentSession(id)
  if (session) {
    session.title = title
    await saveAgentSession(session)
  }
}
```

---

## 七、与现有模块的集成点

### 7.1 复用清单

| 现有模块 | 复用方式 | 说明 |
|---------|---------|------|
| `llm-service.ts` | 参考其 SSE 解析逻辑 | Agent 的流式 LLM 调用复用相同的 fetch + Reader 模式 |
| `ai-chat-service.ts` | 参考其 ThinkSplitter | Agent 的推理块解析直接复用 |
| `store.ts` | 直接调用 | Agent 工具操作小牛马数据时直接调用 getLog/saveLog/getTodos/saveTodos |
| `windows.ts` | 扩展 | 新增 openAgentWindow() 创建 Agent 对话窗口 |
| `ipc-handlers.ts` | 扩展 | 在现有 registerIPCHandlers() 中注册 Agent 相关 IPC |
| `tray.ts` | 扩展 | 托盘菜单增加"Agent 模式"入口 |
| `@shared/types.ts` | 扩展 | 新增 Agent 相关类型定义 |
| `@shared/ipc-channels.ts` | 扩展 | 新增 Agent 相关 IPC 通道 |

### 7.2 新增文件清单

```
src/
├── main/
│   ├── agent/
│   │   ├── orchestrator.ts      # Agent 编排器（核心）
│   │   ├── tool-executor.ts     # 工具执行器
│   │   ├── tool-registry.ts     # 工具注册表 + Schema
│   │   ├── system-prompt.ts     # System Prompt 构建器
│   │   ├── types.ts             # Agent 类型定义
│   │   └── session-store.ts     # 会话持久化
│   └── (扩展) ipc-handlers.ts   # 注册 Agent IPC
│   └── (扩展) windows.ts        # 新增 Agent 窗口
│   └── (扩展) tray.ts           # 新增 Agent 入口
├── renderer/src/
│   ├── pages/
│   │   └── AgentChat.tsx        # Agent 对话页面
│   ├── components/
│   │   └── Agent/
│   │       ├── ToolCallCard.tsx # 工具调用卡片
│   │       └── AgentInput.tsx   # 输入组件
│   └── hooks/
│       └── useAgent.ts          # Agent 状态管理 Hook
└── shared/
    ├── (扩展) types.ts          # 新增 Agent 类型
    └── (扩展) ipc-channels.ts   # 新增 Agent IPC 通道
```

---

## 八、Skill 系统

### 8.1 Skill 定义

Skill 是预定义的工作流模板，Agent 可以加载并执行。类比：工具是"锤子"，Skill是"装修方案"。

```typescript
// src/main/agent/skills/types.ts

/** Skill 来源 */
export type SkillScope = 'builtin' | 'user' | 'remote'

/** Skill 分类 */
export type SkillCategory =
  | 'productivity'    // 生产力：计划、复盘、总结
  | 'file'            // 文件：整理、搜索、转换
  | 'code'            // 代码：审查、生成、重构
  | 'communication'   // 沟通：邮件、翻译、润色
  | 'data'            // 数据：分析、可视化、导出
  | 'automation'      // 自动化：定时、批处理、工作流
  | 'custom'          // 自定义

export interface AgentSkill {
  id: string
  name: string
  description: string
  category: SkillCategory
  icon: string                    // emoji 或 icon name
  author: string
  version: string
  
  /** 触发关键词（用户输入匹配） */
  triggers: string[]
  
  /** 技能注入到 System Prompt 的内容 */
  systemPromptAddition: string
  
  /** 技能推荐的工具列表 */
  recommendedTools: string[]
  
  /** 预定义的执行步骤（可选，用于引导 Agent） */
  suggestedSteps?: string[]
  
  /** 来源 */
  scope: SkillScope
  
  /** 安装信息 */
  install?: {
    /** 远程安装 URL */
    url?: string
    /** 校验和 */
    checksum?: string
    /** 依赖的其他 skill id */
    dependencies?: string[]
  }
  
  /** 元数据 */
  meta: {
    /** 下载次数 / 安装量 */
    installCount?: number
    /** 评分 1-5 */
    rating?: number
    /** 标签 */
    tags: string[]
    /** 创建时间 */
    createdAt: string
    /** 更新时间 */
    updatedAt: string
  }
}

/** Skill 安装记录 */
export interface SkillInstallRecord {
  skillId: string
  installedAt: string
  source: 'builtin' | 'local' | 'remote'
  enabled: boolean
  /** 用户自定义配置（覆盖 skill 默认值） */
  userConfig?: Record<string, string>
}
```

### 8.2 内置 Skills

```typescript
// src/main/agent/skills/built-in.ts

export const BUILT_IN_SKILLS: AgentSkill[] = [
  {
    id: 'daily-review',
    name: '每日复盘',
    description: '自动整理今天的工作日志，生成复盘报告',
    category: 'productivity',
    icon: '📋',
    author: '小小牛马',
    version: '1.0.0',
    triggers: ['复盘', '总结今天', '日报', 'daily review'],
    systemPromptAddition: `## 当前技能: 每日复盘
执行步骤:
1. 调用 get_today_log 获取今天的日志
2. 调用 get_todos 获取待办状态
3. 分析完成情况，生成结构化复盘报告
4. 将复盘结果通过 append_log 追加到日志
5. 如有未完成的待办，询问用户是否延后`,
    recommendedTools: ['get_today_log', 'get_todos', 'append_log', 'update_todo'],
    scope: 'builtin',
    meta: { tags: ['日志', '复盘', '日报'], createdAt: '2026-05-18', updatedAt: '2026-05-18' },
  },
  {
    id: 'file-organizer',
    name: '文件整理',
    description: '按规则整理指定目录的文件',
    category: 'file',
    icon: '📁',
    author: '小小牛马',
    version: '1.0.0',
    triggers: ['整理文件', '清理桌面', '归类文件', 'file organizer'],
    systemPromptAddition: `## 当前技能: 文件整理
执行步骤:
1. 调用 list_files 扫描目标目录
2. 分析文件类型和命名模式
3. 制定分类规则（按类型/日期/项目）
4. 向用户展示整理计划，等待确认
5. 执行文件移动操作
6. 生成整理报告`,
    recommendedTools: ['list_files', 'run_command'],
    scope: 'builtin',
    meta: { tags: ['文件', '整理', '桌面'], createdAt: '2026-05-18', updatedAt: '2026-05-18' },
  },
  {
    id: 'weekly-report',
    name: '周报生成',
    description: '读取一周的工作日志，生成周报',
    category: 'productivity',
    icon: '📊',
    author: '小小牛马',
    version: '1.0.0',
    triggers: ['周报', 'weekly report', '本周总结'],
    systemPromptAddition: `## 当前技能: 周报生成
执行步骤:
1. 调用 get_logs_range 获取本周日志
2. 分析每天的工作内容和完成情况
3. 按项目/主题归类
4. 生成标准格式周报（Markdown）
5. 询问用户是否保存到文件`,
    recommendedTools: ['get_logs_range', 'write_file', 'append_log'],
    scope: 'builtin',
    meta: { tags: ['周报', '总结', '日志'], createdAt: '2026-05-18', updatedAt: '2026-05-18' },
  },
  {
    id: 'code-review',
    name: '代码审查',
    description: '审查代码质量、安全性和性能',
    category: 'code',
    icon: '🔍',
    author: '小小牛马',
    version: '1.0.0',
    triggers: ['代码审查', 'code review', '检查代码', 'review'],
    systemPromptAddition: `## 当前技能: 代码审查
执行步骤:
1. 读取目标代码文件
2. 从以下维度审查:
   - 正确性: 逻辑是否正确
   - 安全性: OWASP Top 10 漏洞
   - 性能: 潜在性能问题
   - 可维护性: 代码清晰度
3. 输出结构化审查报告`,
    recommendedTools: ['read_file', 'list_files', 'search_files'],
    scope: 'builtin',
    meta: { tags: ['代码', '审查', '安全'], createdAt: '2026-05-18', updatedAt: '2026-05-18' },
  },
  {
    id: 'email-assistant',
    name: '邮件助手',
    description: '起草、润色、翻译邮件',
    category: 'communication',
    icon: '📧',
    author: '小小牛马',
    version: '1.0.0',
    triggers: ['写邮件', '起草邮件', 'email', '邮件'],
    systemPromptAddition: `## 当前技能: 邮件助手
执行步骤:
1. 确认邮件类型（通知/请求/跟进/感谢）
2. 确认收件人角色（同事/领导/客户）
3. 起草邮件正文（简洁专业）
4. 检查语气是否合适`,
    recommendedTools: ['write_file'],
    scope: 'builtin',
    meta: { tags: ['邮件', '写作', '沟通'], createdAt: '2026-05-18', updatedAt: '2026-05-18' },
  },
  {
    id: 'data-analysis',
    name: '数据分析',
    description: '读取数据文件，生成统计报告和可视化',
    category: 'data',
    icon: '📈',
    author: '小小牛马',
    version: '1.0.0',
    triggers: ['分析数据', '数据统计', '生成图表', 'data analysis'],
    systemPromptAddition: `## 当前技能: 数据分析
执行步骤:
1. 确认数据文件路径和格式（CSV/JSON/Excel）
2. 加载数据并做基础统计（均值/分布/趋势）
3. 识别异常值和缺失值
4. 生成分析报告（Markdown + 建议）`,
    recommendedTools: ['read_file', 'run_command', 'write_file'],
    scope: 'builtin',
    meta: { tags: ['数据', '分析', '统计'], createdAt: '2026-05-18', updatedAt: '2026-05-18' },
  },
]
```

### 8.3 Skill 存储与管理

**位置**：`src/main/agent/skills/store.ts`

```typescript
// src/main/agent/skills/store.ts

import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'
import log from 'electron-log/main'
import type { AgentSkill, SkillInstallRecord } from './types'
import { BUILT_IN_SKILLS } from './built-in'

const SKILLS_DIR = path.join(app.getPath('userData'), 'skills')
const INSTALLS_FILE = path.join(SKILLS_DIR, 'installs.json')
const USER_SKILLS_DIR = path.join(SKILLS_DIR, 'user')

// ── 初始化 ─────────────────────────────────────

function ensureDirs() {
  fs.mkdirSync(SKILLS_DIR, { recursive: true })
  fs.mkdirSync(USER_SKILLS_DIR, { recursive: true })
}

// ── 已安装记录 ─────────────────────────────────

export function getInstallRecords(): SkillInstallRecord[] {
  ensureDirs()
  try {
    if (!fs.existsSync(INSTALLS_FILE)) return []
    return JSON.parse(fs.readFileSync(INSTALLS_FILE, 'utf-8'))
  } catch { return [] }
}

function saveInstallRecords(records: SkillInstallRecord[]): void {
  const tmp = INSTALLS_FILE + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(records, null, 2), 'utf-8')
  fs.renameSync(tmp, INSTALLS_FILE)
}

// ── 获取所有可用 Skill ─────────────────────────

export function getAllSkills(): Array<AgentSkill & { installed: boolean; enabled: boolean }> {
  const records = getInstallRecords()
  const recordMap = new Map(records.map(r => [r.skillId, r]))
  
  // 内置 skills
  const builtins = BUILT_IN_SKILLS.map(s => ({
    ...s,
    installed: true,
    enabled: recordMap.get(s.id)?.enabled ?? true,
  }))
  
  // 用户安装的 skills
  const userSkills = loadUserSkills().map(s => ({
    ...s,
    installed: true,
    enabled: recordMap.get(s.id)?.enabled ?? true,
  }))
  
  return [...builtins, ...userSkills]
}

// ── 按分类获取 ─────────────────────────────────

export function getSkillsByCategory(category: string) {
  return getAllSkills().filter(s => s.category === category)
}

// ── 搜索 Skills ────────────────────────────────

export function searchSkills(query: string): AgentSkill[] {
  const q = query.toLowerCase()
  return getAllSkills().filter(s =>
    s.name.toLowerCase().includes(q) ||
    s.description.toLowerCase().includes(q) ||
    s.triggers.some(t => t.toLowerCase().includes(q)) ||
    s.meta.tags.some(t => t.toLowerCase().includes(q))
  )
}

// ── 启用/禁用 ──────────────────────────────────

export function toggleSkill(skillId: string): boolean {
  const records = getInstallRecords()
  const idx = records.findIndex(r => r.skillId === skillId)
  
  if (idx >= 0) {
    records[idx].enabled = !records[idx].enabled
  } else {
    // 内置 skill 首次禁用时创建记录
    records.push({
      skillId,
      installedAt: new Date().toISOString(),
      source: 'builtin',
      enabled: false,
    })
  }
  
  saveInstallRecords(records)
  log.info(`[Skill] ${skillId} ${records[idx]?.enabled ? '启用' : '禁用'}`)
  return records[idx]?.enabled ?? false
}

// ── 用户 Skill CRUD ────────────────────────────

function loadUserSkills(): AgentSkill[] {
  ensureDirs()
  const skills: AgentSkill[] = []
  
  const dirs = fs.readdirSync(USER_SKILLS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
  
  for (const dir of dirs) {
    const manifestPath = path.join(USER_SKILLS_DIR, dir.name, 'skill.json')
    try {
      if (fs.existsSync(manifestPath)) {
        const skill = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
        skill.scope = 'user'
        skills.push(skill)
      }
    } catch (e) {
      log.warn(`[Skill] 加载用户 skill 失败: ${dir.name}`, e)
    }
  }
  
  return skills
}

export function saveUserSkill(skill: AgentSkill): void {
  const skillDir = path.join(USER_SKILLS_DIR, skill.id)
  fs.mkdirSync(skillDir, { recursive: true })
  
  const manifestPath = path.join(skillDir, 'skill.json')
  fs.writeFileSync(manifestPath, JSON.stringify(skill, null, 2), 'utf-8')
  
  // 更新安装记录
  const records = getInstallRecords()
  const idx = records.findIndex(r => r.skillId === skill.id)
  if (idx >= 0) {
    records[idx].installedAt = new Date().toISOString()
    records[idx].source = 'user'
  } else {
    records.push({
      skillId: skill.id,
      installedAt: new Date().toISOString(),
      source: 'user',
      enabled: true,
    })
  }
  saveInstallRecords(records)
  
  log.info(`[Skill] 保存用户 skill: ${skill.name}`)
}

export function deleteUserSkill(skillId: string): boolean {
  const skillDir = path.join(USER_SKILLS_DIR, skillId)
  if (!fs.existsSync(skillDir)) return false
  
  fs.rmSync(skillDir, { recursive: true })
  
  const records = getInstallRecords()
  const filtered = records.filter(r => r.skillId !== skillId)
  saveInstallRecords(filtered)
  
  log.info(`[Skill] 删除用户 skill: ${skillId}`)
  return true
}
```

### 8.4 Skill 安装系统

支持三种安装方式：本地文件、远程 URL、Skill 市场。

```typescript
// src/main/agent/skills/installer.ts

import * as fs from 'fs'
import * as path from 'path'
import * as https from 'https'
import * as http from 'http'
import { createHash } from 'crypto'
import { app, net } from 'electron'
import log from 'electron-log/main'
import type { AgentSkill } from './types'
import { saveUserSkill, getInstallRecords } from './store'

const USER_SKILLS_DIR = path.join(app.getPath('userData'), 'skills', 'user')

/**
 * Skill 安装器
 * 支持: 本地目录/zip、远程 URL、Skill 市场
 */
export class SkillInstaller {

  /**
   * 从本地目录安装
   * 目录结构: skill.json + 可选的资源文件
   */
  async installFromDir(dirPath: string): Promise<AgentSkill> {
    const manifestPath = path.join(dirPath, 'skill.json')
    
    if (!fs.existsSync(manifestPath)) {
      throw new Error('skill.json 不存在')
    }

    const skill = this.loadAndValidateManifest(manifestPath)
    
    // 复制到用户 skills 目录
    const targetDir = path.join(USER_SKILLS_DIR, skill.id)
    if (fs.existsSync(targetDir)) {
      throw new Error(`Skill "${skill.name}" 已安装，请先卸载`)
    }
    
    this.copyDir(dirPath, targetDir)
    saveUserSkill(skill)
    
    log.info(`[Skill] 从目录安装成功: ${skill.name}`)
    return skill
  }

  /**
   * 从本地 zip 文件安装
   */
  async installFromZip(zipPath: string): Promise<AgentSkill> {
    const { execSync } = require('child_process')
    
    // 解压到临时目录
    const tmpDir = path.join(app.getPath('temp'), `skill-install-${Date.now()}`)
    fs.mkdirSync(tmpDir, { recursive: true })
    
    try {
      // 使用系统 unzip（Windows 用 PowerShell）
      if (process.platform === 'win32') {
        execSync(`powershell -command "Expand-Archive -Path '${zipPath}' -DestinationPath '${tmpDir}' -Force"`, {
          timeout: 30000,
        })
      } else {
        execSync(`unzip -o "${zipPath}" -d "${tmpDir}"`, { timeout: 30000 })
      }

      // 查找 skill.json（可能在子目录中）
      const manifestPath = this.findManifest(tmpDir)
      if (!manifestPath) {
        throw new Error('压缩包中未找到 skill.json')
      }

      const skill = this.loadAndValidateManifest(manifestPath)
      const targetDir = path.join(USER_SKILLS_DIR, skill.id)
      
      if (fs.existsSync(targetDir)) {
        throw new Error(`Skill "${skill.name}" 已安装`)
      }

      // 如果 skill.json 在子目录，复制整个子目录结构
      const sourceDir = path.dirname(manifestPath)
      this.copyDir(sourceDir, targetDir)
      saveUserSkill(skill)
      
      log.info(`[Skill] 从 zip 安装成功: ${skill.name}`)
      return skill
      
    } finally {
      // 清理临时目录
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  }

  /**
   * 从远程 URL 安装
   * 支持: 直接下载 skill.json + 资源，或下载 zip 包
   */
  async installFromUrl(url: string, checksum?: string): Promise<AgentSkill> {
    const tmpDir = path.join(app.getPath('temp'), `skill-download-${Date.now()}`)
    fs.mkdirSync(tmpDir, { recursive: true })

    try {
      // 下载
      const downloadPath = path.join(tmpDir, 'download')
      await this.downloadFile(url, downloadPath)
      
      // 校验
      if (checksum) {
        const actualChecksum = this.computeChecksum(downloadPath)
        if (actualChecksum !== checksum) {
          throw new Error(`校验和不匹配: 期望 ${checksum}, 实际 ${actualChecksum}`)
        }
      }

      // 判断是 zip 还是目录结构
      const isZip = url.endsWith('.zip') || this.isZipFile(downloadPath)
      
      if (isZip) {
        // 解压后安装
        const extractDir = path.join(tmpDir, 'extracted')
        fs.mkdirSync(extractDir)
        const { execSync } = require('child_process')
        
        if (process.platform === 'win32') {
          execSync(`powershell -command "Expand-Archive -Path '${downloadPath}' -DestinationPath '${extractDir}' -Force"`)
        } else {
          execSync(`unzip -o "${downloadPath}" -d "${extractDir}"`)
        }
        
        const manifestPath = this.findManifest(extractDir)
        if (!manifestPath) throw new Error('下载内容中未找到 skill.json')
        
        const skill = this.loadAndValidateManifest(manifestPath)
        const targetDir = path.join(USER_SKILLS_DIR, skill.id)
        if (fs.existsSync(targetDir)) throw new Error(`Skill "${skill.name}" 已安装`)
        
        const sourceDir = path.dirname(manifestPath)
        this.copyDir(sourceDir, targetDir)
        saveUserSkill(skill)
        
        log.info(`[Skill] 从 URL 安装成功: ${skill.name}`)
        return skill
      } else {
        // 直接是 skill.json
        const skill = this.loadAndValidateManifest(downloadPath)
        const targetDir = path.join(USER_SKILLS_DIR, skill.id)
        fs.mkdirSync(targetDir, { recursive: true })
        fs.copyFileSync(downloadPath, path.join(targetDir, 'skill.json'))
        saveUserSkill(skill)
        
        log.info(`[Skill] 从 URL 安装成功: ${skill.name}`)
        return skill
      }
      
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  }

  /**
   * 从 Skill 市场安装
   * 市场 API 返回 skill 元数据 + 下载 URL
   */
  async installFromMarket(marketUrl: string, skillId: string): Promise<AgentSkill> {
    // 1. 获取市场中的 skill 信息
    const skillInfo = await this.fetchMarketSkill(marketUrl, skillId)
    
    // 2. 下载并安装
    return this.installFromUrl(skillInfo.downloadUrl, skillInfo.checksum)
  }

  // ── 私有方法 ─────────────────────────────────

  private loadAndValidateManifest(manifestPath: string): AgentSkill {
    const content = fs.readFileSync(manifestPath, 'utf-8')
    const skill = JSON.parse(content) as AgentSkill
    
    // 校验必填字段
    const required = ['id', 'name', 'description', 'systemPromptAddition']
    for (const field of required) {
      if (!(skill as any)[field]) {
        throw new Error(`skill.json 缺少必填字段: ${field}`)
      }
    }
    
    // 校验 id 格式
    if (!/^[a-z0-9_-]{1,64}$/.test(skill.id)) {
      throw new Error(`skill id 格式无效: ${skill.id}（只允许小写字母、数字、连字符、下划线）`)
    }
    
    return skill
  }

  private findManifest(dir: string): string | null {
    // 先检查根目录
    const rootManifest = path.join(dir, 'skill.json')
    if (fs.existsSync(rootManifest)) return rootManifest
    
    // 递归查找一层子目录
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const subManifest = path.join(dir, entry.name, 'skill.json')
        if (fs.existsSync(subManifest)) return subManifest
      }
    }
    return null
  }

  private copyDir(src: string, dest: string): void {
    fs.mkdirSync(dest, { recursive: true })
    const entries = fs.readdirSync(src, { withFileTypes: true })
    for (const entry of entries) {
      const srcPath = path.join(src, entry.name)
      const destPath = path.join(dest, entry.name)
      if (entry.isDirectory()) {
        this.copyDir(srcPath, destPath)
      } else {
        fs.copyFileSync(srcPath, destPath)
      }
    }
  }

  private downloadFile(url: string, dest: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const protocol = url.startsWith('https') ? https : http
      const request = protocol.get(url, { timeout: 30000 }, (res) => {
        // 处理重定向
        if (res.statusCode === 301 || res.statusCode === 302) {
          const redirectUrl = res.headers.location
          if (redirectUrl) {
            this.downloadFile(redirectUrl, dest).then(resolve).catch(reject)
            return
          }
        }
        
        if (res.statusCode !== 200) {
          reject(new Error(`下载失败: HTTP ${res.statusCode}`))
          return
        }
        
        const fileStream = fs.createWriteStream(dest)
        res.pipe(fileStream)
        fileStream.on('finish', () => {
          fileStream.close()
          resolve()
        })
      })
      request.on('error', reject)
      request.on('timeout', () => {
        request.destroy()
        reject(new Error('下载超时'))
      })
    })
  }

  private computeChecksum(filePath: string): string {
    const hash = createHash('sha256')
    const data = fs.readFileSync(filePath)
    hash.update(data)
    return hash.digest('hex')
  }

  private isZipFile(filePath: string): boolean {
    // 检查文件头 (zip 文件以 PK 开头)
    const buffer = Buffer.alloc(2)
    const fd = fs.openSync(filePath, 'r')
    fs.readSync(fd, buffer, 0, 2, 0)
    fs.closeSync(fd)
    return buffer[0] === 0x50 && buffer[1] === 0x4b
  }

  private async fetchMarketSkill(marketUrl: string, skillId: string): Promise<{
    downloadUrl: string
    checksum: string
  }> {
    return new Promise((resolve, reject) => {
      const url = `${marketUrl}/api/skills/${skillId}`
      https.get(url, { timeout: 10000 }, (res) => {
        let data = ''
        res.on('data', chunk => data += chunk)
        res.on('end', () => {
          try {
            const json = JSON.parse(data)
            resolve({ downloadUrl: json.downloadUrl, checksum: json.checksum })
          } catch (e) {
            reject(new Error('市场 API 返回格式错误'))
          }
        })
      }).on('error', reject)
    })
  }
}
```

### 8.5 Skill 市场（发现）

**位置**：`src/main/agent/skills/market.ts`

```typescript
// src/main/agent/skills/market.ts

import * as https from 'https'
import log from 'electron-log/main'

/** Skill 市场中的条目（远端） */
export interface MarketSkillEntry {
  id: string
  name: string
  description: string
  category: string
  icon: string
  author: string
  version: string
  tags: string[]
  installCount: number
  rating: number
  downloadUrl: string
  checksum: string
  updatedAt: string
}

/** 市场 API 响应 */
export interface MarketResponse {
  skills: MarketSkillEntry[]
  total: number
  page: number
  pageSize: number
}

/**
 * Skill 市场客户端
 * 
 * 市场 API 规范:
 *   GET /api/skills              → 列表（支持 ?category=&search=&page=&pageSize=）
 *   GET /api/skills/:id          → 详情
 *   GET /api/skills/:id/download → 下载
 *   GET /api/categories          → 分类列表
 *   GET /api/featured            → 推荐列表
 */
export class SkillMarketClient {
  
  private baseUrl: string
  
  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '')
  }

  /**
   * 获取 Skill 列表
   */
  async listSkills(params?: {
    category?: string
    search?: string
    page?: number
    pageSize?: number
    sort?: 'popular' | 'recent' | 'rating'
  }): Promise<MarketResponse> {
    const query = new URLSearchParams()
    if (params?.category) query.set('category', params.category)
    if (params?.search) query.set('search', params.search)
    if (params?.page) query.set('page', String(params.page))
    if (params?.pageSize) query.set('pageSize', String(params.pageSize))
    if (params?.sort) query.set('sort', params.sort)
    
    const url = `${this.baseUrl}/api/skills?${query}`
    return this.fetchJson<MarketResponse>(url)
  }

  /**
   * 获取推荐 Skills
   */
  async getFeatured(): Promise<MarketSkillEntry[]> {
    const url = `${this.baseUrl}/api/featured`
    const data = await this.fetchJson<{ skills: MarketSkillEntry[] }>(url)
    return data.skills
  }

  /**
   * 获取分类列表
   */
  async getCategories(): Promise<Array<{ id: string; name: string; icon: string; count: number }>> {
    const url = `${this.baseUrl}/api/categories`
    return this.fetchJson(url)
  }

  /**
   * 获取 Skill 详情
   */
  async getSkillDetail(skillId: string): Promise<MarketSkillEntry> {
    const url = `${this.baseUrl}/api/skills/${skillId}`
    return this.fetchJson<MarketSkillEntry>(url)
  }

  /**
   * 检查已安装 Skills 是否有更新
   */
  async checkUpdates(installedSkills: Array<{ id: string; version: string }>): Promise<Array<{
    id: string
    currentVersion: string
    latestVersion: string
    downloadUrl: string
  }>> {
    const url = `${this.baseUrl}/api/updates`
    return this.fetchJson(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skills: installedSkills }),
    })
  }

  private async fetchJson<T>(url: string, options?: {
    method?: string
    headers?: Record<string, string>
    body?: string
  }): Promise<T> {
    return new Promise((resolve, reject) => {
      const isHttps = url.startsWith('https')
      const protocol = isHttps ? https : require('http')
      
      const request = protocol.request(url, {
        method: options?.method ?? 'GET',
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'XiaoNiuMa-Agent/2.0',
          ...options?.headers,
        },
        timeout: 10000,
      }, (res) => {
        let data = ''
        res.on('data', chunk => data += chunk)
        res.on('end', () => {
          try {
            resolve(JSON.parse(data))
          } catch (e) {
            reject(new Error(`JSON 解析失败: ${data.slice(0, 100)}`))
          }
        })
      })
      
      request.on('error', reject)
      request.on('timeout', () => {
        request.destroy()
        reject(new Error('请求超时'))
      })
      
      if (options?.body) {
        request.write(options.body)
      }
      request.end()
    })
  }
}

/** 默认市场 URL（可配置） */
export const DEFAULT_MARKET_URL = 'https://skills.xiaoniuma.app'
```

### 8.6 Skill 匹配与注入

```typescript
// src/main/agent/skills/matcher.ts

import { getAllSkills } from './store'
import type { AgentSkill } from './types'

/**
 * 根据用户输入匹配相关 Skill
 * 策略：关键词匹配 + 语义相似度（可选）
 */
export function matchSkills(userInput: string): AgentSkill[] {
  const input = userInput.toLowerCase()
  const allSkills = getAllSkills().filter(s => s.enabled)
  
  // 1. 精确触发词匹配
  const matched = new Set<string>()
  const results: Array<{ skill: AgentSkill; score: number }> = []
  
  for (const skill of allSkills) {
    let score = 0
    
    // 触发词匹配（权重最高）
    for (const trigger of skill.triggers) {
      if (input.includes(trigger.toLowerCase())) {
        score += 10
        matched.add(skill.id)
      }
    }
    
    // 标签匹配
    for (const tag of skill.meta.tags) {
      if (input.includes(tag.toLowerCase())) {
        score += 5
        matched.add(skill.id)
      }
    }
    
    // 名称匹配
    if (input.includes(skill.name.toLowerCase())) {
      score += 3
      matched.add(skill.id)
    }
    
    // 描述关键词匹配
    const descWords = skill.description.toLowerCase().split(/\s+/)
    for (const word of descWords) {
      if (word.length > 1 && input.includes(word)) {
        score += 1
      }
    }
    
    if (score > 0) {
      results.push({ skill, score })
    }
  }
  
  // 按匹配度排序，最多返回 3 个
  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(r => r.skill)
}

/**
 * 将匹配的 Skill 注入到 System Prompt
 */
export function injectSkills(
  basePrompt: string,
  skills: AgentSkill[],
): string {
  if (skills.length === 0) return basePrompt
  
  const sections = skills.map(s => s.systemPromptAddition.trim())
  
  return basePrompt + '\n\n# 激活的技能\n' + sections.join('\n\n')
}

/**
 * 获取 Skill 使用统计（用于推荐）
 */
export function getSkillUsageStats(): Array<{ skillId: string; useCount: number; lastUsed: number }> {
  // 从 Agent 会话历史中统计 skill 使用频率
  // 实现略...
  return []
}
```

### 8.7 Skill 文件格式规范

用户创建自定义 Skill 只需一个 `skill.json`：

```json
{
  "id": "my-custom-skill",
  "name": "我的自定义技能",
  "description": "这个技能帮我做某件事",
  "category": "custom",
  "icon": "🎯",
  "author": "用户名",
  "version": "1.0.0",
  "triggers": ["触发词1", "触发词2"],
  "systemPromptAddition": "## 当前技能: 我的自定义技能\n执行步骤:\n1. 第一步\n2. 第二步",
  "recommendedTools": ["read_file", "write_file"],
  "suggestedSteps": ["步骤1描述", "步骤2描述"],
  "meta": {
    "tags": ["标签1", "标签2"],
    "createdAt": "2026-05-18",
    "updatedAt": "2026-05-18"
  }
}
```

### 8.8 Skill 管理 UI

```
┌─────────────────────────────────────────────────────────────────┐
│  🧩 Skill 管理                                      [+ 安装]   │
├─────────────────────────────────────────────────────────────────┤
│  [全部] [生产力📋] [文件📁] [代码🔍] [沟通📧] [数据📈] [自动化⚙️] │
│                                                                 │
│  ── 已安装 (6) ──────────────────────────────────────────────   │
│                                                                 │
│  ┌─ 📋 每日复盘 ────────────────────────────────────────────┐  │
│  │  自动整理今天的工作日志，生成复盘报告           ✅ 已启用  │  │
│  │  触发词: 复盘 / 总结今天 / 日报                            │  │
│  │  [配置] [禁用] [卸载]                                      │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ┌─ 📁 文件整理 ────────────────────────────────────────────┐  │
│  │  按规则整理指定目录的文件                         ✅ 已启用  │  │
│  │  触发词: 整理文件 / 清理桌面 / 归类文件                    │  │
│  │  [配置] [禁用] [卸载]                                      │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ── 推荐安装 ────────────────────────────────────────────────   │
│                                                                 │
│  ┌─ 📧 邮件助手 ────────────────────────────────────────────┐  │
│  │  起草、润色、翻译邮件                             ⬇️ 安装   │  │
│  │  ⭐ 4.8  ·  📥 1.2k  ·  作者: 小小牛马                   │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ┌─ 📈 数据分析 ────────────────────────────────────────────┐  │
│  │  读取数据文件，生成统计报告和可视化               ⬇️ 安装   │  │
│  │  ⭐ 4.6  ·  📥 856  ·  作者: 小小牛马                    │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                 │
├─────────────────────────────────────────────────────────────────┤
│  🔍 搜索 Skills  ·  🌐 浏览市场  ·  📦 从文件安装  ·  ✏️ 创建  │
└─────────────────────────────────────────────────────────────────┘
```

### 8.9 Skill 市场 UI

```
┌─────────────────────────────────────────────────────────────────┐
│  🌐 Skill 市场                                                   │
├─────────────────────────────────────────────────────────────────┤
│  🔍 搜索 Skills...                    [分类 ▼] [排序: 热门 ▼]   │
│                                                                 │
│  ── 🔥 推荐 ─────────────────────────────────────────────────   │
│                                                                 │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐          │
│  │ 📋       │ │ 📊       │ │ 🔍       │ │ 📧       │          │
│  │ 每日复盘 │ │ 周报生成 │ │ 代码审查 │ │ 邮件助手 │          │
│  │ ⭐ 4.9   │ │ ⭐ 4.8   │ │ ⭐ 4.7   │ │ ⭐ 4.8   │          │
│  │ 📥 2.3k  │ │ 📥 1.8k  │ │ 📥 1.5k  │ │ 📥 1.2k  │          │
│  │ [已安装] │ │ [安装]   │ │ [安装]   │ │ [安装]   │          │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘          │
│                                                                 │
│  ── 📁 文件类 ───────────────────────────────────────────────   │
│                                                                 │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐                       │
│  │ 📁       │ │ 🔄       │ │ 📦       │                       │
│  │ 文件整理 │ │ 格式转换 │ │ 批量重命名│                       │
│  │ ⭐ 4.6   │ │ ⭐ 4.5   │ │ ⭐ 4.4   │                       │
│  │ [安装]   │ │ [安装]   │ │ [安装]   │                       │
│  └──────────┘ └──────────┘ └──────────┘                       │
│                                                                 │
│  ── 💻 代码类 ───────────────────────────────────────────────   │
│  ── 📧 沟通类 ───────────────────────────────────────────────   │
│  ── ⚙️ 自动化类 ─────────────────────────────────────────────   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 8.10 IPC 集成

```typescript
// 在 ipc-handlers.ts 中注册 Skill 相关 IPC

import {
  getAllSkills,
  getSkillsByCategory,
  searchSkills,
  toggleSkill,
  deleteUserSkill,
} from './agent/skills/store'
import { SkillInstaller } from './agent/skills/installer'
import { SkillMarketClient, DEFAULT_MARKET_URL } from './agent/skills/market'

const skillInstaller = new SkillInstaller()
const marketClient = new SkillMarketClient(DEFAULT_MARKET_URL)

// ── Skill 管理 ──────────────────────────────────

ipcMain.handle(IPC.SKILLS_LIST, () => getAllSkills())
ipcMain.handle(IPC.SKILLS_BY_CATEGORY, (_e, category) => getSkillsByCategory(category))
ipcMain.handle(IPC.SKILLS_SEARCH, (_e, query) => searchSkills(query))
ipcMain.handle(IPC.SKILLS_TOGGLE, (_e, skillId) => toggleSkill(skillId))
ipcMain.handle(IPC.SKILLS_DELETE, (_e, skillId) => deleteUserSkill(skillId))

// ── Skill 安装 ──────────────────────────────────

ipcMain.handle(IPC.SKILLS_INSTALL_DIR, async (_e, dirPath) => {
  return skillInstaller.installFromDir(dirPath)
})

ipcMain.handle(IPC.SKILLS_INSTALL_ZIP, async (_e, zipPath) => {
  return skillInstaller.installFromZip(zipPath)
})

ipcMain.handle(IPC.SKILLS_INSTALL_URL, async (_e, url, checksum) => {
  return skillInstaller.installFromUrl(url, checksum)
})

ipcMain.handle(IPC.SKILLS_INSTALL_MARKET, async (_e, skillId) => {
  return skillInstaller.installFromMarket(DEFAULT_MARKET_URL, skillId)
})

// ── Skill 市场 ──────────────────────────────────

ipcMain.handle(IPC.MARKET_LIST, async (_e, params) => {
  return marketClient.listSkills(params)
})

ipcMain.handle(IPC.MARKET_FEATURED, async () => {
  return marketClient.getFeatured()
})

ipcMain.handle(IPC.MARKET_CATEGORIES, async () => {
  return marketClient.getCategories()
})

ipcMain.handle(IPC.MARKET_DETAIL, async (_e, skillId) => {
  return marketClient.getSkillDetail(skillId)
})

ipcMain.handle(IPC.MARKET_CHECK_UPDATES, async (_e, installedSkills) => {
  return marketClient.checkUpdates(installedSkills)
})
```

### 8.11 新增 IPC 通道

```typescript
// 在 ipc-channels.ts 中添加

export const IPC = {
  // ... 现有通道 ...
  
  // ── Skill 管理 ──
  SKILLS_LIST: 'skills:list',
  SKILLS_BY_CATEGORY: 'skills:by-category',
  SKILLS_SEARCH: 'skills:search',
  SKILLS_TOGGLE: 'skills:toggle',
  SKILLS_DELETE: 'skills:delete',
  
  // ── Skill 安装 ──
  SKILLS_INSTALL_DIR: 'skills:install:dir',
  SKILLS_INSTALL_ZIP: 'skills:install:zip',
  SKILLS_INSTALL_URL: 'skills:install:url',
  SKILLS_INSTALL_MARKET: 'skills:install:market',
  
  // ── Skill 市场 ──
  MARKET_LIST: 'market:list',
  MARKET_FEATURED: 'market:featured',
  MARKET_CATEGORIES: 'market:categories',
  MARKET_DETAIL: 'market:detail',
  MARKET_CHECK_UPDATES: 'market:check-updates',
} as const
```

### 8.12 新增文件清单

```
src/
├── main/agent/skills/
│   ├── types.ts              # Skill 类型定义
│   ├── built-in.ts           # 6 个内置 Skills
│   ├── store.ts              # Skill 存储/管理/搜索
│   ├── installer.ts          # Skill 安装器（目录/zip/URL/市场）
│   ├── market.ts             # Skill 市场客户端
│   └── matcher.ts            # Skill 匹配与注入
├── (扩展) ipc-handlers.ts    # 注册 Skill IPC
└── (扩展) ipc-channels.ts    # 新增 Skill IPC 通道
```

---

## 九、安全设计

### 9.1 工具安全分级

| 级别 | 工具 | 说明 |
|------|------|------|
| 🟢 安全 | read_file, list_files, get_today_log, get_todos, get_logs_range | 只读操作，无需确认 |
| 🟡 谨慎 | write_file, edit_file, save_todo, update_todo, append_log | 写入操作，记录日志 |
| 🟠 敏感 | run_command, open_file | 执行命令，需要安全扫描 |
| 🔴 危险 | （不开放）rm, format, shutdown 等 | 不允许 Agent 直接执行 |

### 9.2 路径白名单

```typescript
// src/main/agent/security.ts

import * as path from 'path'
import { app } from 'electron'

/**
 * Agent 可访问的路径白名单
 */
export function getAllowedPaths(): string[] {
  const home = require('os').homedir()
  return [
    path.join(app.getPath('userData'), 'xiao-niu-ma'),
    path.join(home, 'Desktop'),
    path.join(home, 'Documents'),
    path.join(home, 'Downloads'),
    path.join(home, 'Projects'),  // 开发项目目录
    '/tmp',
    '/var/tmp',
  ]
}

export function isPathAllowed(targetPath: string): boolean {
  const resolved = path.resolve(targetPath)
  return getAllowedPaths().some(allowed => resolved.startsWith(allowed))
}
```

### 9.3 命令黑名单

```typescript
const DANGEROUS_PATTERNS = [
  'rm -rf /', 'rm -rf ~', 'rm -rf *',
  'mkfs', 'fdisk', 'dd if=',
  ':(){:|:&};:',  # fork bomb
  '> /dev/sda', '> /dev/nvme',
  'shutdown', 'reboot', 'halt',
  'format ', 'del /f /s /q',
  'Remove-Item -Recurse -Force',
]

export function isCommandSafe(command: string): boolean {
  const lower = command.toLowerCase()
  return !DANGEROUS_PATTERNS.some(p => lower.includes(p))
}
```

---

## 十、实施路线图

### Phase 1: 核心 Agent（2 周）

| 任务 | 时间 | 说明 |
|------|------|------|
| 搭建 Agent 模块骨架 | 2 天 | types.ts, orchestrator.ts 基础框架 |
| 实现工具执行器 | 3 天 | tool-executor.ts + 8 个核心工具 |
| 实现 System Prompt 构建 | 1 天 | system-prompt.ts + 上下文注入 |
| 实现 IPC 集成 | 2 天 | ipc-handlers.ts 扩展 + 通道注册 |
| AgentChat 页面基础 UI | 3 天 | 对话界面 + 流式输出 + 工具调用卡片 |
| 会话持久化 | 1 天 | session-store.ts |
| 联调测试 | 2 天 | 端到端测试 |

### Phase 2: 增强能力（2 周）

| 任务 | 时间 | 说明 |
|------|------|------|
| Skill 基础系统 | 2 天 | types + built-in + store + matcher |
| Skill 安装系统 | 2 天 | installer（目录/zip/URL/市场） |
| Skill 市场客户端 | 1 天 | market.ts + 浏览/搜索/安装 UI |
| Skill 管理 UI | 2 天 | 已安装列表/启用禁用/卸载/配置 |
| 安全机制 | 1 天 | 路径白名单 + 命令黑名单 |
| 错误恢复优化 | 1 天 | 重试策略 + 降级方案 |
| 托盘入口 + 快捷键 | 1 天 | 从托盘/快捷键启动 Agent 模式 |

### Phase 3: 体验优化（1 周）

| 任务 | 时间 | 说明 |
|------|------|------|
| 执行日志面板 | 2 天 | 详细的步骤执行日志 |
| Agent 设置页面 | 2 天 | 工具权限、模型选择、安全设置 |
| 小猫动画联动 | 1 天 | Agent 执行时小猫切换 busy 动画 |
| 性能优化 | 2 天 | 上下文压缩、大文件分块读取 |

---

## 十一、定时任务与 Agent 融合

### 11.1 现有定时系统分析

项目已有**两套独立定时系统**，各自为战：

| 系统 | 文件 | 调度粒度 | 触发方式 | 能力 |
|------|------|---------|---------|------|
| **上下班触发器** | `scheduler.ts` | 30 秒 | 时间区间检测 + powerMonitor resume | 仅触发 morning/evening 事件 |
| **定时任务调度器** | `tools/task-scheduler.ts` | 30 秒 | interval/daily/weekly | 执行 shell 命令 + 日志 |

**核心问题**：这两套系统都只能做"到时间 → 执行固定操作"，无法做到"到时间 → 让 Agent 自主决策并执行复杂任务"。

### 11.2 融合设计思路

把定时系统升级为 **Agent Cron**：时间触发只是 Agent 的"闹钟"，醒来后 Agent 自主规划、执行、汇报。

```
┌─────────────────────────────────────────────────────────────┐
│                    Agent Cron 架构                           │
│                                                             │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐  │
│  │ 时间触发器   │    │ 事件触发器   │    │ 手动触发     │  │
│  │ (cron-like)  │    │ (系统事件)   │    │ (用户指令)   │  │
│  └──────┬───────┘    └──────┬───────┘    └──────┬───────┘  │
│         │                   │                   │          │
│         └───────────────────┼───────────────────┘          │
│                             ▼                               │
│                   ┌──────────────────┐                      │
│                   │  Agent Task      │                      │
│                   │  Queue           │                      │
│                   │  (任务队列)      │                      │
│                   └────────┬─────────┘                      │
│                            ▼                                │
│                   ┌──────────────────┐                      │
│                   │  Agent           │                      │
│                   │  Orchestrator    │ ← 复用 Agent 引擎    │
│                   │  (编排执行)      │                      │
│                   └────────┬─────────┘                      │
│                            ▼                                │
│              ┌─────────────┼─────────────┐                  │
│              ▼             ▼             ▼                  │
│         ┌────────┐   ┌────────┐   ┌────────┐              │
│         │ 工具集 │   │ Skills │   │ 通知   │              │
│         │(文件/  │   │(工作流 │   │(桌面/  │              │
│         │ 命令/  │   │ 模板)  │   │ 声音/  │              │
│         │ 数据)  │   │        │   │ 小猫)  │              │
│         └────────┘   └────────┘   └────────┘              │
└─────────────────────────────────────────────────────────────┘
```

### 11.3 Agent Cron 任务类型

```typescript
// src/main/agent/cron/types.ts

/**
 * Agent Cron 任务
 * 相比现有 ScheduledTask，核心区别：
 * 1. 触发后不是执行固定命令，而是启动一个 Agent 会话
 * 2. 支持自然语言描述任务目标
 * 3. 支持条件判断（如"如果今天有待办未完成才执行"）
 * 4. 执行结果通过小猫通知用户
 */
export interface AgentCronTask {
  id: string
  name: string
  description: string
  
  /** 调度配置（复用现有 TaskSchedule） */
  schedule: {
    type: 'interval' | 'daily' | 'weekly' | 'once'
    intervalMinutes?: number
    time?: string
    weekDay?: number
    /** 一次性任务的执行时间 */
    at?: string  // ISO 8601
  }
  
  /** Agent 任务配置 */
  agentTask: {
    /** 任务目标（自然语言描述，Agent 会据此自主规划） */
    goal: string
    /** 注入到 Agent 上下文的额外信息 */
    context?: Record<string, string>
    /** 可用的工具白名单（不填则使用全部） */
    allowedTools?: string[]
    /** 最大执行步数 */
    maxSteps?: number
    /** 超时时间（分钟） */
    timeoutMinutes?: number
  }
  
  /** 通知配置 */
  notify: {
    /** 执行完成后通知 */
    onComplete: boolean
    /** 执行失败时通知 */
    onError: boolean
    /** 通知方式 */
    channels: ('desktop' | 'cat-bubble' | 'sound')[]
  }
  
  enabled: boolean
  createdAt: string
  updatedAt: string
  lastRunAt?: string
  lastRunStatus?: 'success' | 'failed' | 'running' | 'timeout'
  lastRunSummary?: string  // Agent 执行结果摘要
}
```

### 11.4 Agent Cron 调度引擎

**位置**：`src/main/agent/cron/scheduler.ts`

```typescript
// src/main/agent/cron/scheduler.ts

import { powerMonitor } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'
import log from 'electron-log/main'
import type { AgentCronTask } from './types'
import { AgentOrchestrator } from '../orchestrator'
import { buildAgentContext } from '../system-prompt'
import { getMainWindow } from '../../windows'
import { getConfig } from '../../store'

const CRON_FILE = path.join(app.getPath('userData'), 'agent-crons.json')

// ── 持久化 ─────────────────────────────────────

function loadCrons(): AgentCronTask[] {
  try {
    if (!fs.existsSync(CRON_FILE)) return []
    return JSON.parse(fs.readFileSync(CRON_FILE, 'utf-8'))
  } catch { return [] }
}

function saveCrons(crons: AgentCronTask[]): void {
  const tmp = CRON_FILE + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(crons, null, 2), 'utf-8')
  fs.renameSync(tmp, CRON_FILE)
}

// ── 调度引擎 ───────────────────────────────────

let schedulerInterval: NodeJS.Timeout | null = null
const runningCrons = new Map<string, AbortController>()

/**
 * 启动 Agent Cron 调度引擎
 * 复用现有 scheduler.ts 的 30 秒检查周期
 */
export function startAgentCronScheduler(): void {
  log.info('[AgentCron] 调度引擎已启动')
  schedulerInterval = setInterval(checkAndTrigger, 30 * 1000)
  setTimeout(checkAndTrigger, 5000)
  
  // 睡眠唤醒后立即检查
  powerMonitor.on('resume', () => {
    setTimeout(checkAndTrigger, 2000)
  })
}

export function stopAgentCronScheduler(): void {
  if (schedulerInterval) {
    clearInterval(schedulerInterval)
    schedulerInterval = null
  }
  // 中止所有运行中的 Agent Cron
  for (const [id, ctrl] of runningCrons) {
    ctrl.abort()
    runningCrons.delete(id)
  }
  log.info('[AgentCron] 调度引擎已停止')
}

/**
 * 核心调度检查
 * 复用 task-scheduler.ts 的时间匹配逻辑
 */
function checkAndTrigger(): void {
  const crons = loadCrons().filter(c => c.enabled)
  const now = new Date()

  for (const cron of crons) {
    // 防重入
    if (runningCrons.has(cron.id)) continue
    
    if (shouldTrigger(cron, now)) {
      triggerAgentCron(cron)
    }
  }
}

function shouldTrigger(cron: AgentCronTask, now: Date): boolean {
  const { schedule } = cron
  
  // 检查是否已在本周期内执行过
  if (cron.lastRunAt) {
    const lastRun = new Date(cron.lastRunAt)
    
    if (schedule.type === 'daily') {
      // 今天已执行过
      if (lastRun.toDateString() === now.toDateString()) return false
    } else if (schedule.type === 'weekly') {
      // 本周已执行过
      const weekStart = new Date(now)
      weekStart.setDate(now.getDate() - now.getDay())
      if (lastRun >= weekStart) return false
    } else if (schedule.type === 'interval') {
      const intervalMs = (schedule.intervalMinutes ?? 60) * 60 * 1000
      if (now.getTime() - lastRun.getTime() < intervalMs) return false
    } else if (schedule.type === 'once') {
      // 一次性任务，已执行过就不再执行
      if (cron.lastRunStatus) return false
      // 还没到时间
      if (schedule.at && now < new Date(schedule.at)) return false
    }
  }

  // 时间匹配（复用 task-scheduler.ts 的区间检测逻辑）
  if (schedule.type === 'interval') return true  // 间隔型直接触发
  
  if (schedule.time) {
    const [h, m] = schedule.time.split(':').map(Number)
    if (now.getHours() < h) return false
    if (now.getHours() === h && now.getMinutes() < m) return false
  }
  
  if (schedule.type === 'weekly' && schedule.weekDay !== undefined) {
    if (now.getDay() !== schedule.weekDay) return false
  }

  return true
}

/**
 * 触发 Agent Cron 任务
 * 核心：不是执行固定命令，而是启动一个 Agent 会话
 */
async function triggerAgentCron(cron: AgentCronTask): void {
  log.info(`[AgentCron] 触发任务: ${cron.name}`)
  
  const abortController = new AbortController()
  runningCrons.set(cron.id, abortController)

  // 更新最后执行时间
  const crons = loadCrons()
  const cronIdx = crons.findIndex(c => c.id === cron.id)
  if (cronIdx >= 0) {
    crons[cronIdx].lastRunAt = new Date().toISOString()
    crons[cronIdx].lastRunStatus = 'running'
    saveCrons(crons)
  }

  // 通过小猫气泡通知用户
  notifyUser('cat-bubble', `🤖 开始执行定时任务: ${cron.name}`)

  try {
    // 构建 Agent 上下文
    const context = buildAgentContext()
    
    // 注入 Cron 任务上下文
    context.cronTaskName = cron.name
    context.cronTaskDescription = cron.description
    if (cron.agentTask.context) {
      Object.assign(context, cron.agentTask.context)
    }

    // 创建 Agent 编排器
    const agent = new AgentOrchestrator(`cron_${cron.id}_${Date.now()}`)
    
    // 执行
    const result = await agent.run(
      cron.agentTask.goal,
      context,
      {
        onChunk: (payload) => {
          // Agent Cron 不需要实时推送到 UI（后台执行）
          // 但如果有 Agent 窗口打开，可以推送进度
          broadcastToAgentWindows('agent:cron:progress', {
            cronId: cron.id,
            cronName: cron.name,
            ...payload,
          })
        },
        onDone: (payload) => {
          handleCronComplete(cron, payload.content, 'success')
        },
        onError: (payload) => {
          handleCronComplete(cron, payload.error, 'failed')
        },
        onToolExecutionStart: () => {},
        onToolExecuting: () => {},
        onToolExecuted: () => {},
      },
    )

    if (!result.success) {
      handleCronComplete(cron, result.error ?? '未知错误', 'failed')
    }

  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    handleCronComplete(cron, msg, 'failed')
  } finally {
    runningCrons.delete(cron.id)
  }
}

/**
 * 任务完成处理
 */
function handleCronComplete(
  cron: AgentCronTask,
  summary: string,
  status: 'success' | 'failed' | 'timeout',
): void {
  log.info(`[AgentCron] 任务完成: ${cron.name} (${status})`)

  // 更新状态
  const crons = loadCrons()
  const idx = crons.findIndex(c => c.id === cron.id)
  if (idx >= 0) {
    crons[idx].lastRunStatus = status
    crons[idx].lastRunSummary = summary.slice(0, 200)
    saveCrons(crons)
  }

  // 通知用户
  if (cron.notify.onComplete && status === 'success') {
    notifyUser(cron.notify.channels, `✅ ${cron.name} 完成`, summary)
  }
  if (cron.notify.onError && status === 'failed') {
    notifyUser(cron.notify.channels, `❌ ${cron.name} 执行失败`, summary)
  }
}

/**
 * 通知用户（复用现有通知渠道）
 */
function notifyUser(
  channels: ('desktop' | 'cat-bubble' | 'sound')[],
  title: string,
  body?: string,
): void {
  const win = getMainWindow()
  
  if (channels.includes('cat-bubble') && win) {
    // 通过小猫气泡显示
    win.webContents.send('agent:notification', {
      title,
      body: body?.slice(0, 100),
      type: 'cron-result',
    })
  }
  
  if (channels.includes('desktop')) {
    // 系统通知（复用现有 Notification）
    const { Notification } = require('electron')
    new Notification({ title, body: body?.slice(0, 200) }).show()
  }
}

/**
 * 广播到所有 Agent 窗口
 */
function broadcastToAgentWindows(channel: string, payload: unknown): void {
  const { BrowserWindow } = require('electron')
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload)
  }
}

// ── CRUD ────────────────────────────────────────

export function listAgentCrons(): AgentCronTask[] {
  return loadCrons()
}

export function saveAgentCron(cron: Partial<AgentCronTask> & { name: string; goal: string }): AgentCronTask {
  const crons = loadCrons()
  const now = new Date().toISOString()

  if (cron.id) {
    const idx = crons.findIndex(c => c.id === cron.id)
    if (idx >= 0) {
      crons[idx] = { ...crons[idx], ...cron, updatedAt: now } as AgentCronTask
      saveCrons(crons)
      return crons[idx]
    }
  }

  const newCron: AgentCronTask = {
    id: `agent_cron_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name: cron.name,
    description: cron.description ?? '',
    schedule: cron.schedule ?? { type: 'daily', time: '09:00' },
    agentTask: {
      goal: cron.goal,
      context: cron.context,
      allowedTools: cron.allowedTools,
      maxSteps: cron.maxSteps ?? 20,
      timeoutMinutes: cron.timeoutMinutes ?? 10,
    },
    notify: cron.notify ?? {
      onComplete: true,
      onError: true,
      channels: ['cat-bubble'],
    },
    enabled: cron.enabled ?? true,
    createdAt: now,
    updatedAt: now,
  }

  crons.push(newCron)
  saveCrons(crons)
  return newCron
}

export function deleteAgentCron(id: string): boolean {
  const crons = loadCrons()
  const filtered = crons.filter(c => c.id !== id)
  if (filtered.length === crons.length) return false
  saveCrons(filtered)
  return true
}

export function toggleAgentCron(id: string): AgentCronTask | null {
  const crons = loadCrons()
  const cron = crons.find(c => c.id === id)
  if (!cron) return null
  cron.enabled = !cron.enabled
  cron.updatedAt = new Date().toISOString()
  saveCrons(crons)
  return cron
}

/**
 * 手动触发（用于测试）
 */
export async function runAgentCronNow(id: string): Promise<void> {
  const crons = loadCrons()
  const cron = crons.find(c => c.id === id)
  if (!cron) throw new Error(`任务不存在: ${id}`)
  await triggerAgentCron(cron)
}
```

### 11.5 融合现有两套定时系统

融合后，现有系统不需要删除，而是被 Agent Cron **统一调度**：

```typescript
// src/main/agent/cron/migration.ts

/**
 * 将现有 ScheduledTask 迁移为 Agent Cron 任务
 * 用户可以选择是否迁移
 */
export function migrateExistingTasks(): void {
  const { listTasks } = require('../../tools/task-scheduler')
  const existingTasks = listTasks()
  
  for (const task of existingTasks) {
    // 将 shell 命令包装为 Agent 任务目标
    const goal = `执行以下命令并报告结果：${task.command}`
    
    saveAgentCron({
      name: `[迁移] ${task.name}`,
      description: `从定时任务迁移: ${task.command}`,
      schedule: {
        type: task.schedule.type,
        time: task.schedule.time,
        intervalMinutes: task.schedule.intervalMinutes,
        weekDay: task.schedule.weekDay,
      },
      goal,
      allowedTools: ['run_command'],  // 迁移的任务只允许 run_command
      notify: {
        onComplete: true,
        onError: true,
        channels: ['desktop'],
      },
      enabled: task.enabled,
    })
  }
}
```

### 11.6 内置 Agent Cron 模板

```typescript
// src/main/agent/cron/built-in-templates.ts

import type { AgentCronTask } from './types'

/**
 * 预置的 Agent Cron 模板
 * 用户可以直接选用，也可以自定义
 */
export const AGENT_CRON_TEMPLATES: Array<{
  id: string
  name: string
  description: string
  icon: string
  template: Omit<AgentCronTask, 'id' | 'createdAt' | 'updatedAt'>
}> = [
  {
    id: 'morning-plan',
    name: '晨间计划整理',
    description: '每天早上自动整理今日待办，分析优先级，生成工作计划',
    icon: '🌅',
    template: {
      name: '晨间计划整理',
      description: '自动分析今日待办并生成工作计划',
      schedule: { type: 'daily', time: '09:00' },
      agentTask: {
        goal: `现在是早晨，请帮我整理今天的工作计划：
1. 调用 get_todos 获取当前所有待办
2. 调用 get_today_log 查看今天是否已有日志
3. 分析待办优先级，给出今日工作建议
4. 如果待办为空，提醒用户可以录入今日计划
5. 将分析结果通过 append_log 写入今天的日志`,
        maxSteps: 10,
        timeoutMinutes: 5,
      },
      notify: { onComplete: true, onError: true, channels: ['cat-bubble'] },
      enabled: true,
    },
  },
  {
    id: 'evening-review',
    name: '晚间复盘',
    description: '每天下班时间自动复盘今日工作，生成日志',
    icon: '🌆',
    template: {
      name: '晚间复盘',
      description: '自动复盘今日工作并生成日志',
      schedule: { type: 'daily', time: '18:00' },
      agentTask: {
        goal: `现在是下班时间，请帮我复盘今天的工作：
1. 调用 get_today_log 获取今天的日志和待办
2. 分析完成情况：哪些完成了，哪些未完成
3. 对于未完成的待办，询问是否延后到明天
4. 生成今日工作总结（2-3 句话）
5. 将总结追加到今天的 eod_log
6. 如果今天没有记录任何工作，提醒用户补充`,
        maxSteps: 15,
        timeoutMinutes: 8,
      },
      notify: { onComplete: true, onError: true, channels: ['cat-bubble', 'desktop'] },
      enabled: true,
    },
  },
  {
    id: 'weekly-report',
    name: '周报自动生成',
    description: '每周五下班后自动生成本周工作总结',
    icon: '📊',
    template: {
      name: '周报自动生成',
      description: '每周五自动生成本周工作总结',
      schedule: { type: 'weekly', time: '18:30', weekDay: 5 },
      agentTask: {
        goal: `今天是周五，请帮我生成本周工作总结：
1. 调用 get_logs_range 获取本周一到周五的日志
2. 分析每天的工作内容和完成情况
3. 按项目/主题归类
4. 生成标准周报格式（Markdown）：
   - 本周工作概览
   - 主要工作内容（按主题）
   - 工作亮点
   - 问题与不足
   - 下周计划
5. 将周报保存到 ~/Documents/周报/ 目录
6. 将摘要追加到今天的工作日志`,
        maxSteps: 20,
        timeoutMinutes: 10,
      },
      notify: { onComplete: true, onError: true, channels: ['cat-bubble', 'desktop'] },
      enabled: true,
    },
  },
  {
    id: 'desktop-cleanup',
    name: '桌面整理',
    description: '每周一整理桌面文件，按类型归类',
    icon: '🧹',
    template: {
      name: '桌面整理',
      description: '每周一自动整理桌面文件',
      schedule: { type: 'weekly', time: '09:00', weekDay: 1 },
      agentTask: {
        goal: `请帮我整理桌面文件：
1. 调用 list_files 扫描桌面目录
2. 分析文件类型（图片/文档/压缩包/代码等）
3. 制定分类计划（按文件类型创建子目录）
4. 将整理计划发送给用户确认（通过 show_notification）
5. 等待 30 秒后如果用户没有反对，开始执行
6. 使用 run_command 执行文件移动操作
7. 生成整理报告`,
        maxSteps: 15,
        timeoutMinutes: 10,
      },
      notify: { onComplete: true, onError: true, channels: ['desktop'] },
      enabled: true,
    },
  },
  {
    id: 'git-backup',
    name: '项目自动备份',
    description: '每天自动提交并推送 Git 项目变更',
    icon: '💾',
    template: {
      name: '项目自动备份',
      description: '每天自动备份 Git 项目',
      schedule: { type: 'daily', time: '23:00' },
      agentTask: {
        goal: `请帮我备份今天修改过的 Git 项目：
1. 扫描 ~/Projects 目录下的所有 Git 仓库
2. 对每个仓库检查是否有未提交的变更
3. 如果有变更，执行 git add -A 和 git commit -m "auto backup: YYYY-MM-DD"
4. 执行 git push
5. 生成备份报告（哪些仓库备份了，哪些跳过了）`,
        allowedTools: ['run_command', 'list_files'],
        maxSteps: 20,
        timeoutMinutes: 10,
      },
      notify: { onComplete: true, onError: true, channels: ['desktop'] },
      enabled: true,
    },
  },
  {
    id: 'break-reminder',
    name: '智能休息提醒',
    description: '监测连续工作时长，超时后通过小猫提醒休息（增强版）',
    icon: '☕',
    template: {
      name: '智能休息提醒',
      description: '连续工作超时后智能提醒休息',
      schedule: { type: 'interval', intervalMinutes: 30 },
      agentTask: {
        goal: `检查是否需要提醒用户休息：
1. 调用 get_today_log 查看今天的工作状态
2. 如果今天已经记录了长时间工作（eod_log 中有相关内容），跳过
3. 通过 show_notification 发送休息提醒
4. 提醒内容要有趣，结合当前时间和待办状态`,
        allowedTools: ['get_today_log', 'get_todos', 'show_notification'],
        maxSteps: 5,
        timeoutMinutes: 2,
      },
      notify: { onComplete: false, onError: false, channels: [] },
      enabled: true,
    },
  },
]
```

### 11.7 Agent Cron 前端 UI

```
┌─────────────────────────────────────────────────────────────────┐
│  🤖 Agent 定时任务                                    [+ 新建] │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─ 🌅 晨间计划整理 ─────────────────────────────────────────┐ │
│  │  每天 09:00  ·  上次: 今天 09:00  ✅  ·  下次: 明天 09:00 │ │
│  │  自动分析今日待办并生成工作计划                             │ │
│  │  [立即执行] [编辑] [停用]                                   │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                 │
│  ┌─ 🌆 晚间复盘 ─────────────────────────────────────────────┐ │
│  │  每天 18:00  ·  上次: 昨天 18:00  ✅  ·  下次: 今天 18:00 │ │
│  │  自动复盘今日工作并生成日志                                 │ │
│  │  [立即执行] [编辑] [停用]                                   │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                 │
│  ┌─ 📊 周报自动生成 ─────────────────────────────────────────┐ │
│  │  每周五 18:30  ·  上次: 上周五 18:30  ✅                  │ │
│  │  每周五自动生成本周工作总结                                 │ │
│  │  [立即执行] [编辑] [停用]                                   │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                 │
│  ┌─ ☕ 智能休息提醒 ─────────────────────────────────────────┐ │
│  │  每 30 分钟  ·  运行中 🟢                                  │ │
│  │  连续工作超时后智能提醒休息                                 │ │
│  │  [立即执行] [编辑] [停用]                                   │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                 │
├─────────────────────────────────────────────────────────────────┤
│  📋 模板库（点击添加）                                          │
│  🧹 桌面整理  ·  💾 项目备份  ·  📧 邮件检查  ·  🔍 代码审查   │
└─────────────────────────────────────────────────────────────────┘
```

### 11.8 与现有定时系统的对比

| 维度 | 现有 ScheduledTask | Agent Cron |
|------|-------------------|------------|
| 触发方式 | 固定时间 | 固定时间（复用） |
| 执行内容 | 固定 shell 命令 | Agent 自主规划执行 |
| 错误处理 | 记录日志，发通知 | Agent 自动重试 + 降级 |
| 上下文感知 | 无 | 感知待办/日志/时间/心情 |
| 结果汇报 | 命令行输出 | 自然语言摘要 + 小猫通知 |
| 条件判断 | 无 | 支持（如"有待办才执行"） |
| 可扩展性 | 只能改命令 | 改目标描述即可 |
| 迁移方式 | — | 一键迁移现有任务 |

### 11.9 融合后的完整定时架构

```
┌─────────────────────────────────────────────────────────────┐
│                    定时任务统一调度层                         │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐   │
│  │               Agent Cron Scheduler                    │   │
│  │  30 秒检查周期 · powerMonitor resume · 防重入        │   │
│  └──────────────────────┬───────────────────────────────┘   │
│                         │                                    │
│         ┌───────────────┼───────────────┐                   │
│         ▼               ▼               ▼                   │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐          │
│  │ 时间触发    │ │ 事件触发    │ │ 手动触发    │          │
│  │ daily/weekly│ │ resume/     │ │ 用户点击    │          │
│  │ /interval   │ │ wake        │ │ 立即执行    │          │
│  └──────┬──────┘ └──────┬──────┘ └──────┬──────┘          │
│         │               │               │                   │
│         └───────────────┼───────────────┘                   │
│                         ▼                                    │
│              ┌─────────────────────┐                        │
│              │  Agent Orchestrator │ ← 复用 Agent 引擎      │
│              │  (自主规划执行)     │                        │
│              └─────────┬───────────┘                        │
│                        │                                     │
│         ┌──────────────┼──────────────┐                    │
│         ▼              ▼              ▼                    │
│  ┌──────────┐   ┌──────────┐   ┌──────────┐             │
│  │ 文件操作 │   │ 命令执行 │   │ 数据操作 │             │
│  │ 工具     │   │ 工具     │   │ 工具     │             │
│  └──────────┘   └──────────┘   └──────────┘             │
│                        │                                     │
│                        ▼                                     │
│              ┌─────────────────────┐                        │
│              │  通知用户           │                        │
│              │  小猫气泡/系统通知  │                        │
│              └─────────────────────┘                        │
│                                                             │
│  ── 兼容层 ──                                               │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  现有 ScheduledTask  →  Agent Cron 一键迁移          │   │
│  │  现有 scheduler.ts   →  Agent Cron 兼容触发          │   │
│  │  现有 activity-monitor → Agent Cron 感知输入         │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

---

## 十二、总结

### 设计亮点

1. **复用现有基础设施**：不重写 LLM 调用、流式处理、IPC 通信，在现有代码上扩展
2. **主进程执行**：工具调用在主进程执行，复用 Electron 的文件系统和进程管理能力
3. **小猫人格一致**：Agent 的 System Prompt 延续"小小牛马"的角色设定
4. **渐进式增强**：Agent 是新增能力，不影响现有晨间/晚间/AI对话功能
5. **安全可控**：路径白名单 + 命令黑名单 + 工具安全分级
6. **Skill 系统**：6 个内置 Skills + 安装器（目录/zip/URL/市场）+ 市场发现 + 管理 UI，用户可扩展

### 核心数据流

```
用户输入 "帮我整理会议记录"
    ↓
AgentOrchestrator.run()
    ↓
构建上下文 (System Prompt + Tool Schema + History)
    ↓
LLM 请求 → 流式返回
    ↓
解析工具调用: list_files("~/Desktop", "*.md")
    ↓
ToolExecutor.execute("list_files", {...})
    ↓
返回结果 → 注入 History
    ↓
LLM 请求 (带工具结果)
    ↓
解析工具调用: read_file("~/Desktop/会议记录-0518.md")
    ↓
... 循环直到 LLM 返回纯文本 ...
    ↓
最终结果 → 推送给 UI
    ↓
小猫动画: busy → celebrate 🎉
```
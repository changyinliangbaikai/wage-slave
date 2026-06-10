/**
 * IPC 处理器注册
 * 所有 renderer → main 的请求在这里统一处理
 */

import { ipcMain, app, dialog, shell } from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import log from 'electron-log/main'
import { IPC } from '@shared/ipc-channels'
import {
  getConfig, setConfig,
  getLog, saveLog,
  getTodos, saveTodos,
  getLogsInRange, todayStr,
} from './store'
import { openSettingsWindow, showMainWindow, openLogWindow, openToolWindow, openAIChatWindow, getAIChatWindow, openAgentChatWindow, getAgentChatWindow, openSkillsWindow, getSkillsWindow, openAgentCronWindow } from './windows'
import { snoozeBreak, resetContinuousTime } from './activity-monitor'
import { parsePlan, generateSummary } from './llm-service'
import { startChat as startAIChat, abortChat as abortAIChat } from './ai-chat-service'
import { AgentOrchestrator } from './agent/orchestrator'
import { agentActivityStarted, agentActivityEnded } from './agent/active-tracker'
import {
  listAgentSessions,
  getAgentSession,
  saveAgentSession,
  deleteAgentSession,
  renameAgentSession,
  genAgentSessionId,
} from './agent/session-store'
import {
  getAllSkills,
  getSkillById,
  searchSkills,
  toggleSkill,
  updateSkillConfig,
  deleteUserSkill,
} from './agent/skills/store'
import { installFromFile, installFromUrl, installSkillObject, installFromZip } from './agent/skills/installer'
import { fetchMarketSkills, getMarketSkill } from './agent/skills/market'
import { AGENT_CRON_TEMPLATES } from './agent/cron/built-in-templates'
import {
  deleteAgentCron,
  listAgentCrons,
  runAgentCronNow,
  saveAgentCron,
  toggleAgentCron,
} from './agent/cron/scheduler'
import { migrateScheduledTasksToAgentCrons } from './agent/cron/migration'
import { AGENT_TOOL_GROUPS } from './agent/tool-registry'
import { getAllowedPaths, getDefaultAllowedPaths, DANGEROUS_RULES } from './agent/security'
import {
  listSessions as listChatSessions,
  getSession as getChatSession,
  saveSession as saveChatSession,
  deleteSession as deleteChatSession,
  renameSession as renameChatSession,
  searchSessions as searchChatSessions,
} from './ai-chat-store'
import { registerAIChatAttachmentHandlers } from './ai-chat-attachments'
import { registerChatIPC } from './ipc-handlers-chat'
import { exportSummaryDocx } from './docx-export'
import { getMainWindow } from './windows'
import type {
  AppConfig, DailyLog, TodoItem, AIChatRequest, AIChatSession,
  AgentSession, SkillConfig,
} from '@shared/types'

// ── 尝试加载 keytar（安全存储 API Key）──────────
let keytar: typeof import('keytar') | null = null
try {
  keytar = require('keytar')
} catch {
  console.warn('[IPC] keytar 未安装，API Key 将以明文存入 config.json（开发模式）')
}

const KEYTAR_SERVICE = 'xiao-niu-ma'
const KEYTAR_ACCOUNT = 'llm-api-key'

export function registerIPCHandlers(): void {

  // ── 配置 ──────────────────────────────────────
  ipcMain.handle(IPC.CONFIG_GET, () => getConfig())

  ipcMain.handle(IPC.CONFIG_SET, async (_e, config: Partial<AppConfig>) => {
    const updated = setConfig(config)
    if ('auto_launch' in config) {
      try {
        // 开发模式下 macOS 不允许未签名应用注册登录项，静默忽略
        if (app.isPackaged) {
          app.setLoginItemSettings({ openAtLogin: config.auto_launch ?? false })
        }
      } catch {
        console.warn('[IPC] 设置开机自启失败（开发模式下正常）')
      }
    }
    // 动态变更 AI 对话快捷键时重新注册
    if ('ai_chat_hotkey' in config) {
      try {
        const { registerAIChatHotkey } = await import('./index')
        registerAIChatHotkey()
      } catch (e) {
        console.warn('[IPC] 重注册 AI 对话快捷键失败:', e)
      }
    }
    return updated
  })

  ipcMain.handle(IPC.API_KEY_GET, async () => {
    if (keytar) {
      return await keytar.getPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT) ?? ''
    }
    // 降级：返回空字符串（明文 Key 暂不存储在 config 中）
    return ''
  })

  ipcMain.handle(IPC.API_KEY_SET, async (_e, key: string) => {
    if (keytar) {
      await keytar.setPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT, key)
    } else {
      console.warn('[IPC] API Key 以明文临时记录（请安装 keytar）')
    }
  })

  // 测试 API 连通性（用 chat/completions 发最小请求，兼容所有 OpenAI 格式服务商）
  ipcMain.handle(IPC.API_TEST, async (_e, { url, key, model }: { url: string; key: string; model: string }) => {
    try {
      const baseUrl = url.replace(/\/$/, '')
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${key}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 1,
        }),
        signal: AbortSignal.timeout(15000),
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        const brief = text.slice(0, 120)
        return { ok: false, error: `HTTP ${res.status}${brief ? ': ' + brief : ''}` }
      }
      return { ok: true, model }
    } catch (e: unknown) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  // ── 数据读写 ──────────────────────────────────
  ipcMain.handle(IPC.LOG_GET, (_e, date: string) => getLog(date ?? todayStr()))

  ipcMain.handle(IPC.LOG_SAVE, (_e, log: Partial<DailyLog> & { date: string }) => saveLog(log))

  ipcMain.handle(IPC.TODOS_GET, (_e, date: string) => getTodos(date ?? todayStr()))

  ipcMain.handle(IPC.TODOS_SAVE, (_e, { date, todos }: { date: string; todos: TodoItem[] }) => {
    saveTodos(date, todos)
    // 同步更新当日日志里的 todos 字段
    saveLog({ date, todos })
  })

  ipcMain.handle(IPC.LOGS_RANGE, (_e, { start, end }: { start: string; end: string }) =>
    getLogsInRange(start, end)
  )

  // ── 窗口行为 ──────────────────────────────────
  ipcMain.on(IPC.WINDOW_SHOW, () => showMainWindow())

  ipcMain.on(IPC.OPEN_SETTINGS, () => openSettingsWindow())

  ipcMain.on(IPC.OPEN_LOGS, () => openLogWindow())

  ipcMain.on(IPC.OPEN_TOOLS, () => openToolWindow())

  ipcMain.on(IPC.OPEN_AI_CHAT, () => openAIChatWindow())

  // ── AI 快速对话（流式）────────────────────────
  ipcMain.handle(IPC.AI_CHAT_START, async (_e, req: AIChatRequest) => {
    const apiKey = keytar
      ? (await keytar.getPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT) ?? '')
      : ''
    const win = getAIChatWindow()
    // 注意：不要 await 整个流式过程，直接 fire-and-forget 让调用方通过事件监听
    startAIChat(req, apiKey, {
      onChunk: (payload) => win?.webContents.send(IPC.AI_CHAT_CHUNK, payload),
      onDone:  (payload) => win?.webContents.send(IPC.AI_CHAT_DONE, payload),
      onError: (payload) => win?.webContents.send(IPC.AI_CHAT_ERROR, payload),
    }).catch(err => {
      console.error('[IPC] AI chat 未捕获异常:', err)
    })
    return { ok: true, requestId: req.requestId }
  })

  ipcMain.on(IPC.AI_CHAT_STOP, (_e, requestId: string) => {
    const aborted = abortAIChat(requestId)
    console.log(`[IPC] AI chat stop requestId=${requestId}, aborted=${aborted}`)
  })

  // ── AI 对话会话管理 ──────────────────────────
  ipcMain.handle(IPC.AI_CHAT_LIST_SESSIONS, () => listChatSessions())

  ipcMain.handle(IPC.AI_CHAT_GET_SESSION, (_e, id: string) => getChatSession(id))

  ipcMain.handle(IPC.AI_CHAT_SAVE_SESSION, (_e, session: AIChatSession) => saveChatSession(session))

  ipcMain.handle(IPC.AI_CHAT_DELETE_SESSION, (_e, id: string) => ({ ok: deleteChatSession(id) }))

  ipcMain.handle(IPC.AI_CHAT_RENAME_SESSION, (_e, { id, title }: { id: string; title: string }) =>
    ({ ok: renameChatSession(id, title) })
  )

  ipcMain.handle(IPC.AI_CHAT_SEARCH, (_e, query: string) => searchChatSessions(query))

  // ── AI 对话附件处理（选择 + 读取） ───────────
  registerAIChatAttachmentHandlers()

  // ── 休息提醒交互 ──────────────────────────────
  ipcMain.on(IPC.SNOOZE_BREAK, (_e, minutes: number) => snoozeBreak(minutes))
  ipcMain.on(IPC.BREAK_DONE, () => resetContinuousTime())

  ipcMain.on('renderer:break-done', () => resetContinuousTime())

  // ── LLM 调用（在主进程执行，绕过 CORS）───────
  ipcMain.handle(IPC.LLM_PARSE_PLAN, async (_e, input: string) => {
    const apiKey = keytar
      ? (await keytar.getPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT) ?? '')
      : ''
    return parsePlan(input, apiKey)
  })

  ipcMain.handle(IPC.LLM_SUMMARY, async (_e, { logs, periodLabel }: { logs: DailyLog[]; periodLabel: string }) => {
    const apiKey = keytar
      ? (await keytar.getPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT) ?? '')
      : ''
    const win = getMainWindow()
    const result = await generateSummary(logs, periodLabel, apiKey, (accumulated) => {
      // 流式推送到渲染进程
      win?.webContents.send(IPC.LLM_SUMMARY_STREAM, accumulated)
    })
    return result
  })

  // ── 目录选择器 ──────────────────────────────
  ipcMain.handle(IPC.SELECT_DIRECTORY, async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      title: '选择工作总结导出目录',
    })
    if (result.canceled || result.filePaths.length === 0) return ''
    return result.filePaths[0]
  })

  // ── 导出总结为 Word ──────────────────────────
  ipcMain.handle(IPC.EXPORT_SUMMARY_DOCX, async (_e, { text, periodLabel }: { text: string; periodLabel: string }) => {
    try {
      const config = getConfig()
      if (!config.summary_export_dir) {
        return { ok: false, error: '未设置导出目录，请在设置中配置' }
      }
      const filePath = await exportSummaryDocx(text, periodLabel, config.summary_export_dir)
      return { ok: true, filePath }
    } catch (e: unknown) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  // ── 小工具：打开文件选择对话框 ──────────────
  ipcMain.handle(IPC.TOOLS_OPEN_FILE_DIALOG, async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [
        { name: '文本文件', extensions: ['txt', 'md', 'docx', 'doc'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    })
    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false, canceled: true }
    }
    return { ok: true, filePath: result.filePaths[0] }
  })

  // ── 小工具：读取文件 ─────────────────────────
  ipcMain.handle(IPC.TOOLS_READ_FILE, async (_e, filePath: string) => {
    try {
      const { readFileContent } = await import('./tools/spell-check')
      const result = await readFileContent(filePath)
      return { ok: true, ...result }
    } catch (e: unknown) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  // ── 小工具：错别字检查 ───────────────────────
  // 当前活跃的 AbortController，供"取消检查" IPC 调用
  let spellCheckCtrl: AbortController | null = null

  ipcMain.handle(IPC.TOOLS_SPELL_CHECK, async (event, { text, stream }: { text: string; stream?: boolean }) => {
    try {
      const { spellCheck } = await import('./tools/spell-check')
      // 用调用方所在的窗口推送流式增量，避免 getMainWindow 在 toolsWindow 场景下错位
      const senderWin = event.sender
      // 如果上一次还没结束，先打断
      spellCheckCtrl?.abort()
      spellCheckCtrl = new AbortController()
      const ctrl = spellCheckCtrl

      try {
        if (stream) {
          return await spellCheck(text, (payload) => {
            try {
              if (!senderWin.isDestroyed()) {
                // 推送结构化进度，渲染端可分别展示"思考中 / 接收中"两个阶段
                senderWin.send(IPC.TOOLS_SPELL_CHECK_CHUNK, payload)
              }
            } catch { /* 渲染端已销毁则忽略 */ }
          }, ctrl.signal)
        } else {
          return await spellCheck(text, undefined, ctrl.signal)
        }
      } finally {
        if (spellCheckCtrl === ctrl) spellCheckCtrl = null
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error('[IPC] 错别字检查失败:', msg)
      return { errors: [], error: msg }
    }
  })

  // 取消错别字检查
  ipcMain.handle(IPC.TOOLS_SPELL_CHECK_CANCEL, () => {
    if (spellCheckCtrl) {
      console.log('[IPC] 用户主动取消错别字检查')
      spellCheckCtrl.abort()
      return { ok: true }
    }
    return { ok: false }
  })

  // 打开应用运行日志所在文件夹（便于排查"卡在检查中..."等问题）
  ipcMain.handle(IPC.OPEN_LOG_FILE, async () => {
    try {
      const logPath = log.transports.file.getFile().path
      const logDir = path.dirname(logPath)
      const fileExists = fs.existsSync(logPath)
      const dirExists = fs.existsSync(logDir)
      console.log(
        `[IPC] 打开日志请求 | logPath=${logPath} | fileExists=${fileExists} | dirExists=${dirExists}`,
      )

      // 优先在文件管理器中高亮 main.log；不存在则直接打开日志目录
      if (fileExists) {
        shell.showItemInFolder(logPath)
        return { ok: true, path: logPath }
      }
      if (dirExists) {
        const err = await shell.openPath(logDir)
        if (err) {
          console.error('[IPC] shell.openPath 失败:', err)
          return { ok: false, error: err }
        }
        return { ok: true, path: logDir, hint: '日志文件尚未生成，已打开日志目录' }
      }
      // 极端情况：连目录都没有，回退到 userData
      const userData = app.getPath('userData')
      console.warn('[IPC] 日志目录不存在，回退打开 userData:', userData)
      const err = await shell.openPath(userData)
      if (err) return { ok: false, error: err }
      return { ok: true, path: userData, hint: '日志目录不存在，已打开 userData' }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error('[IPC] 打开日志文件失败:', msg)
      return { ok: false, error: msg }
    }
  })

  // ── 定时任务 ──────────────────────────────────
  ipcMain.handle(IPC.SCHEDULER_LIST_TASKS, async () => {
    const { listTasks } = await import('./tools/task-scheduler')
    return listTasks()
  })

  ipcMain.handle(IPC.SCHEDULER_SAVE_TASK, async (_e, task) => {
    const { saveTask } = await import('./tools/task-scheduler')
    return saveTask(task)
  })

  ipcMain.handle(IPC.SCHEDULER_DELETE_TASK, async (_e, taskId: string) => {
    const { deleteTask } = await import('./tools/task-scheduler')
    return deleteTask(taskId)
  })

  ipcMain.handle(IPC.SCHEDULER_TOGGLE_TASK, async (_e, taskId: string) => {
    const { toggleTask } = await import('./tools/task-scheduler')
    return toggleTask(taskId)
  })

  ipcMain.handle(IPC.SCHEDULER_RUN_TASK, async (_e, taskId: string) => {
    const { runTask } = await import('./tools/task-scheduler')
    try {
      return { ok: true, execution: runTask(taskId) }
    } catch (e: unknown) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  // 中止单个执行（Agent / shell 通用）
  ipcMain.handle(IPC.SCHEDULER_STOP_TASK, async (_e, executionId: string) => {
    const { stopRunningTask } = await import('./tools/task-scheduler')
    const ok = stopRunningTask(executionId)
    return { ok }
  })

  // 查询当前正在运行的执行列表
  ipcMain.handle(IPC.SCHEDULER_RUNNING, async () => {
    const { listRunningExecutions } = await import('./tools/task-scheduler')
    return listRunningExecutions()
  })

  // 自然语言 → ScheduledTask（依赖已配置的 LLM API Key）
  ipcMain.handle(IPC.SCHEDULER_PARSE_NL, async (_e, naturalText: string) => {
    try {
      if (!naturalText || typeof naturalText !== 'string') {
        return { ok: false, error: '输入文本为空' }
      }
      const { parseNaturalLanguageToTask } = await import('./tools/task-nl-parser')
      const task = await parseNaturalLanguageToTask(naturalText.trim())
      console.log('[IPC] 自然语言解析任务成功:', task.name, task.kind ?? 'shell')
      return { ok: true, task }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error('[IPC] 自然语言解析失败:', msg)
      return { ok: false, error: msg }
    }
  })

  ipcMain.handle(IPC.SCHEDULER_GET_LOGS, async (_e, taskId: string) => {
    const { getTaskLogs } = await import('./tools/task-scheduler')
    return getTaskLogs(taskId)
  })

  ipcMain.handle(IPC.SCHEDULER_CLEAR_LOGS, async (_e, taskId: string) => {
    const { clearTaskLogs } = await import('./tools/task-scheduler')
    clearTaskLogs(taskId)
    return { ok: true }
  })

  ipcMain.handle(IPC.SCHEDULER_SELECT_DIR, async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      title: '选择任务工作目录',
    })
    if (result.canceled || result.filePaths.length === 0) return ''
    return result.filePaths[0]
  })

  // ── Agent 模式（Phase 1） ─────────────────────
  registerAgentIPC()

  // ── 统一对话系统（AI 对话 + Agent 合并） ───────
  registerChatIPC()

  // ── Agent Skill 系统（Phase 2） ───────────────
  registerSkillIPC()

  // ── Agent Cron（Phase 3 独立入口）─────────────
  registerAgentCronIPC()
}

/**
 * 注册 Agent 相关 IPC
 * 拆出独立函数避免 registerIPCHandlers 体积膨胀
 */
function registerAgentIPC(): void {
  // 活跃 Agent 实例表（多会话并发）
  const activeAgents = new Map<string, AgentOrchestrator>()

  /** 取出 API Key（异步） */
  const getApiKey = async (): Promise<string> => {
    if (keytar) {
      return (await keytar.getPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT)) ?? ''
    }
    return ''
  }

  /** 把推送广播给 Agent 窗口 + 调用方窗口（防止用户已关闭窗口导致 sender 失效） */
  const broadcast = (channel: string, payload: unknown): void => {
    const win = getAgentChatWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel, payload)
    }
  }

  // 打开 Agent 对话窗口
  ipcMain.on(IPC.AGENT_OPEN_WINDOW, () => openAgentChatWindow())

  // 启动一次 Agent 任务
  ipcMain.handle(IPC.AGENT_START, async (_e, params: { sessionId?: string; userInput: string }) => {
    const { sessionId: providedId, userInput } = params
    const sessionId = providedId ?? genAgentSessionId()

    if (!userInput || !userInput.trim()) {
      return { ok: false, error: '输入不能为空' }
    }

    // 如果同会话已有活跃 Agent，先中止
    const existing = activeAgents.get(sessionId)
    if (existing) {
      existing.abort()
    }

    const apiKey = await getApiKey()
    const agent = new AgentOrchestrator(sessionId)
    activeAgents.set(sessionId, agent)

    // 加载历史（继续会话场景）：仅在显式传 sessionId 时加载
    let history: AgentSession['messages'] = []
    if (providedId) {
      const session = getAgentSession(providedId)
      if (session) history = session.messages
    }

    // 标记 Agent 进入活跃态（小猫切 busy 动画的源头）
    agentActivityStarted('chat')
    // fire-and-forget 异步执行；事件通过回调推给 UI
    agent.run({
      userInput,
      apiKey,
      history,
      callbacks: {
        onChunk: (p) => broadcast(IPC.AGENT_CHUNK, p),
        onDone: (p) => {
          broadcast(IPC.AGENT_DONE, p)
          activeAgents.delete(sessionId)
        },
        onError: (p) => {
          broadcast(IPC.AGENT_ERROR, p)
          if (p.fatal) activeAgents.delete(sessionId)
        },
        onToolStart: (p) => broadcast(IPC.AGENT_TOOL_START, p),
        onToolExecuting: (p) => broadcast(IPC.AGENT_TOOL_EXECUTING, p),
        onToolExecuted: (p) => broadcast(IPC.AGENT_TOOL_EXECUTED, p),
      },
    }).catch(err => {
      log.error('[IPC] Agent 未捕获异常:', err)
      broadcast(IPC.AGENT_ERROR, {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
        fatal: true,
      })
      activeAgents.delete(sessionId)
    }).finally(() => {
      // 无论成功/失败/中断，都要把活跃计数减回去，触发小猫回 idle
      agentActivityEnded('chat')
    })

    return { ok: true, sessionId }
  })

  // 中止 Agent
  ipcMain.handle(IPC.AGENT_STOP, (_e, params: { sessionId: string }) => {
    const agent = activeAgents.get(params.sessionId)
    if (!agent) return { ok: false, error: '无活跃 Agent' }
    agent.abort()
    return { ok: true }
  })

  // 查询当前是否在执行
  ipcMain.handle(IPC.AGENT_STATUS, (_e, params: { sessionId: string }) => {
    return { running: activeAgents.has(params.sessionId) }
  })

  // 会话管理
  ipcMain.handle(IPC.AGENT_LIST_SESSIONS, () => listAgentSessions())
  ipcMain.handle(IPC.AGENT_GET_SESSION, (_e, id: string) => getAgentSession(id))
  ipcMain.handle(IPC.AGENT_DELETE_SESSION, (_e, id: string) => ({ ok: deleteAgentSession(id) }))
  ipcMain.handle(IPC.AGENT_RENAME_SESSION, (_e, params: { id: string; title: string }) => {
    return { ok: renameAgentSession(params.id, params.title) }
  })
  // SAVE_SESSION 暂时主要由 Orchestrator 内部完成；前端如需手动保存（标题等）也可用此通道
  ipcMain.handle(IPC.AGENT_SAVE_SESSION, (_e, session: AgentSession) => saveAgentSession(session))
}

/**
 * 注册 Skill 相关 IPC（Phase 2）
 * 覆盖：列表/查询/搜索/启停/安装(本地·URL·市场)/卸载/市场列表/打开窗口
 */
function registerSkillIPC(): void {
  // skill 状态变化后通知技能窗口刷新
  const notifyChanged = (): void => {
    const win = getSkillsWindow()
    if (win && !win.isDestroyed()) win.webContents.send(IPC.SKILL_CHANGED)
  }

  // 打开技能管理窗口
  ipcMain.on(IPC.SKILL_OPEN_WINDOW, () => openSkillsWindow())

  // ── Agent 工具权限（D.1） ───────────────────────
  ipcMain.handle(IPC.AGENT_GET_TOOL_GROUPS, () => {
    return AGENT_TOOL_GROUPS
  })

  // ── Agent 安全策略（D.3） ───────────────────────
  ipcMain.handle(IPC.AGENT_GET_SECURITY_POLICY, () => {
    const allowedPaths = getAllowedPaths()
    const defaultAllowedPaths = getDefaultAllowedPaths()
    const customAllowedPaths = getConfig().agent_allowed_paths_extra ?? []
    // 提取命令黑名单的正则描述（转换为字符串用于展示）
    const commandBlacklist = DANGEROUS_RULES.map((rule) => ({
      pattern: rule.pattern.toString(),
      reason: rule.reason,
    }))
    return { allowedPaths, defaultAllowedPaths, customAllowedPaths, commandBlacklist }
  })

  // 查询类
  ipcMain.handle(IPC.SKILL_LIST, () => getAllSkills())
  ipcMain.handle(IPC.SKILL_GET, (_e, id: string) => getSkillById(id))
  ipcMain.handle(IPC.SKILL_SEARCH, (_e, query: string) => searchSkills(query))

  // 启停
  ipcMain.handle(IPC.SKILL_TOGGLE, (_e, params: { id: string; enabled?: boolean }) => {
    const result = toggleSkill(params.id, params.enabled)
    notifyChanged()
    return result
  })

  ipcMain.handle(IPC.SKILL_UPDATE_CONFIG, (_e, params: { id: string; config: SkillConfig }) => {
    try {
      const result = updateSkillConfig(params.id, params.config)
      notifyChanged()
      return { ok: Boolean(result), skill: result ?? undefined }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      log.warn('[IPC] 保存 skill 配置失败:', msg)
      return { ok: false, error: msg }
    }
  })

  // 从本地文件安装（支持 skill.json、包含 skill.json 的目录、zip 包）
  ipcMain.handle(IPC.SKILL_INSTALL_FILE, async () => {
    const result = await dialog.showOpenDialog({
      title: '选择 skill.json、Skill 目录或 zip 包',
      properties: ['openFile', 'openDirectory'],
      filters: [{ name: 'Skill', extensions: ['json', 'zip'] }],
    })
    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false, canceled: true }
    }
    try {
      const selected = result.filePaths[0]
      const skill = path.extname(selected).toLowerCase() === '.zip'
        ? await installFromZip(selected)
        : installFromFile(selected)
      notifyChanged()
      log.info('[IPC] 已安装本地 skill:', skill.id)
      return { ok: true, skill }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      log.warn('[IPC] 安装本地 skill 失败:', msg)
      return { ok: false, error: msg }
    }
  })

  // 从远程 URL 安装
  ipcMain.handle(IPC.SKILL_INSTALL_URL, async (_e, url: string) => {
    try {
      const skill = await installFromUrl(url)
      notifyChanged()
      log.info('[IPC] 已从 URL 安装 skill:', skill.id)
      return { ok: true, skill }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      log.warn('[IPC] URL 安装 skill 失败:', msg)
      return { ok: false, error: msg }
    }
  })

  // 从市场一键安装
  ipcMain.handle(IPC.SKILL_INSTALL_MARKET, async (_e, id: string) => {
    try {
      const item = await getMarketSkill(id)
      if (!item) return { ok: false, error: '市场中未找到该技能' }
      const skill = item.downloadUrl
        ? await installFromUrl(item.downloadUrl)
        : installSkillObject(item, 'remote')
      notifyChanged()
      log.info('[IPC] 已从市场安装 skill:', skill.id)
      return { ok: true, skill }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      log.warn('[IPC] 市场安装 skill 失败:', msg)
      return { ok: false, error: msg }
    }
  })

  // 卸载（内置只停用）
  ipcMain.handle(IPC.SKILL_UNINSTALL, (_e, id: string) => {
    const ok = deleteUserSkill(id)
    notifyChanged()
    return { ok }
  })

  // 拉取市场列表（远程不可用时回退本地精选）
  ipcMain.handle(IPC.SKILL_MARKET_LIST, async () => {
    try {
      const skills = await fetchMarketSkills()
      return { ok: true, skills }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { ok: false, error: msg, skills: [] }
    }
  })
}

function registerAgentCronIPC(): void {
  ipcMain.on(IPC.AGENT_CRON_OPEN_WINDOW, () => openAgentCronWindow())
  ipcMain.handle(IPC.AGENT_CRON_LIST, () => listAgentCrons())
  ipcMain.handle(IPC.AGENT_CRON_TEMPLATES, () => AGENT_CRON_TEMPLATES)
  ipcMain.handle(IPC.AGENT_CRON_SAVE, (_e, cron) => {
    try {
      return { ok: true, cron: saveAgentCron(cron) }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })
  ipcMain.handle(IPC.AGENT_CRON_DELETE, (_e, id: string) => ({ ok: deleteAgentCron(id) }))
  ipcMain.handle(IPC.AGENT_CRON_TOGGLE, (_e, id: string) => {
    const cron = toggleAgentCron(id)
    return cron ? { ok: true, cron } : { ok: false, error: '任务不存在' }
  })
  ipcMain.handle(IPC.AGENT_CRON_RUN_NOW, (_e, id: string) => {
    try {
      return { ok: true, execution: runAgentCronNow(id) }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })
  ipcMain.handle(IPC.AGENT_CRON_MIGRATE, (_e, params?: { taskIds?: string[]; disableOriginal?: boolean }) => {
    try {
      return { ok: true, ...migrateScheduledTasksToAgentCrons(params) }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })
}

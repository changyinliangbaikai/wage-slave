# 小小牛马 - 代码架构文档

## 项目概述

**项目名称**：小小牛马（xiao-niu-ma）  
**项目描述**：桌面像素猫助手 - 工作日志与AI对话工具  
**技术栈**：Electron + React + TypeScript  
**构建工具**：electron-vite  
**版本**：2.1.0

---

## 目录结构

```
xiao-niu-ma/
├── src/
│   ├── main/           # 主进程代码
│   ├── preload/        # 预加载脚本
│   ├── renderer/       # 渲染进程代码
│   └── shared/         # 共享类型定义
├── assets/             # 资源文件（图标、像素猫精灵图）
├── docs/               # 文档
└── electron.vite.config.ts  # Electron + Vite 构建配置
```

---

## 架构分层

### 1. 主进程层（Main Process）

主进程负责 Electron 应用的核心功能，包括窗口管理、系统托盘、数据存储、IPC 通信等。

#### 核心模块

| 模块 | 文件 | 职责 |
|------|------|------|
| **入口** | `index.ts` | 应用启动、生命周期管理、全局异常处理、单实例锁定 |
| **窗口管理** | `windows.ts` | 创建和管理所有窗口（主窗口、设置、日志、工具、AI对话） |
| **系统托盘** | `tray.ts` | 系统托盘图标和右键菜单 |
| **数据存储** | `store.ts` | 本地数据读写（配置、日志、待办、状态） |
| **IPC 处理** | `ipc-handlers.ts` | 注册所有 IPC 处理器，协调主进程与渲染进程通信 |
| **定时触发** | `scheduler.ts` | 晨间/晚间定时触发器（上下班时间检测） |
| **活跃监测** | `activity-monitor.ts` | 键鼠活跃监测（休息提醒） |
| **LLM 服务** | `llm-service.ts` | LLM API 调用（计划解析、总结生成） |
| **AI 对话** | `ai-chat-service.ts` | AI 快速对话流式服务 |
| **AI 存储** | `ai-chat-store.ts` | AI 对话会话持久化 |
| **AI 附件** | `ai-chat-attachments.ts` | AI 对话附件处理（文件读取） |
| **自动更新** | `auto-updater.ts` | 基于 electron-updater 的自动更新 |
| **备份恢复** | `backup.ts` | 数据备份与恢复（导出/导入 zip） |
| **Word 导出** | `docx-export.ts` | 工作总结导出为 Word 文档 |
| **桌宠包仓库** | `pet-pack-store.ts` | 注册 `pet://` 协议；扫描/安装/删除桌宠包；广播激活变化 |

#### Agent 模块（agent/）

| 模块 | 文件 | 职责 |
|------|------|------|
| **编排器** | `agent/orchestrator.ts` | 多轮 Agent 循环、工具结果回灌、中断和会话持久化 |
| **LLM Tool Client** | `agent/llm-tool-client.ts` | 流式请求、tool_calls 增量累积、ReAct 文本协议降级 |
| **工具注册表** | `agent/tool-registry.ts` | OpenAI tools schema、工具分组、工具开关过滤 |
| **工具执行器** | `agent/tool-executor.ts` | 文件、命令、日志待办、定时任务、通知等工具分发 |
| **安全护栏** | `agent/security.ts` | 路径白名单、命令黑名单、命令执行二次确认 |
| **审计日志** | `agent/audit-log.ts` | 记录写入类工具的审计摘要 |
| **System Prompt** | `agent/system-prompt.ts` | 注入 OS、时间、待办、日志状态与 Skill 引导 |
| **上下文压缩** | `agent/context-compressor.ts` | 折叠过长历史和工具输出，防止超上下文 |
| **会话存储** | `agent/session-store.ts` | Agent 会话 list/get/save/delete/rename |
| **活跃状态** | `agent/active-tracker.ts` | 广播 Agent 活跃计数，驱动小猫 busy 动画 |
| **Skill 系统** | `agent/skills/` | `types.ts` 类型入口，内置 Skill、安装、启停、配置、匹配、市场索引 |
| **Agent Cron** | `agent/cron/` | 独立 JSON 存储、30 秒调度、休眠唤醒、幂等一键迁移和内置模板 |

#### 工具模块（tools/）

| 模块 | 文件 | 职责 |
|------|------|------|
| **工具入口** | `index.ts` | 工具模块 IPC 路由 |
| **错别字检查** | `spell-check.ts` | 文本错别字检查（流式） |
| **定时任务** | `task-scheduler.ts` | 普通定时任务调度引擎，保留 shell 与历史 Agent 任务体兼容 |

---

### 2. 预加载层（Preload）

预加载脚本在隔离的上下文中运行，通过 `contextBridge` 暴露安全的 IPC API 给渲染进程。

| 文件 | 职责 |
|------|------|
| `index.ts` | 暴露 `electronAPI` 对象（invoke、send、on） |

---

### 3. 渲染进程层（Renderer Process）

渲染进程负责用户界面和交互逻辑，使用 React 构建。

#### 核心文件

| 文件 | 职责 |
|------|------|
| `main.tsx` | 渲染进程入口，根据 URL hash 路由到不同页面 |
| `App.tsx` | 主窗口根组件（像素猫 + 气泡 + 流程管理） |
| `App.css` | 主窗口样式 |

#### 页面组件（pages/）

| 页面 | 文件 | 职责 |
|------|------|------|
| **设置** | `Settings.tsx` | 应用配置页面（工作时间、LLM 配置、快捷键等） |
| **日志查看** | `LogViewer.tsx` | 工作日志历史查看 |
| **小工具** | `ToolsPage.tsx` | 小工具入口页面 |
| **AI 对话** | `AIChat.tsx` | AI 快速对话窗口 |
| **Agent 对话** | `AgentChat.tsx` | Agent 独立对话窗口，展示流式回复与工具调用卡片 |
| **技能中心** | `SkillsPage.tsx` | Skill 搜索、启停、配置、卸载、文件/zip/URL 安装与市场浏览 |
| **Agent Cron** | `agent/AgentCronPage.tsx` | Agent Cron 管理页，支持模板、编辑、立即执行，以及保留或停用原任务的迁移 |
| **晨间流程** | `MorningFlow.tsx` | 晨间计划录入流程 |
| **休息提醒** | `BreakReminder.tsx` | 休息提醒界面 |
| **晚间流程** | `EveningFlow.tsx` | 晚间复盘流程 |
| **总结流程** | `SummaryFlow.tsx` | 工作总结生成流程 |

#### AI 对话子模块（ai-chat/）

| 文件 | 职责 |
|------|------|
| `personas.ts` | AI 对话预置角色定义 |
| `slash-commands.ts` | AI 对话斜杠命令 |

#### Agent 子模块（agent/）

| 文件 | 职责 |
|------|------|
| `AgentInput.tsx` | Agent 多行输入框与停止按钮 |
| `ToolCallCard.tsx` | 工具调用状态卡片 |
| `AgentSettings.tsx` | Agent 模型、工具权限、路径白名单编辑和安全策略设置 |
| `SkillManager.tsx` | 已安装 Skill 搜索、启停、配置、卸载、文件/zip/URL 安装 |
| `SkillMarket.tsx` | Skill 市场搜索、分类筛选、详情查看与安装 |
| `AgentCronPage.tsx` | Agent Cron 列表、模板、编辑、立即执行，以及保留或停用原任务的迁移 |

#### 组件（components/）

| 组件 | 路径 | 职责 |
|------|------|------|
| **像素猫** | `PixelCat/` | 桌宠渲染入口（对 `pet-engine` 的薄封装，保持历史 API 不变） |
| **气泡** | `SpeechBubble/` | 对话气泡 |
| **状态气泡** | `StatusBubble/` | 陪伴性状态气泡 |
| **桌宠外观** | `PetAppearance/` | 设置页桌宠管理面板（列表/激活/上传 sprite/AI 提示词卡片） |
| **右键菜单** | `ContextMenu.tsx` | 右键上下文菜单 |
| **错误边界** | `ErrorBoundary.tsx` | React 错误边界 |
| **工具面板** | `Tools/` | 小工具组件集合 |
| - | `Tools/ToolsPanel.tsx` | 工具面板容器 |
| - | `Tools/ToolCard.tsx` | 单个工具卡片 |
| - | `Tools/Scheduler/` | 定时任务工具 |
| - | `Tools/SpellCheck/` | 错别字检查工具 |

#### 自定义 Hooks（hooks/）

| Hook | 文件 | 职责 |
|------|------|------|
| **IPC 封装** | `useIPC.ts` | 封装 IPC 调用（配置、数据、窗口操作） |
| **心情系统** | `useCatMood.ts` | 像素猫心情/饥饿度系统 |
| **LLM 封装** | `useLLM.ts` | LLM 调用封装 |
| **Agent 封装** | `useAgent.ts` | Agent 会话、流式事件、工具调用状态管理 |
| **Skill 封装** | `useSkills.ts` | Skill 列表、搜索、安装、市场和变更事件管理 |

#### 桌宠渲染引擎（pet-engine/）

数据驱动的渲染引擎，把硬编码的 sprite 切片逻辑抽离出来，让桌宠可以通过 `manifest.json` 自由替换。详见 `docs/pet-pack-spec.md`。

| 文件 | 职责 |
|------|------|
| `types.ts` | 类型定义；`PET_CORE_STATES = ['idle','petting','celebrate','busy']` |
| `manifest.ts` | manifest 校验与 normalize；缺失动画按 `fallback` 回填 |
| `loader.ts` | 通过 IPC 拉取激活包；预加载所有图片资源 |
| `animator.ts` | 数据驱动的动画状态机（`PetAnimator` 类） |
| `PetRenderer.tsx` | React 组件，按动画 type 分别用 `background-position` / `<img>` 渲染 |
| `index.ts` | 对外 API：`PetRenderer`, `PetAnimator`, `loadActivePet()`, `CORE_STATES` |

---

### 4. 共享层（Shared）

共享层包含主进程和渲染进程共用的类型定义和常量。

| 文件 | 职责 |
|------|------|
| `types.ts` | TypeScript 类型定义（待办、日志、配置、AI 对话等） |
| `ipc-channels.ts` | IPC 通道名称常量 |

---

## 核心业务流程

### 1. 应用启动流程

```
index.ts (主进程入口)
  ↓
初始化日志系统
  ↓
注册全局异常处理
  ↓
检查单实例锁定
  ↓
app.whenReady()
  ↓
注册 IPC 处理器 (registerIPCHandlers)
  ↓
注册备份 IPC (registerBackupIPC)
  ↓
创建主窗口 (createMainWindow)
  ↓
创建系统托盘 (createTray)
  ↓
启动定时触发器 (startScheduler)
  ↓
启动活跃监测 (startActivityMonitor)
  ↓
启动定时任务调度 (startTaskScheduler)
  ↓
注册 AI 对话快捷键 (registerAIChatHotkey)
  ↓
初始化自动更新 (initAutoUpdater)
```

### 2. 晨间计划流程

```
scheduler.ts 检测到上班时间
  ↓
通过 IPC 发送 TRIGGER_MORNING 事件
  ↓
App.tsx 接收事件 (useOnMorningTrigger)
  ↓
显示 MorningFlow 组件
  ↓
用户输入工作计划
  ↓
调用 LLM 解析 (LLM_PARSE_PLAN)
  ↓
llm-service.ts 调用 API 解析为 TodoItem[]
  ↓
保存待办 (TODOS_SAVE)
  ↓
关闭流程，更新心情
```

### 3. 休息提醒流程

```
activity-monitor.ts 监测键鼠活跃
  ↓
连续工作超过阈值
  ↓
通过 IPC 发送 TRIGGER_BREAK 事件
  ↓
App.tsx 接收事件 (useOnBreakTrigger)
  ↓
显示 BreakReminder 组件
  ↓
用户选择"去休息"或"再等一会儿"
  ↓
调用 IPC (BREAK_DONE / SNOOZE_BREAK)
  ↓
重置或延迟计时器
```

### 4. 晚间复盘流程

```
scheduler.ts 检测到下班时间
  ↓
通过 IPC 发送 TRIGGER_EVENING 事件
  ↓
App.tsx 接收事件 (useOnEveningTrigger)
  ↓
显示 EveningFlow 组件
  ↓
加载当日待办
  ↓
用户标记完成情况 + 录入工作日志
  ↓
保存日志 (LOG_SAVE)
  ↓
关闭流程，根据完成率更新心情
```

### 5. AI 对话流程

```
用户打开 AI 对话窗口 (openAIChatWindow)
  ↓
AIChat.tsx 渲染
  ↓
用户输入消息
  ↓
通过 IPC 发送 AI_CHAT_START
  ↓
ai-chat-service.ts 发起流式请求
  ↓
调用 OpenAI 兼容 API（SSE）
  ↓
流式推送 AI_CHAT_CHUNK 事件
  ↓
渲染进程实时显示
  ↓
请求完成，发送 AI_CHAT_DONE 事件
  ↓
保存会话 (AI_CHAT_SAVE_SESSION)
```

### 6. 工作总结生成流程

```
用户触发总结流程（手动或月末）
  ↓
显示 SummaryFlow 组件
  ↓
选择时间范围
  ↓
调用 IPC (LOGS_RANGE) 获取日志
  ↓
调用 LLM_SUMMARY_STREAM
  ↓
llm-service.ts 流式生成总结
  ↓
实时显示生成内容
  ↓
完成后可选择导出 Word
  ↓
调用 EXPORT_SUMMARY_DOCX
  ↓
docx-export.ts 生成 Word 文档
```

---

## IPC 通信架构

### IPC 通道分类

#### 主进程 → 渲染进程（单向推送）

| 通道 | 用途 |
|------|------|
| `TRIGGER_MORNING` | 晨间计划触发 |
| `TRIGGER_BREAK` | 休息提醒触发 |
| `TRIGGER_EVENING` | 晚间复盘触发 |
| `TRIGGER_SUMMARY` | 总结提示触发 |
| `CAT_STATE_CHANGE` | 猫咪状态变化 |
| `LLM_SUMMARY_STREAM` | 总结流式推送 |
| `AI_CHAT_CHUNK` | AI 对话流式推送 |
| `AI_CHAT_DONE` | AI 对话完成 |
| `AI_CHAT_ERROR` | AI 对话错误 |
| `AI_CHAT_FOCUS_INPUT` | 聚焦输入框 |
| `TOOLS_SPELL_CHECK_CHUNK` | 错别字检查流式推送 |
| `UPDATE_STATUS` | 更新状态推送 |

#### 渲染进程 → 主进程（双向调用）

| 通道分类 | 通道示例 |
|----------|----------|
| **配置** | `CONFIG_GET`, `CONFIG_SET`, `API_KEY_GET`, `API_KEY_SET`, `API_TEST` |
| **数据读写** | `LOG_GET`, `LOG_SAVE`, `TODOS_GET`, `TODOS_SAVE`, `LOGS_RANGE` |
| **LLM 调用** | `LLM_PARSE_PLAN`, `LLM_SUMMARY` |
| **导出** | `EXPORT_SUMMARY_DOCX`, `SELECT_DIRECTORY` |
| **小工具** | `TOOLS_OPEN_FILE_DIALOG`, `TOOLS_READ_FILE`, `TOOLS_SPELL_CHECK` |
| **定时任务** | `SCHEDULER_LIST_TASKS`, `SCHEDULER_SAVE_TASK`, `SCHEDULER_DELETE_TASK` 等 |
| **AI 对话** | `AI_CHAT_START`, `AI_CHAT_STOP`, `AI_CHAT_LIST_SESSIONS` 等 |
| **窗口行为** | `WINDOW_DRAG`, `WINDOW_HIDE_EDGE`, `WINDOW_SHOW` |
| **系统** | `AUTO_LAUNCH_SET`, `SNOOZE_BREAK`, `BREAK_DONE`, `OPEN_SETTINGS` 等 |
| **自动更新** | `UPDATE_CHECK`, `UPDATE_DOWNLOAD`, `UPDATE_INSTALL` |
| **备份恢复** | `BACKUP_EXPORT`, `BACKUP_IMPORT`, `BACKUP_OPEN_DATA_DIR`, `REPORT_SAVE` |
| **桌宠包** | `PETS_LIST`, `PETS_GET_ACTIVE`, `PETS_ACTIVATE`, `PETS_INSTALL_SPRITE`, `PETS_INSTALL_ZIP`, `PETS_REMOVE`, `PETS_OPEN_DIR`, `PETS_PICK_FILE`, `PETS_CHANGED`（主→渲染） |

---

## 数据存储架构

### 存储位置

所有数据存储在 `%APPDATA%/xiao-niu-ma/`（Windows）或 `~/Library/Application Support/xiao-niu-ma/`（macOS）

### 目录结构

```
userData/
├── config.json           # 用户配置
├── state.json            # 每日触发状态
├── logs/                 # 工作日志（按日期存储）
│   ├── 2024-01-01.json
│   └── ...
├── todos/                # 待办清单（按日期存储）
│   ├── 2024-01-01.json
│   └── ...
├── ai-chats/             # AI 对话会话
│   ├── sessions.json     # 会话列表
│   └── <session-id>.json # 会话详情
├── scheduler/            # 定时任务
│   ├── tasks.json        # 任务列表
│   └── logs/             # 任务执行日志
├── pets/                 # 用户安装的桌宠包
│   └── <id>/             # 每个包一个目录
│       ├── manifest.json
│       ├── sprite_all.png
│       └── thumbnail.png
└── reports/              # AI 对话保存的文档
```

### 数据模型

#### AppConfig（用户配置）
- 工作时间（work_start, work_end）
- 聚焦阈值（focus_threshold_min）
- 离开阈值（away_threshold_min）
- LLM 配置（llm_api_url, llm_model）
- 猫咪位置（cat_position）
- AI 对话快捷键（ai_chat_hotkey）
- 系统提示词（ai_chat_system_prompt）
- 当前激活的桌宠包 ID（active_pet_pack）

#### DailyLog（工作日志）
- 日期（date）
- 计划输入（plan_input）
- 待办列表（todos）
- 晨间跳过标志（morning_skipped）
- 晚间日志（eod_log）
- 创建/更新时间（created_at, updated_at）

#### TodoItem（待办项）
- ID（id）
- 标题（title）
- 优先级（priority: high/medium/low）
- 预估时间（estimated_min）
- 状态（status: pending/done）

#### AIChatSession（AI 对话会话）
- 会话 ID（id）
- 标题（title）
- 消息列表（messages）
- 角色预设（personaId）
- 创建/更新时间（createdAt, updatedAt）

---

## 依赖关系图

### 主进程依赖关系

```
index.ts
├── windows.ts
├── tray.ts
├── scheduler.ts
├── activity-monitor.ts
├── ipc-handlers.ts
│   ├── store.ts
│   ├── windows.ts
│   ├── activity-monitor.ts
│   ├── llm-service.ts
│   ├── ai-chat-service.ts
│   ├── ai-chat-store.ts
│   ├── ai-chat-attachments.ts
│   ├── docx-export.ts
│   └── tools/
│       ├── spell-check.ts
│       └── task-scheduler.ts
├── auto-updater.ts
└── backup.ts
```

### 渲染进程依赖关系

```
main.tsx
├── App.tsx
│   ├── PixelCat/
│   ├── SpeechBubble/
│   ├── StatusBubble/
│   ├── MorningFlow/
│   ├── BreakReminder/
│   ├── EveningFlow/
│   ├── SummaryFlow/
│   └── hooks/
│       ├── useIPC.ts
│       ├── useCatMood.ts
│       └── useLLM.ts
├── Settings.tsx
├── LogViewer.tsx
├── ToolsPage.tsx
│   └── components/Tools/
└── AIChat.tsx
    └── ai-chat/
        ├── personas.ts
        └── slash-commands.ts
```

---

## 关键技术点

### 1. 透明窗口与鼠标穿透

- 主窗口设置为透明无边框
- 使用 `setIgnoreMouseEvents(true, { forward: true })` 实现透明区域穿透
- 渲染进程通过 `mousemove` + `elementFromPoint` 检测光标是否在可见元素上
- 动态切换鼠标事件穿透状态

### 2. 流式 LLM 调用

- 使用 SSE（Server-Sent Events）实现流式响应
- 支持 `think` 块解析（OpenAI 风格）
- 支持 `reasoning_content` 字段（DeepSeek/Qwen/MiniMax）
- Token 统计（优先使用 API usage，降级使用启发式估算）
- 支持 AbortController 中断

### 3. 键鼠活跃监测

- 使用 `uiohook-napi` 监听全局键鼠事件
- 降级机制：未安装时始终视为活跃
- 离开阈值检测：超过阈值重置累计时长
- 休息提醒：连续工作超过阈值触发

### 4. 定时触发器

- 每 30 秒检查一次（容忍 interval 漂移）
- 时间区间检测（目标时间已过且未触发）
- 上限保护（超过 2 小时不再补触发）
- 睡眠唤醒后立即检查

### 5. 数据原子写入

- 使用"写临时文件→重命名"模式
- 防止写入中断损坏数据
- 所有 JSON 数据通过 `atomicWrite` 函数写入

### 6. 备份与恢复

- 使用 JSZip 打包/解压
- 白名单机制（只备份业务数据）
- 导入前自动快照当前数据
- 安全校验（防止路径穿越）

### 7. 心情系统

- 心情值（0-100）
- 饥饿度（0-100，随时间衰减）
- 交互奖励（抚摸 +3，喂食 +5，完成待办 +1，完成计划 +5）
- Tier 系统（great/good/normal/hungry/sad）
- 动画反馈（不同 tier 播放不同动画）

---

## 开发与构建

### 开发命令

```bash
npm run dev          # 启动开发服务器
npm run build        # 构建生产版本
npm run dist         # 打包安装包
npm run typecheck    # TypeScript 类型检查
npm run lint         # ESLint 检查
npm run format       # Prettier 格式化
```

### 构建配置

- **主进程**：输出到 `dist-electron/main/`
- **预加载**：输出到 `dist-electron/preload/`
- **渲染进程**：输出到 `dist/`

### 路径别名

| 别名 | 路径 |
|------|------|
| `@shared` | `src/shared` |
| `@` | `src/renderer/src` |
| `@assets` | `assets` |

---

## 安全机制

### 1. Context Isolation

- 启用 `contextIsolation: true`
- 禁用 `nodeIntegration: false`
- 通过 `contextBridge` 暴露安全 API

### 2. API Key 存储

- 使用 `keytar` 存储到系统钥匙串
- 开发模式降级为明文存储（警告提示）
- 不包含在备份文件中

### 3. 路径穿越防护

- 备份导入时校验路径白名单
- 防止 `..` 路径穿越
- 只允许写入指定目录

### 4. IPC 通道类型化

- 使用 TypeScript 常量定义通道名称
- 避免硬编码字符串
- 编译时类型检查

---

## 性能优化

### 1. 流式渲染

- LLM 响应使用 SSE 流式推送
- 减少首字节等待时间
- 提升用户体验

### 2. Debounce

- 窗口移动/调整大小时 debounce 保存配置
- 避免频繁写盘

### 3. 懒加载

- 定时任务调度器动态导入
- 错别字检查动态导入
- 减少启动时间

### 4. 状态优化

- React 19 优化
- 减少不必要的 re-render
- 使用 `useMemo` 和 `useCallback`

---

## 日志系统

### 日志位置

- **主进程**：`%APPDATA%\xiao-niu-ma\logs\main.log`
- **渲染进程**：同一文件（通过 electron-log/renderer）

### 日志级别

- `debug`：详细调试信息
- `info`：一般信息
- `warn`：警告信息
- `error`：错误信息

### 异常处理

- 主进程：`uncaughtException` + `unhandledRejection`
- 渲染进程：`unhandledrejection` + `error`
- 统一写入日志文件

---

## 扩展点

### 1. 新增小工具

在 `src/main/tools/` 下添加新模块，在 `ipc-handlers.ts` 注册 IPC 通道。

### 2. 新增 AI 对话角色

在 `src/renderer/src/pages/ai-chat/personas.ts` 添加新角色定义。

### 3. 新增定时任务类型

扩展 `TaskSchedule` 类型，在 `task-scheduler.ts` 实现调度逻辑。

### 4. 新增 Agent Cron 模板

在 `src/main/agent/cron/built-in-templates.ts` 添加模板；任务持久化在 `{userData}/agent-cron/tasks.json`，由 `agent/cron/scheduler.ts` 独立调度。

### 5. 新增 LLM 提供商兼容

在 `ai-chat-service.ts` 添加新的响应解析逻辑。

### 6. 制作新的桌宠包

用户视角：在「设置 → 桌宠外观」上传任意尺寸 PNG，导入弹窗会让你框选裁切出 12 帧区域（推荐 1440×144）。  
高级作者：参见 `docs/pet-pack-spec.md` 了解 `manifest.json` 完整字段（含帧序列模式、自定义 fps）。

---

## 注意事项

1. **uiohook-napi**：需要 native binding，Windows 使用预编译包，如需重新编译运行 `npx electron-rebuild -f -w uiohook-napi`

2. **keytar**：生产环境必须安装，否则 API Key 明文存储

3. **macOS 签名**：未签名应用无法设置开机自启（开发模式正常）

4. **透明窗口**：macOS 上 alwaysOnTop 窗口会覆盖 dock，使用 `bounds` 而非 `workArea` 判定边缘

5. **流式响应**：处理 SSE 缓冲区不完整行，防止 JSON 解析失败

---

## 总结

小小牛马采用经典的 Electron 架构，主进程负责系统级功能，渲染进程负责用户界面，通过 IPC 进行通信。项目结构清晰，模块职责分明，便于维护和扩展。核心功能包括工作日志管理、AI 对话、定时任务、小工具等，通过 LLM 提升智能化体验。

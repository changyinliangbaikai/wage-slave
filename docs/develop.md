# 小小牛马 开发与启动指南 🐱

> 一只陪你上班的桌面像素橘猫助手。
> 面向长期在电脑前工作的办公室人员，帮你记录每日工作计划、提醒适时休息、下班复盘任务完成情况，月末/季末一键生成 AI 工作总结，并支持通过 Agent 协助你执行本地操作。

![像素猫预览](imgs/cat_happy_2.png)

---

## 一、功能特性

- **晨间问候**：到达上班时间自动弹出，用自然语言输入今日计划，AI 自动解析为待办清单。
- **休息提醒**：监测连续使用时长，超过阈值弹出提醒，支持「再等一会儿」。
- **晚间复盘**：下班时弹出，对照待办清单确认完成情况并记录工作日志。
- **周期总结**：月末/季末读取本地日志，调用 AI 一键生成工作总结。
- **像素橘猫**：常驻桌面，可拖动，拖至屏幕边缘自动收起，支持多种动画状态（空闲、抚摸、庆祝、工作中）。
- **统一对话与 Agent 助手**：一站式 AI 快速对话与 Agent 模式。Agent 可根据你的指令规划并调用本地工具（如读写文件、运行 Shell 命令、管理待办、定时任务等）来帮你干活。
- **兼容主流 LLM**：支持所有 OpenAI API 格式的接口（OpenAI、Claude、DeepSeek、本地 Ollama 等）。

---

## 二、开发环境要求

- **Node.js** >= 18
- **npm** >= 9
- **运行平台**：macOS / Windows 10 / Windows 11 （双平台均已完美支持开发、编译与生产运行）。

---

## 三、快速开始与本地开发

### 1. 克隆项目

```bash
git clone https://github.com/your-username/xiao-niu-ma.git
cd xiao-niu-ma
```

### 2. 安装依赖

```bash
npm install
```

> [!NOTE]
> 休息提醒功能依赖 `uiohook-napi` 进行全局键鼠活跃监测。该依赖在不同平台使用对应的预编译 native 绑定。
> 如果未安装或加载失败，程序会自动降级运行（始终视为活跃），不会影响其他核心功能的正常使用。

### 3. 启动开发模式

```bash
npm run dev
```

启动后橘猫会出现在屏幕角落，同时会自动打开 DevTools 调试面板。

**Mac 用户也可使用快速启动脚本：**
```bash
bash dev-mac.sh
```

### 4. 首次配置

橘猫启动后，在系统托盘图标（或 macOS Menu Bar 图标）上**右键 -> 设置**，填写以下必填配置：

| 配置项 | 说明 | 示例 |
|--------|------|------|
| **LLM API URL** | OpenAI 兼容格式的接口地址 | `https://api.openai.com/v1` |
| **API Key** | 对应服务的 API Key 密钥 | `sk-...` |
| **模型名称** | 要调用的模型 | `gpt-4o` 或 `deepseek-chat` |
| **上班时间** | 晨间问候触发时间 | `09:00` |
| **下班时间** | 晚间复盘触发时间 | `18:00` |

---

## 四、构建与打包

### 1. 仅编译（不打包）

```bash
npm run build
```

编译产物：
- `dist/` — Vite 构建的前端渲染进程资源
- `dist-electron/` — TypeScript 编译后的主进程和预加载脚本代码

### 2. 打包为本地安装包

```bash
npm run dist
```

| 运行平台 | 构建产物 | 默认输出目录 |
|------|------|----------|
| **macOS** | `小小牛马-x.x.x.dmg` / `.app` | `release/` |
| **Windows** | `小小牛马-Setup-x.x.x.exe` (NSIS 安装包) | `release/` |

> [!TIP]
> 建议在对应目标平台上进行打包。未签名的安装包在运行时可能会触发系统的安全警告（Windows SmartScreen / macOS 无法验证开发者），手动允许运行即可。

### 3. 类型检查

```bash
npm run typecheck
```

---

## 五、项目目录结构

```
xiao-niu-ma/
├── .github/
│   └── workflows/
│       └── build.yml          # GitHub Actions 自动构建工作流
├── assets/
│   ├── icon.icns              # macOS 应用图标
│   ├── icon.ico               # Windows 应用图标
│   └── pixel_cat/             # 像素猫 Sprite Sheet 资源
├── src/
│   ├── main/                  # Electron 主进程
│   │   ├── index.ts           # 应用入口，生命周期管理与模块加载
│   │   ├── windows.ts         # 窗口管理器（透明、鼠标穿透、副窗口工厂化）
│   │   ├── tray.ts            # 系统托盘与右键菜单
│   │   ├── scheduler.ts       # 上下班时间定时检测器
│   │   ├── activity-monitor.ts # 基于 uiohook-napi 的活跃监测
│   │   ├── store.ts           # 本地数据读写（原子写入保护）
│   │   ├── api-key.ts         # API Key 安全服务（系统凭证管理）
│   │   ├── llm-service.ts     # LLM 通用请求封装
│   │   ├── docx-export.ts     # 工作总结 Word 导出
│   │   ├── ipc-handlers.ts    # IPC 处理器分发中心
│   │   ├── ipc-handlers-chat.ts # 统一对话系统 IPC 处理器
│   │   ├── ipc-handlers-attachment.ts # 对话附件处理 IPC 处理器
│   │   ├── ipc/               # 拆分后的 IPC 领域业务子模块
│   │   │   ├── config.ts      # 系统设置 IPC
│   │   │   ├── data.ts        # 业务数据读写 IPC
│   │   │   ├── window.ts      # 窗口控制 IPC
│   │   │   ├── tools.ts       # 小工具挂载 IPC
│   │   │   ├── scheduler.ts   # Shell 定时任务 IPC
│   │   │   ├── skills.ts      # Agent 技能系统 IPC
│   │   │   └── agent-cron.ts  # Agent 定时调度控制面 IPC
│   │   ├── chat/              # 统一对话业务模块
│   │   │   ├── dialogue-service.ts # 聊天与 Agent 执行分流服务
│   │   │   └── chat-store.ts  # 会话数据读写 Facade
│   │   ├── agent/             # Agent 核心逻辑
│   │   │   ├── orchestrator.ts  # ReAct 循环、多轮规划与中断机制
│   │   │   ├── tool-executor.ts # 本地工具执行（支持跨平台命令物理强杀）
│   │   │   ├── tool-registry.ts # 工具 Schema 与注册表
│   │   │   ├── security.ts      # 安全护栏（路径白名单与黑名单过滤）
│   │   │   ├── cron/            # 独立的 Agent 定时任务调度器
│   │   │   └── skills/          # Agent 扩展技能系统
│   │   └── tools/             # 小工具业务实现
│   │       ├── spell-check.ts    # 错别字检查
│   │       └── task-scheduler.ts # 普通定时任务调度引擎（Shell 运行）
│   ├── preload/
│   │   └── index.ts           # 预加载脚本，桥接 IPC 通道
│   ├── renderer/src/          # React 渲染进程（前端）
│   │   ├── main.tsx           # 前端入口与 Hash 路由
│   │   ├── App.tsx            # 主窗口根组件
│   │   ├── pages/             # 页面组件
│   │   │   ├── Chat.tsx       # 统一 AI 对话与 Agent 对话面板
│   │   │   ├── Settings.tsx   # 设置页
│   │   │   ├── ToolsPage.tsx  # 工具中心
│   │   │   ├── SkillsPage.tsx # Agent 技能市场与管理页
│   │   │   ├── MorningFlow.tsx   # 晨间计划流程
│   │   │   ├── EveningFlow.tsx   # 晚间复盘流程
│   │   │   ├── BreakReminder.tsx # 休息提醒遮罩
│   │   │   └── LogViewer.tsx     # 历史工作日志查看
│   │   ├── hooks/             # 自定义 Hooks
│   │   │   ├── useIPC.ts      # 安全 IPC 通信封装
│   │   │   ├── useChat.ts     # 统一对话会话状态 Hook
│   │   │   ├── useFileAttachments.ts # 附件管理 Hook
│   │   │   └── useCatMood.ts  # 橘猫心情与饥饿度系统
│   │   └── components/        # 公共组件（PixelCat 宠物引擎等）
│   └── shared/
│       ├── types.ts           # 共享类型定义
│       ├── types-chat.ts      # 对话系统专用类型
│       └── ipc-channels.ts    # IPC 通道名称常量
```

---

## 六、本地数据存储

所有数据均保存在本地，绝不上传第三方服务器：

*   **macOS**：`~/Library/Application Support/xiao-niu-ma/`
*   **Windows**：`%APPDATA%\xiao-niu-ma\`

### 存储结构：

```
userData/
├── config.json                 # 用户基础配置（不含 API Key）
├── state.json                  # 每日触发状态记录
├── logs/
│   ├── YYYY-MM-DD.json         # 每日工作日志
│   └── ...
├── todos/
│   ├── YYYY-MM-DD.json         # 每日待办清单
│   └── ...
├── ai-chats/                   # 统一对话会话数据
│   ├── sessions.json           # 会话列表索引
│   └── <session-id>.json       # 单次会话的消息与上下文详情
├── scheduler/                  # 普通定时任务数据
│   ├── tasks.json              # 任务配置列表
│   └── logs/                   # Shell 执行日志输出（最大 5000KB 截断）
├── agent-cron/                 # 独立的 Agent Cron 任务存储
└── pets/                       # 用户自主安装的桌宠包
```

> [!IMPORTANT]
> **API Key 的安全性**：
> API Key 会被存储到操作系统的安全钥匙串中（Windows 凭据管理器 / macOS Keychain）。
> 在开发环境下，如果没有相应的系统组件，会自动降级为本地明文存储并弹出警告。API Key 不会包含在任何备份文件中。

---

## 七、常见问题（FAQ）

**Q：休息提醒不生效？**
*   休息提醒依赖 `uiohook-napi` 对全局键鼠的监听。请确认应用没有被杀毒软件误杀或拦截。在 macOS 上运行，需在「系统设置 -> 隐私与安全性 -> 辅助功能」中授予应用控制权限。

**Q：如何强杀 Agent 执行时失控的本地命令？**
*   我们优化了 `run_command` 的消杀机制，在 macOS 上会通过 `-pid` 杀死整个进程组，Windows 则通过 `taskkill` 清理进程树。直接点击对话框中的“停止”按钮，或是直接关闭对话窗口，后台的失控子进程（如 `sleep 60` 等）都会在第一时间被彻底清理，不会滞留后台。

**Q：如何备份工作日志？**
*   直接复制数据目录中的 `logs/` 和 `todos/` 文件夹即可，里面均为标准的 JSON 格式文件。也可使用设置页中的“数据备份与导出”功能，一键打包成 zip 文件。

---

## 八、License

MIT

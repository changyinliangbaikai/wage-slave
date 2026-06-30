# 小小牛马客户端 Codex 风格交互界面重构方案

> **方案状态**：待评审/可执行  
> **重构目标**：将小小牛马（xiao-niu-ma）的对话与项目管理界面，重构为类似于 Codex 客户端的**双栏工作台布局**。  
> **设计约束**：
> 1. **保留原有的“暖米黄配方”与“橙棕猫咪”暖色调风格**，仅对界面的排版、布局、树状交互、卡片组件及输入区进行结构性重构，不引入暗色主题。
> 2. **设置界面一体化**：设置界面不再通过新建 Electron 窗口打开，而是直接作为右侧主显示区的子视图跳转。
> 3. **账户管理弹窗**：在左下角用户 Profile 点击时，弹出包含账户与设置项的菜单浮层，预留并置灰置空非核心账号项，保留设置跳转。
> 4. **自定义命令确认弹窗**：废弃非常丑陋且容易被长命令撑爆高度的 Electron 原生系统确认框，重构为**基于 HTML/React 的内嵌式自定义弹窗**，支持长命令滚动展示、一键复制及安全兜底。

---

## 1. 界面与交互架构设计 (UI & UX Architecture)

### 1.1 界面排版对比与新版视图设计

#### 1.1.1 现有布局（扁平单栏卡片式）
```
┌────────────────────────────────────────────────────────┐
│ 顶部：🐱 小小牛马 | 项目下拉切换 📁 | 新会话 | 历史抽屉    │
├────────────────────────────────────────────────────────┤
│                                                        │
│ 消息流 (滚动区，浅色卡片式)                           │
│                                                        │
├────────────────────────────────────────────────────────┤
│ 底部：附件列表 (平铺) + 矩形输入框 (带有发送/停止)      │
└────────────────────────────────────────────────────────┘
```

#### 1.1.2 新版 Codex 风格布局（双栏常驻工作台）
```
┌───────────────────────────────────┬────────────────────────────────────────────────────────┐
│ [拖拽区] ◀   ▶   新建   搜索   插件 │ 📁 梳理项目全貌               ...  [🧠 5.5 超高 ▾] [◫] [⚙]│
├───────────────────────────────────┼────────────────────────────────────────────────────────┤
│ 【 项目 】                         │                                                        │
│ 📁 mark-eight-octopus             │  • npm run typecheck 通过                              │
│ 📁 mark-six-reboot                │  • npm run lint 通过                                   │
│ 📁 mark-zero-jarvis               │                                                        │
│ 📁 xiao-niu-ma (当前激活项目)     │  保留未刷的部分：AIChat.tsx，用时约 5分10秒。          │
│   📄 生成测试Excel           ⌘9   │                                                        │
│   📄 梳理项目全貌 (当前会话)  2周 │  ┌──────────────────────────────────────────────────┐  │
│                                   │  │ 📄 architecture.md                [ 打开方式 ▾ ] │  │
│ 【 2025 】                        │  └──────────────────────────────────────────────────┘  │
│ 📁 mark-twelve-duck               │  ┌──────────────────────────────────────────────────┐  │
│ 📁 第三代数仓建设                 │  │ 💾 已编辑 13 个文件                 撤销 ↩  审核 ✓ │  │
│ 📁 数智徐农                       │  │ +22 -86                                          │  │
│                                   │  │ docs/architecture.md                        +16  │  │
│ 【 对话 】                         │  │ 再显示 10 个文件 ▾                                │  │
│ 💬 Say hello                  16h │  └──────────────────────────────────────────────────┘  │
│ 💬 打招呼                     16h │    [复制] [赞] [踩] [重新生成]                             │
├───────────────────────────────────┤                                                        │
│                                   │                  ┌──────────────────┐                  │
│ 👤 jhxstudio                 [⚙]  │                  │ 要求后续变更     │                  │
│    Plus                           │                  │ + 帮我审批▾  5.5▾│                  │
└───────────────────────────────────┴──────────────────┴──────────────────┴─────────────────┘
```

#### 1.1.3 自定义账户弹出菜单浮层 (AccountPopover)
```
  ┌─────────────────────────┐
  │ jhxlovelmm@gmail.com    │  <-- 邮箱标识 (置灰)
  │ 👤 个人帐户             │  <-- 个人账户入口 (置灰)
  ├─────────────────────────┤
  │ ℹ 个人资料              │  <-- 个人资料 (置灰)
  │ ⚙ 设置              ⌘,  │  <-- 点击切换至 Settings 嵌入视图 (高亮可用)
  └─────────────────────────┘
  [👤 jhxstudio        [⚙] ]
```

---

### 1.2 自定义命令确认弹窗视图设计 (Command Modal View)

当 Agent 发起敏感指令时，会触发如下内嵌自定义弹窗，长命令内容可局部滚动，防止破坏整体窗口尺寸：

```
┌─────────────────────────────────────────────────────────────┐
│ 🤖 Agent 请求执行命令                                    [×] │
├─────────────────────────────────────────────────────────────┤
│ 工作目录：/Users/jhx/.../xiao-niu-ma                         │
│ 超时时间：30 秒                                             │
│                                                             │
│ ┌───────────────────────────────────────────────[复制]──┐ │
│ │ npm run build && npm run test && git commit -m "..."   │ │
│ │ (支持超长命令局部滚动展示，最高限制 250px)               │ │
│ └───────────────────────────────────────────────────────┘ │
│ ⚠️ 命令将在你本机执行。如果不确定其行为，请点【拒绝】。       │
├─────────────────────────────────────────────────────────────┤
│                          [拒绝 (Esc)]    [允许执行 (Enter)]  │
└─────────────────────────────────────────────────────────────┘
```

---

### 1.3 暖色视觉设计变量映射 (Theme Color Mapping)

| 视觉概念 | 原有变量名 | 默认颜色值 (暖米黄配方) | 对应 Codex 布局与自定义弹窗应用 |
| :--- | :--- | :--- | :--- |
| **主背景色** | `--agent-bg` | `#f7f5ef` (米黄纸张) | 右侧主聊天区背景、代码块背景、设置面板背景、弹窗内命令展示框背景 |
| **侧边栏背景** | `--sidebar-bg` [NEW] | `#ede9de` (略深的温暖卡其) | 左侧常驻导航栏，与聊天区拉开层次 |
| **面板/卡片背景** | `--agent-panel` | `#fffef7` (暖乳白) | 附件卡片、Git 变更卡片、账户浮动菜单、设置区段背景、确认弹窗背景 |
| **输入框/胶囊背景**| `--agent-panel-alt`| `#fffef0` (微黄乳白) | 胶囊输入框、按钮背景、文本框背景、弹窗内参数展示区 |
| **边框主色** | `--agent-border` | `#e5e0d1` (温暖浅卡其) | 所有分栏分割线、卡片边框、输入框边框、命令展示框边框 |
| **边框强化色** | `--agent-border-strong` | `#d6cdb6` (中卡其) | 聚焦状态边框、激活元素边框、弹窗投影边框 |
| **文字主色** | `--agent-text` | `#3a2a1a` (深咖啡/深棕) | 正文字体、图标主色、终端指令文本 |
| **文字副色** | `--agent-text-dim` | `#8b7a5d` (暖秋灰) | 辅助信息、时间戳、未激活按钮、账号占位文本 |
| **主品牌色 (橙)** | `--agent-primary` | `#c0733a` (牛马橙棕) | 激活的项目树节点、发送图标、高亮提示 |
| **草绿 (成功)** | `--agent-success` | `#5a8f3c` (抹茶绿) | 允许执行按钮、文件新增指标、审核通过按钮 |
| **砖红 (警示)** | `--agent-error` | `#c0392b` (暖砖红) | 拒绝按钮、文件删除指标、撤销操作按钮 |

---

## 2. 主进程窗口配置优化 (Main Process Config)

为了使 Electron 窗口呈现一体化双栏，需在主进程中将标题栏隐藏，由前端来渲染窗口拖拽区域，同时移除废弃的独立窗口逻辑。

**修改文件**：`src/main/windows.ts`
1. **隐藏聊天窗口原生标题栏**：
```diff
  const winOpts: Electron.BrowserWindowConstructorOptions = {
    width: saved?.width ?? 1020, // 双栏推荐宽度调整为 1020
    height: saved?.height ?? 750,
    minWidth: 800,
    minHeight: 550,
    title: '小小牛马',
    resizable: true,
-   backgroundColor: '#f7f5ef',
+   backgroundColor: '#f7f5ef', // 保持米黄纸张底色
+   titleBarStyle: 'hidden', // 隐藏原生标题栏，macOS 会自动在 HTML 上层放置红黄绿控制按钮
+   trafficLightPosition: { x: 18, y: 18 },
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  }
```
2. **废弃独立设置窗口的逻辑**：
   - 彻底删除 `openSettingsWindow()` 与 `settingsWindow` 全局变量。
   - 保留原主进程的 config ipc 通信处理器（`config-get` / `config-set` ），使同一窗口中的前端渲染可以直接通信。

---

## 3. 前端页面框架与状态流重构 (`Chat.tsx`)

**修改文件**：`src/renderer/src/pages/Chat.tsx`
删除原有的抽屉，页面整体重构为 flex 双栏常驻布局，并通过 `currentView` 动态挂载右侧主视图：

```typescript
import { useState } from 'react'
import Sidebar from '../components/chat/Sidebar'
import ChatHeader from '../components/chat/ChatHeader'
import Settings from './Settings'

export default function Chat() {
  const [currentView, setCurrentView] = useState<'chat' | 'settings'>('chat')
  
  // 切换项目或加载历史会话时，自动还原回聊天主界面
  const handleLoadSession = (id: string) => {
    setCurrentView('chat')
    loadSession(id)
  }
  const handleSwitchProject = (id: string) => {
    setCurrentView('chat')
    switchProject(id)
  }
  const handleNewSession = () => {
    setCurrentView('chat')
    newSession()
  }

  return (
    <div className="codex-layout">
      {/* 左侧侧边栏 (常驻) */}
      <Sidebar
        projects={projects}
        currentProjectId={projectId}
        currentSessionId={sessionId}
        sessions={sessions}
        onSwitchProject={handleSwitchProject}
        onLoadSession={handleLoadSession}
        onNewSession={handleNewSession}
        onOpenSettings={() => setCurrentView('settings')}
      />
      
      {/* 右侧主显示区 */}
      <div className="codex-main-pane">
        {currentView === 'chat' ? (
          <>
            <ChatHeader ... />
            <main className="chat__list" ...>
              {/* 消息列表 */}
            </main>
            <footer className="chat__footer">
              {/* 胶囊输入框 */}
            </footer>
          </>
        ) : (
          <>
            {/* 顶栏附带“返回”操作 */}
            <header className="pane-header">
              <div className="pane-header__title">
                <button className="settings-back-btn" onClick={() => setCurrentView('chat')}>◀ 返回聊天</button>
                <span>设置中心</span>
              </div>
            </header>
            <div className="settings-view-scroll">
              <Settings />
            </div>
          </>
        )}
      </div>
    </div>
  )
}
```

---

## 4. 前端组件重构详细方案 (Components Redesign)

### 4.1 左侧侧边栏组件 (Sidebar.tsx [NEW])

**职责**：提供项目树级展示、独立对话展示、系统级入口、用户 profile 及账户菜单挂载。
**物理路径**：`src/renderer/src/components/chat/Sidebar.tsx`

1. **Header 导航控制区**：
   - 包含 macOS 交通灯占位区（`-webkit-app-region: drag`，宽度 `80px`）。
   - 导航历史箭头（返回/前进，绑定路由或会话状态切换）。
   - 快捷动作组：
     - `新建对话`（触发 `newSession()`）
     - `搜索`（全局会话搜索）
     - `插件`（原“🧩 技能”中心入口）
2. **“项目 (Projects)” 树形折叠组**：
   - 遍历 `projects` 数组：
     - 若为**非激活项目**：显示文件夹图标 📁 和项目名称。点击后调用 `switchProject(proj.id)`。
     - 若为**激活项目**（如 `xiao-niu-ma`）：背景高亮（采用更深的卡其色或淡橙色背景）。展开显示属于该项目的 Chat Sessions（即 Task）。
     - **会话项 (Session Item)**：显示文档或对话图标，点击后调用 `loadSession(session.id)`。
       - 右侧元数据：显示快捷键提示（如 `⌘9`）或时间戳（如 `2 周`，使用 `updatedAt` 格式化）。
3. **“2025” 分组折叠项**：
   - 归纳历史/归档的项目列表。支持一键折叠收纳。
4. **“对话 (Conversations)” 列表组**：
   - 展示不隶属于任何项目的独立快速对话（如 `Say hello`）。
5. **用户 Profile 底部栏**：
   - 显示圆形头像，用户名称 `jhxstudio`，等级标签 `Plus`。整个区域可点击以切换账户弹出菜单。

---

### 4.2 右侧聊天头组件 (ChatHeader.tsx [NEW])

**物理路径**：`src/renderer/src/components/chat/ChatHeader.tsx`

- **会话标题**：显示当前 Session Title，旁边附带 `...` 菜单（包含：重命名、归档、物理压缩 `/compact`、删除会话）。
- **窗口可拖拽区**：中间空白区设置 `flex: 1` 和 `-webkit-app-region: drag`，方便双击或拖拽移动整个窗口。
- **大模型选择器 (Model Dropdown)**：
  - 药丸形圆角按钮，带有蓝色机器人/大脑图标，文字为当前模型预设（如 `5.5 超高` 或具体模型名称如 `DeepSeek-V3`）。
  - 点击弹出浮层，展示常用模型白名单，点击后可快捷写入全局 `llm_model` 配置。
- **分栏与侧边栏控制**：右侧常驻布局切换按钮，用于折叠/展开左侧侧边栏、开启多视窗调试等。

---

### 4.3 文件卡片组件 (FileCard.tsx [NEW])

**物理路径**：`src/renderer/src/components/chat/FileCard.tsx`

若大模型关联了特定文件，或者用户上传了附件，渲染为独立卡片形式。

```html
<div className="codex-file-card">
  <div className="file-card__icon">📄</div>
  <div className="file-card__info">
    <div className="file-card__name">architecture.md</div>
    <div className="file-card__meta">文档 · MD</div>
  </div>
  <div className="file-card__actions">
    <select className="file-card__open-select" defaultValue="default">
      <option value="default">打开方式</option>
      <option value="system">系统默认打开</option>
      <option value="vscode">VS Code 打开</option>
      <option value="editor">内置编辑器打开</option>
    </select>
  </div>
</div>
```

---

### 4.4 文件变更审核卡片 (GitChangeBox.tsx [NEW])

**物理路径**：`src/renderer/src/components/chat/GitChangeBox.tsx`

Agent 修改项目文件后，在对话中以类似 Git 提交确认的卡片渲染。

```html
<div className="codex-git-card">
  {/* 卡片头部 */}
  <div className="git-card__header">
    <div className="git-card__status">
      <span className="git-card__icon">💾</span>
      <span className="git-card__title">已编辑 {filesCount} 个文件</span>
      <span className="git-card__stats text-green-red">+{insertions} -{deletions}</span>
    </div>
    <div className="git-card__actions">
      <button className="git-btn git-btn--undo" onClick={onUndo}>撤销 ↩</button>
      <button className="git-btn git-btn--approve" onClick={onApprove}>审核</button>
    </div>
  </div>
  
  {/* 文件变更列表 (折叠区) */}
  <div className="git-card__file-list">
    {visibleFiles.map(file => (
      <div className="git-file-item" key={file.path}>
        <span className="git-file-name">{file.path}</span>
        <span className="git-file-diff">+{file.added} -{file.deleted}</span>
      </div>
    ))}
  </div>
  
  {/* 更多折叠按钮 */}
  {remainingCount > 0 && (
    <button className="git-card__more-btn" onClick={toggleExpand}>
      再显示 {remainingCount} 个文件 ▾
    </button>
  )}
</div>
```

---

### 4.5 胶囊式输入框组件 (CapsuleInput.tsx [NEW])

**物理路径**：`src/renderer/src/pages/agent/CapsuleInput.tsx`

放弃贴底方形输入框，改为居中浮动的胶囊形设计。
- **胶囊容器 (`.input-capsule-container`)**：
  - 宽度：`max-width: 760px`，在聊天区底部居中悬浮。
  - 圆角：`border-radius: 24px`，背景为 `#fffef0`，边框为 `1px solid #e5e0d1`。
- **输入区域 (`.input-capsule__textarea`)**：
  - 占位符为 `"要求后续变更"`，无边框、无聚焦环，支持自动高度。
- **工具条 (`.input-capsule__toolbar`)**：
  - **左侧**：`+` 附件按钮与药丸按钮（如：`帮我审批 ▾`，可快捷唤出 `/plan` 等指令）。
  - **右侧**：推理强度指示器（如 `5.5 超高 ▾`），语音麦克风图标，牛马橙色发送按钮 `↑`。

---

## 5. 自定义命令确认弹窗设计 (Custom Dialog)

### 5.1 进程通信与安全模块重构

#### 5.1.1 新增 IPC 信道定义
在 `src/shared/ipc-channels.ts` 中定义主进程与渲染进程之间的命令确认桥梁：
```typescript
export const IPC = {
  // ── 终端命令确认通道 ──────────────────────────
  CHAT_CONFIRM_COMMAND:          'main:chat-confirm-command',          // 主进程向渲染进程请求确认命令
  CHAT_CONFIRM_COMMAND_RESPONSE: 'renderer:chat-confirm-command-response' // 渲染进程将确认结果发回主进程
}
```

#### 5.1.2 主进程安全拦截 (`security.ts`)
重构主进程安全拦截函数 `confirmCommandWithUser`。优先向前端推送，仅在窗口不可用时才回退使用原生对话框。

**修改文件**：`src/main/agent/security.ts`
```typescript
import { ipcMain } from 'electron'
import { getChatWindow } from '../windows'
import { IPC } from '@shared/ipc-channels'

const pendingConfirmations = new Map<string, (allowed: boolean) => void>()

export function registerConfirmCommandIPC(): void {
  ipcMain.on(IPC.CHAT_CONFIRM_COMMAND_RESPONSE, (_e, payload: { id: string; allowed: boolean }) => {
    const resolve = pendingConfirmations.get(payload.id)
    if (resolve) {
      pendingConfirmations.delete(payload.id)
      resolve(payload.allowed)
    }
  })
}

async function doConfirmCommandWithUser(params: {
  command: string
  workDir?: string
  timeoutMs: number
}): Promise<boolean> {
  const { command, workDir, timeoutMs } = params
  const chatWin = getChatWindow()

  // 1. 若聊天窗口已打开且处于显示状态，调用自定义 React 弹窗
  if (chatWin && !chatWin.isDestroyed() && chatWin.isVisible()) {
    const queryId = `confirm_cmd_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    
    return await new Promise<boolean>((resolve) => {
      pendingConfirmations.set(queryId, resolve)
      
      chatWin.webContents.send(IPC.CHAT_CONFIRM_COMMAND, {
        id: queryId,
        command,
        workDir,
        timeoutMs
      })

      // 安全超时，防死锁
      setTimeout(() => {
        if (pendingConfirmations.has(queryId)) {
          pendingConfirmations.delete(queryId)
          resolve(false)
        }
      }, timeoutMs + 10000)
    })
  }

  // 2. 窗口不存活时，安全回退原生对话框
  return doNativeMessageBoxConfirm(params)
}
```

---

### 5.2 前端自定义命令确认弹窗设计 (`Modal.tsx`)

**修改文件**：`src/renderer/src/components/Modal/Modal.tsx`

1. **扩展类型定义**：
```typescript
interface ModalRequest {
  id: number
  kind: 'alert' | 'confirm' | 'prompt' | 'confirm-command'
  title: string
  message?: string
  command?: string
  workDir?: string
  timeoutMs?: number
  resolve: (value: boolean | string | null) => void
}
```

2. **新增导出函数**：
```typescript
export function confirmCommand(command: string, workDir?: string, timeoutMs = 30000): Promise<boolean> {
  return push({
    kind: 'confirm-command',
    title: '🤖 Agent 请求执行命令',
    command,
    workDir,
    timeoutMs,
    resolve: () => {}
  }) as Promise<boolean>
}
```

3. **在 `ModalDialog` 内部渲染指令确认区**：
```typescript
if (req.kind === 'confirm-command') {
  return (
    <div className="modal-overlay" onClick={handleCancel} role="dialog" aria-modal="true" aria-label={req.title}>
      <div className="modal-panel modal-panel--command" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">🤖 Agent 请求执行命令</span>
          <button type="button" className="modal-close" onClick={handleCancel} aria-label="关闭">×</button>
        </div>
        
        <div className="modal-command-meta">
          <div className="meta-item">
            <span className="meta-label">工作目录:</span>
            <code className="meta-value" title={req.workDir}>{req.workDir || '项目根目录'}</code>
          </div>
          <div className="meta-item">
            <span className="meta-label">超时限制:</span>
            <span className="meta-value">{req.timeoutMs ? `${req.timeoutMs / 1000} 秒` : '无限制'}</span>
          </div>
        </div>

        <div className="modal-command-box-wrapper">
          <pre className="modal-command-pre">
            <code>{req.command}</code>
          </pre>
          <button 
            type="button" 
            className="command-copy-btn" 
            onClick={() => {
              if (req.command) navigator.clipboard.writeText(req.command);
            }}
          >
            复制
          </button>
        </div>

        <div className="modal-command-warning">
          ⚠️ 命令将在你本机执行。请务必审核核对，确认该操作安全再放行！
        </div>

        <div className="modal-footer">
          <button type="button" className="modal-btn modal-btn--cancel" onClick={handleCancel}>
            拒绝
          </button>
          <button
            type="button"
            ref={confirmBtnRef}
            className="modal-btn modal-btn--confirm-execute"
            onClick={handleConfirm}
          >
            允许执行
          </button>
        </div>
      </div>
    </div>
  )
}
```

4. **绑定全局 IPC 侦听器 (`App.tsx`)**：
```typescript
import { confirmCommand } from './components/Modal/Modal'

useEffect(() => {
  const api = window.electronAPI
  if (!api) return

  const offConfirm = api.on(IPC.CHAT_CONFIRM_COMMAND, async (payload: { id: string; command: string; workDir?: string; timeoutMs: number }) => {
    const allowed = await confirmCommand(payload.command, payload.workDir, payload.timeoutMs)
    api.send(IPC.CHAT_CONFIRM_COMMAND_RESPONSE, {
      id: payload.id,
      allowed
    })
  })

  return () => {
    offConfirm()
  }
}, [])
```

---

## 6. 样式表设计 (Tailored Theme CSS)

在 `src/renderer/src/pages/Chat.css` 中引入新布局及组件的样式，所有颜色依旧使用 `--agent-*` 配色系。

```css
/* ==========================================================================
   Codex Style Theme Layout (暖米黄配方)
   ========================================================================== */
.chat {
  --sidebar-bg: #ede9de; /* 左侧常驻侧边栏：稍深的温暖卡其 */
  --highlight-hover: #e2dcd0; /* 选中或悬停状态：中卡其 */
}

/* 一体化双栏容器 */
.codex-layout {
  display: flex;
  height: 100vh;
  width: 100vw;
  overflow: hidden;
  background-color: var(--agent-bg); /* #f7f5ef */
  color: var(--agent-text); /* #3a2a1a */
}

/* 左侧侧边栏 */
.codex-sidebar {
  width: 260px;
  background-color: var(--sidebar-bg);
  border-right: 1px solid var(--agent-border);
  display: flex;
  flex-direction: column;
  height: 100%;
  user-select: none;
}

.sidebar-header {
  padding: 16px;
  display: flex;
  align-items: center;
  gap: 12px;
  padding-left: 80px; /* 避让 macOS 交通灯 */
}

/* ==========================================================================
   账户弹出浮层 (AccountPopover) Styles
   ========================================================================== */
.codex-account-popover {
  position: absolute;
  bottom: 60px;
  left: 16px;
  width: 220px;
  background-color: var(--agent-panel);
  border: 1px solid var(--agent-border-strong);
  border-radius: 8px;
  box-shadow: 0 4px 16px rgba(58, 42, 26, 0.15);
  z-index: 1000;
  padding: 6px 0;
  display: flex;
  flex-direction: column;
}

.popover-section {
  display: flex;
  flex-direction: column;
}

.popover-divider {
  height: 1px;
  background-color: var(--agent-border);
  margin: 6px 0;
}

.popover-email {
  font-size: 11px;
  color: var(--agent-text-dim);
  padding: 4px 12px;
  word-break: break-all;
}

.popover-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: none;
  border: none;
  color: var(--agent-text);
  width: 100%;
  text-align: left;
  padding: 8px 12px;
  font-size: 13px;
  text-decoration: none;
}

.popover-item.is-disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.popover-item.is-clickable {
  cursor: pointer;
}
.popover-item.is-clickable:hover {
  background-color: var(--highlight-hover);
}

.popover-shortcut {
  font-size: 10px;
  color: var(--agent-text-dim);
  background-color: var(--agent-panel-alt);
  padding: 1px 4px;
  border-radius: 3px;
  border: 1px solid var(--agent-border);
}

/* ==========================================================================
   嵌入式设置页面滚动适配 (Embed Settings View)
   ========================================================================== */
.settings-view-scroll {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
  background-color: var(--agent-bg);
}

/* 返回聊天按钮 */
.settings-back-btn {
  background-color: var(--agent-panel-alt);
  border: 1px solid var(--agent-border);
  color: var(--agent-text);
  padding: 4px 10px;
  font-size: 12px;
  border-radius: 12px;
  cursor: pointer;
  margin-right: 12px;
  display: inline-flex;
  align-items: center;
}
.settings-back-btn:hover {
  background-color: var(--highlight-hover);
}

/* 调整嵌入后设置页面的最大宽度 */
.settings-view-scroll .settings-container {
  max-width: 680px;
  margin: 0 auto;
  padding: 0;
  background: none;
}

/* 确保保存栏在嵌入后表现良好 */
.settings-view-scroll .settings-footer {
  position: sticky;
  bottom: 0;
  background-color: var(--agent-bg);
  padding: 12px 0;
  border-top: 1px solid var(--agent-border);
  margin-top: 20px;
}

/* ==========================================================================
   卡片化 Message Elements 与胶囊输入框 Styles
   ========================================================================== */
/* 文件卡片 */
.codex-file-card {
  background-color: var(--agent-panel);
  border: 1px solid var(--agent-border);
  border-radius: 8px;
  padding: 12px 16px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  max-width: 600px;
  margin: 10px 0;
}

.file-card__info {
  flex: 1;
  margin-left: 12px;
}
.file-card__name {
  font-size: 13px;
  font-weight: 600;
  color: var(--agent-text);
}
.file-card__meta {
  font-size: 11px;
  color: var(--agent-text-dim);
}

.file-card__open-select {
  background-color: var(--agent-panel-alt);
  border: 1px solid var(--agent-border);
  color: var(--agent-text);
  font-size: 12px;
  padding: 4px 8px;
  border-radius: 4px;
}

/* Git Diff 卡片 */
.codex-git-card {
  background-color: var(--agent-panel);
  border: 1px solid var(--agent-border);
  border-radius: 8px;
  margin: 12px 0;
  max-width: 640px;
  overflow: hidden;
}

.git-card__header {
  padding: 12px 16px;
  border-bottom: 1px solid var(--agent-border);
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.git-card__status {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: bold;
}

.git-card__stats {
  font-size: 12px;
}
.git-card__stats.text-green-red {
  color: var(--agent-success);
}

.git-card__actions {
  display: flex;
  gap: 8px;
}

.git-btn {
  background-color: var(--agent-panel-alt);
  border: 1px solid var(--agent-border);
  color: var(--agent-text);
  padding: 4px 10px;
  font-size: 12px;
  border-radius: 4px;
  cursor: pointer;
}
.git-btn:hover {
  background-color: var(--highlight-hover);
}

.git-card__file-list {
  padding: 8px 16px;
  background-color: var(--agent-bg);
}

.git-file-item {
  display: flex;
  justify-content: space-between;
  font-family: var(--agent-mono);
  font-size: 12px;
  padding: 4px 0;
}
.git-file-diff {
  color: var(--agent-text-dim);
}

.git-card__more-btn {
  width: 100%;
  background: none;
  border: none;
  border-top: 1px solid var(--agent-border);
  color: var(--agent-text-dim);
  padding: 8px;
  font-size: 12px;
  cursor: pointer;
  text-align: center;
}
.git-card__more-btn:hover {
  color: var(--agent-text);
}

/* 胶囊输入框 */
.input-capsule-container {
  position: absolute;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%);
  width: calc(100% - 48px);
  max-width: 760px;
  background-color: var(--agent-panel-alt); /* #fffef0 */
  border: 1px solid var(--agent-border-strong); /* #d6cdb6 */
  border-radius: 24px;
  padding: 12px 18px;
  box-shadow: 0 8px 24px rgba(58, 42, 26, 0.12); /* 深棕柔和阴影 */
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.input-capsule__textarea {
  background: none;
  border: none;
  resize: none;
  outline: none;
  color: var(--agent-text);
  font-size: 14px;
  line-height: 1.5;
  width: 100%;
}

.input-capsule__toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.input-capsule__left,
.input-capsule__right {
  display: flex;
  align-items: center;
  gap: 10px;
}

.input-capsule__btn {
  background: none;
  border: none;
  color: var(--agent-text-dim);
  cursor: pointer;
  padding: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.input-capsule__btn:hover {
  color: var(--agent-text);
}

.input-capsule__pill {
  background-color: var(--agent-panel);
  border: 1px solid var(--agent-border);
  color: var(--agent-text);
  font-size: 12px;
  padding: 4px 10px;
  border-radius: 12px;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 4px;
}
.input-capsule__pill:hover {
  background-color: var(--highlight-hover);
}

.input-capsule__send-btn {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background-color: var(--agent-primary); /* 牛马橙棕 */
  color: #ffffff;
  border: none;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  font-weight: bold;
}
.input-capsule__send-btn:hover {
  opacity: 0.9;
}

/* ==========================================================================
   自定义命令确认弹窗 (Custom Modal) Styles
   ========================================================================== */
.modal-panel--command {
  width: 580px;
  max-width: 90vw;
  background-color: var(--agent-panel); /* #fffef7 */
  border: 1px solid var(--agent-border-strong);
  box-shadow: 0 12px 36px rgba(58, 42, 26, 0.18);
}

.modal-command-meta {
  padding: 8px 16px;
  background-color: var(--agent-panel-alt); /* #fffef0 */
  border: 1px solid var(--agent-border);
  border-radius: 6px;
  margin: 12px 16px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
}

.meta-item {
  display: flex;
  align-items: center;
}

.meta-label {
  color: var(--agent-text-dim);
  width: 80px;
}

.meta-value {
  color: var(--agent-text);
  font-weight: 500;
  font-family: var(--agent-mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 440px;
}

.modal-command-box-wrapper {
  position: relative;
  margin: 12px 16px;
  border: 1px solid var(--agent-border);
  border-radius: 8px;
  background-color: var(--agent-bg); /* 米黄底色 */
  overflow: hidden;
}

.modal-command-pre {
  margin: 0;
  padding: 14px;
  max-height: 250px;
  overflow-y: auto;
  font-family: var(--agent-mono);
  font-size: 13px;
  color: var(--agent-text);
  white-space: pre-wrap;
  word-break: break-all;
  line-height: 1.5;
}

.command-copy-btn {
  position: absolute;
  top: 8px;
  right: 8px;
  background-color: var(--agent-panel-alt);
  border: 1px solid var(--agent-border);
  color: var(--agent-text);
  padding: 3px 8px;
  font-size: 11px;
  border-radius: 4px;
  cursor: pointer;
  opacity: 0.8;
}
.command-copy-btn:hover {
  opacity: 1;
  border-color: var(--agent-border-strong);
}

.modal-command-warning {
  margin: 8px 16px;
  font-size: 12px;
  color: var(--agent-error);
  font-weight: 600;
  background-color: rgba(192, 57, 43, 0.05);
  padding: 8px 12px;
  border-radius: 6px;
  border-left: 3px solid var(--agent-error);
}

.modal-btn--confirm-execute {
  background-color: var(--agent-success);
  color: #ffffff;
  border: none;
  font-weight: 600;
  padding: 8px 16px;
  border-radius: 6px;
  cursor: pointer;
}
.modal-btn--confirm-execute:hover {
  opacity: 0.9;
}
```

---

## 7. 实施路线图与还原检查单 (Roadmap & Checklist)

请按照以下顺序执行此部分的重构：

- [ ] **Step 1: 移除独立窗口注册**：清理 `src/main/windows.ts` 中的 `openSettingsWindow()` 与 `settingsWindow` 全局对象，确保设置界面不会再新开独立 Electron 窗口。
- [ ] **Step 2: 状态机与视图绑定**：在 `Chat.tsx` 引入 `currentView` 状态，替换右侧渲染支路，并在切换会话、切换项目和新建会话时，自动回调将 `currentView` 切回 `'chat'`。
- [ ] **Step 3: 实现嵌入式 Settings**：重写设置页面装载方式，限制其 CSS 溢出为 `.settings-view-scroll` 内滚动，并设计顶部的 `◀ 返回聊天` 返回条。
- [ ] **Step 4: 编写 Sidebar 用户账户菜单**：
  - [ ] 在 `Sidebar.tsx` 的 Profile 头像卡片注册 `onClick`，展示绝对定位的浮层 `showAccountPopover`。
  - [ ] 预留置灰 `jhxlovelmm@gmail.com`、`个人帐户`、`个人资料`。
  - [ ] 绑定 `设置` 选项，触发 `onOpenSettings`，并在全局监听 `Cmd+,` / `Ctrl+,` 快捷键，将页面推入设置视图。
- [ ] **Step 5: 自定义指令确认桥接与渲染**：
  - [ ] 在主进程 `security.ts` 完成 `CHAT_CONFIRM_COMMAND` 桥接逻辑，增加对 `chatWindow` 活跃度校验与安全超时定时器。
  - [ ] 扩展 `Modal.tsx` 数据结构，并在 `ModalDialog` 中编写 `confirm-command` 对应的渲染代码，支持超长指令限高滚动和一键复制。
  - [ ] 在前端入口绑定 `trigger` 回调反馈，以完成敏感指令的阻拦确认。
- [ ] **Step 6: 样式打磨与回归测试**：
  - [ ] 导入 `Chat.css` 的新 CSS 变量与主题颜色，删除旧的抽屉和单栏排版样式。
  - [ ] 校验并修复拖拽移动、透明点击穿透（小猫和气泡）在无边框一体化窗口下的表现。
  - [ ] 确认快捷键（如 `⌘9` 等）与侧边栏选中态完全同步。

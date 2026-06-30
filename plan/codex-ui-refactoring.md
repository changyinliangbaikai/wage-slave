# 小小牛马客户端 Codex 风格交互界面重构方案

> **方案状态**：待评审/可执行  
> **重构目标**：将小小牛马（xiao-niu-ma）的对话与项目管理界面，重构为类似于 Codex 客户端的**双栏工作台布局**。  
> **设计约束**：**保留原有的“暖米黄配方”与“橙棕猫咪”暖色调风格**，仅对界面的排版、布局、树状交互、卡片组件及输入区进行结构性重构，不引入暗色主题。  
> **核心特征**：一体化无边框窗口、左侧常驻多维项目/会话导航栏、右侧温暖对话流、卡片式附件/大文件预览、Git 式文件变更审核卡片，以及底部浮动胶囊式输入框。

---

## 1. 界面与交互架构设计 (UI & UX Architecture)

### 1.1 布局重构对比

```
[现有布局]：扁平单栏 (暖米黄卡片式)
┌────────────────────────────────────────────────────────┐
│ 顶部：🐱 小小牛马 | 项目下拉切换 📁 | 新会话 | 历史抽屉    │
├────────────────────────────────────────────────────────┤
│                                                        │
│ 消息流 (滚动区，浅色卡片式)                           │
│                                                        │
├────────────────────────────────────────────────────────┤
│ 底部：附件列表 (平铺) + 矩形输入框 (带有发送/停止)      │
└────────────────────────────────────────────────────────┘

[Codex 风格布局]：双栏常驻工作台 (继承暖米黄配色)
┌──────────────────────┬─────────────────────────────────┐
│ ◀ ▶  新建  搜索  插件 │ 📁 梳理项目全貌 ...  [5.5超高 ▾]   │
├──────────────────────┼─────────────────────────────────┤
│ 项目                 │                                 │
│ 📁 mark-eight-octo   │ Bullet 列表与 橙/棕排版回复...   │
│ 📁 xiao-niu-ma (激活)│                                 │
│   📄 生成测试Excel ⌘9 │ ┌─────────────────────────────┐ │
│   📄 梳理项目全貌 2周 │ │ 📄 architecture.md  [打开方式▾]│ │
│                      │ └─────────────────────────────┘ │
│ 2025                 │ ┌─────────────────────────────┐ │
│ 📁 mark-twelve-duck  │ │ 🛠️ 已编辑 13 个文件   [撤销] [审核]│ │
│                      │ └─────────────────────────────┘ │
│ 对话                 │                                 │
│ 💬 Say hello   16h   │        ┌──────────────────┐     │
├──────────────────────┤        │  要求后续变更    │     │
│ 👤 jhxstudio    [⚙]  │        │ + 帮我审批▾  5.5▾│     │
│    Plus              │        └──────────────────┘     │
└──────────────────────┴─────────────────────────────────┘
```

### 1.2 暖色视觉设计变量映射 (Theme Color Mapping)

利用原本定义在 `Chat.css` 中的 `--agent-*` 配色变量，建立与 Codex 布局组件的映射：

| 视觉概念 | 原有变量名 | 默认颜色值 (暖米黄配方) | 对应 Codex 布局应用 |
| :--- | :--- | :--- | :--- |
| **主背景色** | `--agent-bg` | `#f7f5ef` (米黄纸张) | 右侧主聊天区背景、代码块背景 |
| **侧边栏背景** | `--sidebar-bg` [NEW] | `#ede9de` (略深的温暖卡其) | 左侧常驻导航栏，与聊天区拉开层次 |
| **面板/卡片背景** | `--agent-panel` | `#fffef7` (暖乳白) | 附件文件卡片、Git 变更卡片、弹出菜单、抽屉 |
| **输入框/胶囊背景**| `--agent-panel-alt`| `#fffef0` (微黄乳白) | 底部浮动胶囊输入框、按钮背景 |
| **边框主色** | `--agent-border` | `#e5e0d1` (温暖浅卡其) | 所有分栏分割线、卡片边框、输入框边框 |
| **边框强化色** | `--agent-border-strong` | `#d6cdb6` (中卡其) | 聚焦状态边框、激活元素边框 |
| **文字主色** | `--agent-text` | `#3a2a1a` (深咖啡/深棕) | 正文字体、图标主色 |
| **文字副色** | `--agent-text-dim` | `#8b7a5d` (暖秋灰) | 辅助信息、时间戳、未激活按钮 |
| **主品牌色 (橙)** | `--agent-primary` | `#c0733a` (牛马橙棕) | 激活的项目树节点、发送图标、高亮提示 |
| **草绿 (成功)** | `--agent-success` | `#5a8f3c` (抹茶绿) | 文件新增指标、审核通过按钮、正常状态 |
| **砖红 (警示)** | `--agent-error` | `#c0392b` (暖砖红) | 文件删除指标、撤销操作按钮、报错状态 |

---

## 2. 主进程窗口配置优化 (Main Process Config)

为了呈现一体化双栏，需在主进程中隐藏原生窗口标题栏，由前端来渲染可拖动区域。

**修改文件**：`src/main/windows.ts`
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

---

## 3. 前端组件重构详细方案 (Frontend Components Redesign)

### 3.1 页面主体布局调整

**修改文件**：`src/renderer/src/pages/Chat.tsx` 与 `src/renderer/src/pages/Chat.css`
删除现有的 Project / Session 抽屉，页面整体重构为 flex 双栏常驻布局：

```html
<div className="codex-layout">
  {/* 左侧侧边栏 (常驻) */}
  <Sidebar
    projects={projects}
    currentProjectId={projectId}
    currentSessionId={sessionId}
    sessions={sessions}
    onSwitchProject={switchProject}
    onLoadSession={loadSession}
    onNewSession={newSession}
  />
  
  {/* 右侧主聊天区 */}
  <div className="codex-main-pane">
    <ChatHeader ... />
    <MessageList ... />
    <ChatFooter ... />
  </div>
</div>
```

---

### 3.2 左侧侧边栏设计 (Sidebar.tsx [NEW])

**职责**：管理项目树形选择、历史会话与系统入口。
**物理路径**：`src/renderer/src/components/chat/Sidebar.tsx`

#### 3.2.1 结构与布局细节
1. **Header 导航控制区**：
   - 包含 macOS 交通灯占位区（`-webkit-app-region: drag`，宽度 `80px`，使用该区域可拖拽窗口）。
   - 导航历史箭头（返回/前进，绑定路由或会话状态切换）。
   - 快捷动作组：
     - `新建对话`（触发 `newSession()`）
     - `搜索`（过滤会话历史）
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
   - 显示圆形头像，用户名称 `jhxstudio`，等级标签 `Plus`。
   - 右侧常驻 `齿轮[⚙]` 按钮，点击调用主进程 `openSettings()`。

---

### 3.3 右侧聊天头 (ChatHeader.tsx [NEW])

**职责**：展示当前会话标题与全局模型控制。
**物理路径**：`src/renderer/src/components/chat/ChatHeader.tsx`

- **会话标题**：显示当前 Session Title，旁边附带 `...` 菜单，包含：重命名、归档、物理压缩（`/compact`）、删除会话。
- **窗口可拖拽区**：中间空白区设置 `flex: 1` 和 `-webkit-app-region: drag`，以便双击或拖拽移动窗口。
- **大模型选择器 (Model Dropdown)**：
  - 圆角按钮，带有蓝色机器人/大脑图标，文字为当前预设（如 `5.5 超高` 或具体模型名称如 `DeepSeek-V3`）。
  - 点击弹出浮层，展示常用模型白名单，可快捷写入 `llm_model` 配置。
- **分栏与侧边栏控制**：右侧常驻布局切换按钮，用于折叠/展开左侧侧边栏、开启多视窗调试等。

---

### 3.4 消息渲染卡片化 (Message Elements Redesign)

重点对消息列表中的 **“文件附件卡片”** 和 **“文件变更（Git Diff）卡片”** 进行高质感拟物化改造。

#### 3.4.1 文件附件卡片 (FileCard.tsx [NEW])
在 Agent 输出中若关联了特定文件，或者用户上传了附件，渲染为独立卡片形式。

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
- **交互逻辑**：下拉菜单改变时，触发 Electron 本地打开动作（如调用主进程 `open_file` 工具）。

#### 3.4.2 文件变更/提交审核卡片 (GitChangeBox.tsx [NEW])
当 Agent 修改了项目中的文件后，会产生变更详情。在对话中以类似 Git 提交确认的卡片渲染。

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

### 3.5 胶囊式浮动输入框 (CapsuleInput.tsx [NEW])

**物理路径**：`src/renderer/src/pages/agent/AgentInput.tsx` (覆盖或替换为 `CapsuleInput.tsx`)

放弃现有的贴底方形输入框，改为居中浮动的胶囊形设计。
- **胶囊容器 (`.input-capsule-container`)**：
  - 宽度：自适应或固定 `max-width: 760px`，在右侧聊天区底部居中浮动，带有轻微的 `box-shadow`。
  - 圆角：`border-radius: 24px`，背景为 `#fffef0` (微黄乳白)，边框为 `1px solid #e5e0d1` (温暖浅卡其)。
- **输入区域 (`.input-capsule__textarea`)**：
  - 占位符提示词改为 `"要求后续变更"`。
  - 无边框，聚焦时无聚焦环，字体颜色 `#3a2a1a`，支持自动高度。
- **底部工具条 (`.input-capsule__toolbar`)**：
  - **左侧控制**：
    - `+` 号圆圈按钮（添加附件，触发 `pickFiles`）。
    - 药丸动作按钮（如：`帮我审批 ▾`，点击提供快捷预设 Slash 指令，如 `/plan`、`/compact`）。
  - **右侧控制**：
    - 推理/模型预设指示器（例如 `5.5 超高 ▾`，可快捷切换推理强度 `/effort`）。
    - 麦克风图标 🎤（用于引导视觉美感）。
    - 发送按钮：原型圆圈，背景 `#c0733a` (牛马橙棕)，中间为白色上箭头 `↑`。运行时替换为方块停止键 ⏹。

---

## 4. 样式表设计 (Tailored Theme CSS)

在 `src/renderer/src/pages/Chat.css` 中引入新布局及组件的样式。所有颜色依旧使用 `--agent-*` 配色系。

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

/* ==========================================================================
   Left Sidebar Styles
   ========================================================================== */
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
  /* 预留 macOS 交通灯控制区 */
  padding-left: 80px; 
}

.sidebar-nav-arrow {
  color: var(--agent-text-dim);
  cursor: pointer;
  padding: 4px;
}
.sidebar-nav-arrow:hover {
  color: var(--agent-text);
}

.sidebar-action-items {
  padding: 8px 16px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.sidebar-action-btn {
  display: flex;
  align-items: center;
  gap: 10px;
  background: none;
  border: none;
  color: var(--agent-text-dim);
  width: 100%;
  text-align: left;
  padding: 8px 12px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 14px;
}
.sidebar-action-btn:hover {
  background-color: var(--highlight-hover);
  color: var(--agent-text);
}

/* 树形列表组 */
.sidebar-tree-section {
  flex: 1;
  overflow-y: auto;
  padding: 12px 8px;
}

.tree-section-title {
  font-size: 11px;
  text-transform: uppercase;
  color: var(--agent-text-dim);
  padding: 8px 12px;
  font-weight: 700;
  letter-spacing: 0.5px;
}

.project-folder-node {
  padding: 6px 12px;
  display: flex;
  align-items: center;
  gap: 8px;
  border-radius: 6px;
  cursor: pointer;
  color: var(--agent-text);
  font-size: 13px;
}
.project-folder-node:hover {
  background-color: var(--highlight-hover);
}
.project-folder-node.is-active {
  background-color: var(--highlight-hover);
  font-weight: 600;
  border-left: 3px solid var(--agent-primary); /* 高亮左边条 */
}

/* 激活项目下的 Task Sessions 展开项 */
.project-sessions-sublist {
  margin-left: 20px;
  border-left: 1px solid var(--agent-border);
  padding-left: 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.session-node-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 10px;
  border-radius: 4px;
  cursor: pointer;
  color: var(--agent-text-dim);
  font-size: 13px;
}
.session-node-item:hover {
  background-color: var(--highlight-hover);
  color: var(--agent-text);
}
.session-node-item.is-selected {
  background-color: var(--highlight-hover);
  color: var(--agent-text);
}

.session-node-meta {
  font-size: 11px;
  color: var(--agent-text-dim);
}

/* 用户 Profile */
.sidebar-user-panel {
  padding: 16px;
  border-top: 1px solid var(--agent-border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  background-color: var(--agent-panel-alt);
}

.user-panel__info {
  display: flex;
  align-items: center;
  gap: 10px;
}

.user-panel__avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: var(--agent-border-strong);
  color: var(--agent-text);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: bold;
}

.user-panel__name-group {
  display: flex;
  flex-direction: column;
}
.user-panel__name {
  font-size: 13px;
  font-weight: 600;
}
.user-panel__tag {
  font-size: 10px;
  color: var(--agent-primary); /* Plus 标签高亮 */
  font-weight: bold;
}

.user-panel__settings-btn {
  background: none;
  border: none;
  color: var(--agent-text-dim);
  cursor: pointer;
}
.user-panel__settings-btn:hover {
  color: var(--agent-text);
}

/* ==========================================================================
   Right Main Pane Styles
   ========================================================================== */
.codex-main-pane {
  flex: 1;
  display: flex;
  flex-direction: column;
  height: 100%;
  background-color: var(--agent-bg);
}

/* 右侧标题头 */
.pane-header {
  height: 52px;
  border-bottom: 1px solid var(--agent-border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 20px;
  background-color: var(--agent-panel);
}

.pane-header__title {
  font-size: 15px;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 8px;
}

.pane-header__actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

/* 顶部的模型选择下拉按钮 */
.model-dropdown-trigger {
  background-color: var(--agent-panel-alt);
  border: 1px solid var(--agent-border);
  color: var(--agent-text);
  padding: 6px 12px;
  border-radius: 16px;
  font-size: 12px;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 6px;
}
.model-dropdown-trigger:hover {
  border-color: var(--agent-border-strong);
}

/* ==========================================================================
   卡片化 Message Elements
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

/* ==========================================================================
   胶囊式浮动输入框 Styles
   ========================================================================== */
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
```

---

## 5. 对接状态与逻辑调整 (State & Logic Binding)

前端布局和 UI 切换后，状态层需做微调以支持双栏常驻操作。

### 5.1 项目列表与会话绑定
1. **侧边栏加载会话时**：
   - 现有的 `listChatSessions` 仅根据当前的 `projectId` 返回该项目的会话列表。
   - 修改侧边栏状态流：侧边栏组件中不仅存储当前选中项目的 `sessions`，还需维护一个 `Record<string, ChatSessionMeta[]>`，在项目节点被折叠/展开时，按需调用 `listChatSessions({ projectId })` 加载缓存，以避免一次性加载所有项目会话造成卡顿。
2. **新建会话归属项目绑定**：
   - 侧边栏中点击某特定项目下的 `+` 快捷键，或者点击顶部的 `新建对话` 时，新建会话所绑定的 `projectId` 必须为当前侧边栏选中（激活）的项目的 `id`。

### 5.2 撤销与审核操作的 IPC 绑定
为了完美实现 Git 变更卡片中的 **“撤销”** 和 **“审核”** 操作：
1. **撤销变更**：通过 IPC 通道向主进程发起请求，调用本地 git 回滚或用文件的备份覆盖，恢复代码变动。
2. **审核变更**：标记该轮的修改已通过用户审批，通知后台 Agent 准备接受下一个指令或结束任务。

---

## 6. 实施路线图与完美还原检查单 (Roadmap & Checklist)

为了能够使用 Codex 或 Antigravity 完美实现该需求，请按以下步骤逐一执行：

### Step 1: 基础配置与窗口设置
- [ ] 修改 `src/main/windows.ts` 中的 `openChatWindow()`，加入 `titleBarStyle: 'hidden'`, `trafficLightPosition`。
- [ ] 确保 `backgroundColor` 仍然设置为 `#f7f5ef` (米黄背景)。

### Step 2: 编写侧边栏组件
- [ ] 在 `src/renderer/src/components/chat/Sidebar.tsx` 创建侧边栏，完成项目、历史会话以及用户 Profile 的 UI。
- [ ] 支持点击切换项目、点击加载会话、双击折叠逻辑。
- [ ] 使用 `var(--sidebar-bg)` （`#ede9de`）作为背景色，字体使用 `var(--agent-text)` 咖啡色。

### Step 3: 重构 Chat.tsx 入口与头部
- [ ] 重构 `Chat.tsx` 页面，将顶层包裹层替换为双栏布局 `<div className="codex-layout">`。
- [ ] 移除旧的 `ProjectsDrawer` 与 `SessionsDrawer` 抽屉。
- [ ] 实现顶部的模型选择下拉按钮，集成当前 `llm_model` 的查询与设置。

### Step 4: 文件与变更审核卡片实现
- [ ] 封装 `<FileCard>` 组件，支持点击调用本地打开。
- [ ] 封装 `<GitChangeBox>` 组件，显示文件列表、变化行数，并注册撤销/审核对应的按钮事件。
- [ ] 修改 `MessageItem` 渲染判断逻辑：若发现助理回复包含文件属性，或带有变更元数据，自动升级渲染为对应的 Codex 式温暖拟物卡片。

### Step 5: 胶囊输入框替换
- [ ] 用 `<CapsuleInput>` 组件替换现有的 `<AgentInput>`。
- [ ] 还原其浮动胶囊外观、下方的药丸指令快捷键、模型与推理强度切换状态。背景使用 `#fffef0`。

### Step 6: 样式打磨与回归测试
- [ ] 导入 `Chat.css` 的新 CSS 配置，确保与米黄暖色风格高度统一。
- [ ] 检验并修复拖拽移动、透明点击穿透（小猫和气泡）在无边框一体化窗口下的表现。
- [ ] 确认快捷键（如 `⌘9` 等）与侧边栏选中态完全同步。

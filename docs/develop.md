# 小小牛马 🐱

> 一只陪你上班的桌面像素橘猫助手

面向长期在电脑前工作的办公室人员，帮你记录每日工作计划、提醒适时休息、下班复盘任务完成情况，月末/季末一键生成 AI 工作总结。

![像素猫预览](imgs/cat_happy_2.png)

---

## 功能特性

- **晨间问候**：到达上班时间自动弹出，用自然语言输入今日计划，AI 自动解析为待办清单
- **休息提醒**：监测连续使用时长，超过阈值弹出提醒，支持「再等一会儿」
- **晚间复盘**：下班时弹出，对照待办清单确认完成情况并记录工作日志
- **周期总结**：月末/季末读取本地日志，调用 AI 一键生成工作总结
- **像素橘猫**：常驻桌面，可拖动，拖至屏幕边缘自动收起，支持多种动画状态
- **兼容主流 LLM**：支持所有 OpenAI API 格式的接口（OpenAI、Claude、DeepSeek、本地 Ollama 等）

---

## 技术栈

| 层级 | 技术 |
|------|------|
| 桌面框架 | Electron 29 |
| 前端 | React 18 + TypeScript |
| 构建工具 | electron-vite + Vite 5 |
| 打包 | electron-builder |
| 数据存储 | 本地 JSON 文件（`%APPDATA%/xiao-niu-ma/`） |
| API Key 安全存储 | keytar（系统凭证管理器） |

---

## 环境要求

- **Node.js** >= 18
- **npm** >= 9
- 开发平台：macOS / Windows 均可
- 生产运行：Windows 10 / 11

---

## 本地开发

### 1. 克隆项目

```bash
git clone https://github.com/your-username/xiao-niu-ma.git
cd xiao-niu-ma
```

### 2. 安装依赖

```bash
npm install
```

> 如果使用了 `iohook`（键鼠全局监听，用于休息提醒），还需要重新编译 native 模块：
> ```bash
> npx electron-rebuild -f -w iohook
> ```
> 未安装 `iohook` 时，程序会自动降级运行，不影响其他功能。

### 3. 启动开发模式

```bash
npm run dev
```

启动后橘猫会出现在屏幕角落，同时打开 DevTools 方便调试。

**Mac 用户可直接使用快速启动脚本：**

```bash
bash dev-mac.sh
```

### 4. 首次配置

启动后在系统托盘右键 → **设置**，填写以下信息：

| 配置项 | 说明 | 示例 |
|--------|------|------|
| LLM API URL | OpenAI 兼容格式的接口地址 | `https://api.openai.com/v1` |
| API Key | 对应服务的密钥 | `sk-...` |
| 模型名称 | 要调用的模型 | `gpt-4o` |
| 上班时间 | 晨间问候触发时间 | `09:00` |
| 下班时间 | 晚间复盘触发时间 | `18:00` |

---

## 构建与打包

### 仅编译（不打包）

```bash
npm run build
```

编译产物：
- `dist/` — Vite 构建的前端资源
- `dist-electron/` — TypeScript 编译后的主进程代码

### 打包为本地安装包

```bash
npm run dist
```

| 平台 | 产物 | 输出目录 |
|------|------|----------|
| Windows | `小小牛马-Setup-x.x.x.exe`（NSIS 安装包） | `release/` |
| macOS | `小小牛马-x.x.x.dmg` | `release/` |

> **注意**：从 macOS 交叉编译 Windows NSIS 安装包支持不稳定，建议直接在 Windows 机器打包，或使用下方的 GitHub Actions 自动构建。

### 类型检查

```bash
npm run typecheck
```

---

## GitHub Actions 自动构建

项目已配置 `.github/workflows/build.yml`，支持两种触发方式：

### 方式一：推送 Tag → 自动发布 Release

打完代码推送一个版本 Tag，Actions 自动在 Windows Runner 上构建并发布到 GitHub Releases：

```bash
# 确保代码已提交并推送
git add .
git commit -m "feat: xxx"
git push

# 打 Tag（格式必须为 v + 版本号）
git tag v1.0.0
git push origin v1.0.0
```

Actions 完成后，在仓库的 **Releases** 页面即可下载 `.exe` 安装包。

### 方式二：手动触发构建（不发布 Release）

适合在开发阶段测试构建是否正常：

1. 进入 GitHub 仓库页面
2. 点击顶部 **Actions** 标签
3. 左侧选择 **Build & Release**
4. 点击右侧 **Run workflow** 按钮
5. 构建完成后，在该次 workflow 运行详情页的 **Artifacts** 区域下载安装包（保留 30 天）

### 首次使用前的权限配置

Actions 需要写入权限才能创建 Release，进入仓库设置开启：

```
仓库 Settings → Actions → General → Workflow permissions
→ 选择 "Read and write permissions" → Save
```

`GITHUB_TOKEN` 由 GitHub 自动提供，无需手动配置。

### 代码签名（可选）

未签名的安装包在 Windows 上会触发 SmartScreen 警告（点击「更多信息」→「仍要运行」可绕过）。如需消除警告，购买 EV 代码签名证书后在仓库 Secrets 中配置：

| Secret 名称 | 说明 |
|-------------|------|
| `WIN_CSC_LINK` | Base64 编码的 `.p12` 证书文件 |
| `WIN_CSC_KEY_PASSWORD` | 证书密码 |

然后取消 `build.yml` 中对应行的注释即可生效。

---

## 项目结构

```
xiao-niu-ma/
├── .github/
│   └── workflows/
│       └── build.yml          # GitHub Actions 自动构建配置
├── src/
│   ├── main/                  # Electron 主进程
│   │   ├── index.ts           # 入口，初始化所有模块
│   │   ├── windows.ts         # 窗口管理（透明窗口 + 边缘收起）
│   │   ├── tray.ts            # 系统托盘
│   │   ├── scheduler.ts       # 上下班时间定时触发器
│   │   ├── activity-monitor.ts # 键鼠活跃监测（休息提醒）
│   │   ├── store.ts           # 本地 JSON 数据读写（原子写入）
│   │   ├── ipc-handlers.ts    # IPC 事件处理器
│   │   ├── llm-service.ts     # LLM 服务封装
│   │   ├── docx-export.ts     # Word 文档导出功能
│   │   └── tools/             # 工具类
│   │       ├── index.ts
│   │       └── spell-check.ts # 拼写检查工具
│   ├── preload/
│   │   └── index.ts           # 安全桥接主进程与渲染进程
│   ├── renderer/src/          # React 前端
│   │   ├── App.tsx            # 根组件（流程调度 + IPC 监听）
│   │   ├── components/
│   │   │   ├── PixelCat/      # 像素猫组件 + 动画状态机
│   │   │   ├── SpeechBubble/  # 像素风说话气泡
│   │   │   ├── ContextMenu.tsx # 右键菜单组件
│   │   │   ├── TodoList/      # 待办列表组件
│   │   │   └── Tools/         # 工具面板组件
│   │   │       ├── SpellCheck/
│   │   │       ├── ToolCard.tsx
│   │   │       ├── ToolsPanel.tsx
│   │   │       └── index.ts
│   │   ├── pages/
│   │   │   ├── MorningFlow.tsx   # 晨间问候流程
│   │   │   ├── BreakReminder.tsx # 休息提醒流程
│   │   │   ├── EveningFlow.tsx   # 晚间复盘流程
│   │   │   ├── SummaryFlow.tsx   # 周期总结流程
│   │   │   ├── LogViewer.tsx     # 日志查看器
│   │   │   └── Settings.tsx      # 设置页面
│   │   └── hooks/
│   │       ├── useIPC.ts      # IPC 通信封装
│   │       └── useLLM.ts      # LLM 调用（计划解析 + 流式总结）
│   └── shared/
│       ├── types.ts           # 主进程与渲染进程共享类型
│       └── ipc-channels.ts    # IPC channel 名称常量
└── assets/
    ├── icon.icns              # macOS 应用图标
    ├── icon.ico               # Windows 应用图标
    ├── tray-icon.png          # 系统托盘图标
    └── pixel_cat/             # 像素猫 Sprite Sheet 素材
```

---

## 数据存储

所有数据本地存储，不上传任何服务器：

```
%APPDATA%\xiao-niu-ma\          (Windows)
~/Library/Application Support/xiao-niu-ma/   (macOS 开发时)
├── config.json                 # 用户配置（不含 API Key）
├── state.json                  # 每日触发状态
├── logs\
│   ├── 2026-04-03.json         # 每日工作日志
│   └── ...
└── todos\
    ├── 2026-04-03.json         # 每日待办清单
    └── ...
```

API Key 单独存储于系统凭证管理器（Windows Credential Manager / macOS Keychain），不写入任何文件。

---

## 常见问题

**Q：休息提醒没有效果？**
A：休息提醒依赖 `iohook` 全局键鼠监听。如果未安装，可执行 `npm install iohook && npx electron-rebuild -f -w iohook`。若被杀毒软件拦截，请将应用目录加入白名单。

**Q：安装时提示"Windows 已保护你的电脑"？**
A：点击「更多信息」→「仍要运行」即可。这是因为应用暂未添加代码签名证书，不影响正常使用。

**Q：支持哪些 LLM 服务？**
A：所有兼容 OpenAI API 格式的服务均可使用，包括 OpenAI、Azure OpenAI、Claude（通过兼容层）、DeepSeek、月之暗面、本地 Ollama 等。

**Q：如何备份工作日志？**
A：直接复制 `%APPDATA%\xiao-niu-ma\logs\` 目录即可，均为标准 JSON 文件。

---

## License

MIT

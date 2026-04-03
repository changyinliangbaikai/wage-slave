# 小小牛马 - 开发启动说明

## 环境要求

- Node.js >= 18
- npm >= 9
- Windows 10 / 11（开发和运行均在 Windows 上）

## 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 开发模式（热更新）
npm run dev

# 3. 构建生产包
npm run build

# 4. 打包为 Windows 安装程序（.exe）
npm run dist
```

## 目录结构

```
xiao-niu-ma/
├── src/
│   ├── main/            # Electron 主进程
│   │   ├── index.ts     # 入口，初始化所有模块
│   │   ├── windows.ts   # 窗口创建与边缘收起
│   │   ├── tray.ts      # 系统托盘
│   │   ├── scheduler.ts # 上下班时间触发器
│   │   ├── activity-monitor.ts  # 键鼠活跃监测
│   │   ├── store.ts     # 本地 JSON 数据读写
│   │   └── ipc-handlers.ts      # IPC 事件处理
│   ├── preload/
│   │   └── index.ts     # 安全桥接 IPC
│   ├── renderer/src/    # React 前端
│   │   ├── App.tsx      # 根组件（流程调度）
│   │   ├── components/
│   │   │   ├── PixelCat/        # 像素猫动画
│   │   │   └── SpeechBubble/    # 说话气泡
│   │   ├── pages/
│   │   │   ├── MorningFlow.tsx  # 晨间问候
│   │   │   ├── BreakReminder.tsx # 休息提醒
│   │   │   └── EveningFlow.tsx  # 晚间复盘
│   │   └── hooks/
│   │       ├── useIPC.ts        # IPC 封装
│   │       └── useLLM.ts        # LLM 调用
│   └── shared/
│       ├── types.ts             # 共享类型
│       └── ipc-channels.ts      # IPC channel 常量
└── assets/
    └── pixel_cat/       # 像素猫 Sprite Sheet

```

## 首次运行配置

启动后在系统托盘右键 → 设置：
1. 填写 LLM API URL（如 `https://api.openai.com/v1`）
2. 填写 API Key
3. 选择模型名称（如 `gpt-4o`）
4. 设置上班/下班时间

## 休息提醒功能说明

休息提醒依赖 `iohook` 库的全局键鼠监听。如果功能不生效，请执行：

```bash
npm install iohook --save
npx electron-rebuild -f -w iohook
```

> 注意：iohook 可能被杀毒软件拦截，建议将应用目录加入白名单。

## 数据存储位置

所有数据存储在 `%APPDATA%\xiao-niu-ma\` 目录下：
- `config.json`：用户配置
- `logs\YYYY-MM-DD.json`：每日工作日志
- `todos\YYYY-MM-DD.json`：每日待办清单

# 更新日志

本文档记录小小牛马的版本更新历史。

## [2.1.0] - 2026-06-04

### 新增功能
- **Agent 系统**
  - 新增 AI Agent 功能，支持多轮对话和工具调用
  - Agent 可执行文件操作、命令执行、小牛马数据读写、定时任务管理等工具
  - 支持自然语言输入，Agent 自主规划并调用工具完成任务
  - 新增 Agent 会话管理，支持创建、删除、重命名会话
  - 新增 Agent 上下文压缩，自动摘要历史消息避免 token 爆炸

- **Agent Cron**
  - 新增独立 Agent Cron 模块，使用 `{userData}/agent-cron/tasks.json` 持久化并独立调度
  - 支持在时间触发后让 Agent 自主规划和执行
  - 新增自然语言解析，输入"每天早上 8 点提醒我喝水"自动生成任务草稿
  - 新增 Agent 任务模板，快速创建常见任务（晨间问候、工作总结等）
  - 支持旧定时任务一键迁移到 Agent Cron，可选择保留或停用原任务，重复迁移会自动跳过已迁移任务
  - Agent Cron 执行后广播事件，UI 自动刷新

- **安全增强**
  - 命令黑名单升级，阻止 crontab、launchctl、systemd-run 等系统调度命令
  - 新增用户二次确认机制，危险命令需用户确认后执行
  - 新增 Agent 工具权限开关，用户可在设置页按组启用/禁用工具
  - 新增 Agent 路径白名单扩展，用户可在设置页添加额外允许访问目录
  - 新增 Agent 专用模型配置，可独立配置 API URL 和模型名称
  - 新增写入类工具审计日志，记录到 `{userData}/agent-audit/YYYY-MM-DD.jsonl`

- **体验优化**
  - Agent 运行时小猫自动切换 busy 动画
  - Agent 任务执行状态实时更新，UI 显示执行进度
  - Agent 工具调用卡片显示只读 / 写入 / 敏感安全级别
  - Skill 市场支持搜索、分类筛选、详情查看和一键安装
  - 已安装 Skill 支持 JSON 配置，配置会随 Skill Prompt 注入 Agent
  - 修复 Agent 任务 abort 误判为成功的问题

### 改进
- 重构 Agent 架构，分离 orchestrator、tool-executor、security 等模块
- 新增 Agent 全局活跃状态追踪，用于驱动 UI 动画
- 优化定时任务日志编码，解决跨平台中文乱码问题
- 新增 Agent 活跃状态 IPC 通道，主进程向渲染进程广播状态变化
- 新增 AgentSettings、SkillManager、SkillMarket 独立组件，匹配 Agent 模块化 UI 结构

### 技术栈
- Electron 29
- React 18 + TypeScript
- electron-vite + Vite 5
- electron-builder

## [2.0.0] - 2026-04-14

### 新增功能
- 添加小工具箱功能
  - 错别字检查工具
  - 定时任务管理工具
  - 任务日志查看器
- 添加发布流程 workflow 文档
  - 固化发布流程，便于版本管理
  - 支持自动从 CHANGELOG 读取 Release 内容

### 改进
- 重构文档结构，添加开发指南
- 优化 GitHub Actions 自动构建和发布流程
- Release 内容自动从 CHANGELOG 读取
- 修复 README 图片预览路径
- 修复 GitHub Actions release 权限问题
- 补充发布流程，添加修改 package.json 版本号步骤
- 修复 Windows 下定时任务日志中文乱码问题

### 技术栈
- Electron 29
- React 18 + TypeScript
- electron-vite + Vite 5
- electron-builder

## [1.0.0] - 2026-04-01

### 初始版本
- 晨间问候：到达上班时间自动弹出，用自然语言输入今日计划
- 休息提醒：监测连续使用时长，超过阈值弹出提醒
- 晚间复盘：下班时弹出，对照待办清单确认完成情况
- 周期总结：月末/季末读取本地日志，调用 AI 一键生成工作总结
- 像素橘猫：常驻桌面，可拖动，拖至屏幕边缘自动收起
- 兼容主流 LLM：支持所有 OpenAI API 格式的接口

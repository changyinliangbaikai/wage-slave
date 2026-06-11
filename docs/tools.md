# 小工具模块文档

小小牛马内置了一些实用的小工具，帮助你提高工作效率。

## 工具列表

### 1. 错别字检查 ✏️

智能检查中文文本中的错别字和词语错误问题。

**功能特性：**
- 支持直接输入文本或打开文件检查
- 支持多种文件格式：txt、md、docx、doc
- 使用 LLM 进行智能错别字检测
- 自动定位错误位置并显示上下文
- 提供修正建议和理由
- 智能校准 LLM 返回的位置信息，确保高亮准确

**使用场景：**
- 工作报告、文档撰写后的校对
- 邮件、聊天消息发送前的检查
- 长文本内容的快速审查

**技术实现：**
- 前端：`src/renderer/src/components/Tools/SpellCheck/SpellCheckPanel.tsx`
- 后端：`src/main/tools/spell-check.ts`
- 使用 mammoth 库解析 Word 文档
- 调用配置的 LLM API 进行错别字检测

---

### 2. 定时任务 ⏰

创建和管理定时执行的任务，自动在指定时间执行命令。

**功能特性：**
- **多种调度方式：**
  - 间隔执行：每 N 分钟执行一次
  - 每日执行：每天固定时间执行
  - 每周执行：每周固定星期和时间执行
- **任务管理：**
  - 创建、编辑、删除任务
  - 启用/禁用任务
  - 手动立即执行任务
- **执行监控：**
  - 实时显示任务状态（运行中/成功/失败）
  - 查看任务执行日志
  - 显示上次执行时间和耗时
  - 任务完成后发送系统通知
- **工作目录：**
  - 支持设置命令执行的工作目录
  - 可视化目录选择器

**使用场景：**
- 定期数据备份脚本
- 定时清理临时文件
- 定期运行测试脚本
- 定时发送报告邮件
- 定时同步数据

**技术实现：**
- 前端：`src/renderer/src/components/Tools/Scheduler/SchedulerPanel.tsx`
- 后端：`src/main/tools/task-scheduler.ts`
- 使用 `child_process.spawn` 执行命令
- 基于 `setInterval` 的调度引擎（每 30 秒检查一次）
- 任务数据持久化到 JSON 文件
- 执行日志存储（保留最近 200 条）

**注意事项：**
- 启动时已错过的任务不会自动补跑，需要手动执行
- 正在运行的任务不会重复启动
- 日志输出限制为 5000KB，超出会自动截断

---

### 3. 文本格式化 📝

（敬请期待）

---

### 4. 翻译工具 🌐

（敬请期待）

---

## 数据存储

### 定时任务数据

```
%APPDATA%\xiao-niu-ma\scheduler\          (Windows)
~/Library/Application Support/xiao-niu-ma/scheduler/   (macOS)
├── tasks.json                 # 任务配置
└── logs\                      # 执行日志
    ├── task_xxx.json          # 每个任务的执行日志
    └── ...
```

---

## IPC 通道

小工具模块使用以下 IPC 通道进行通信：

### 错别字检查
- `TOOLS_OPEN_FILE_DIALOG` - 打开文件选择对话框
- `TOOLS_READ_FILE` - 读取本地文件内容
- `TOOLS_SPELL_CHECK` - 执行错别字检查

### 定时任务
- `SCHEDULER_LIST_TASKS` - 获取任务列表
- `SCHEDULER_SAVE_TASK` - 创建/更新任务
- `SCHEDULER_DELETE_TASK` - 删除任务
- `SCHEDULER_TOGGLE_TASK` - 启用/禁用任务
- `SCHEDULER_RUN_TASK` - 手动执行任务
- `SCHEDULER_GET_LOGS` - 获取任务执行日志
- `SCHEDULER_CLEAR_LOGS` - 清除任务执行日志
- `SCHEDULER_SELECT_DIR` - 选择工作目录

---

## 扩展开发

如需添加新的小工具，需要完成以下步骤：

1. **前端组件**
   - 在 `src/renderer/src/components/Tools/` 下创建新目录
   - 实现工具面板组件，接收 `onBack` 回调
   - 在 `ToolsPanel.tsx` 的 `TOOLS` 数组中添加工具配置

2. **后端实现**
   - 在 `src/main/tools/` 下创建实现文件
   - 导出必要的函数
   - 在 `src/main/ipc/tools.ts` 中注册 IPC handler；通用工具实现保留在 `src/main/tools/`

3. **类型定义**
   - 在 `src/shared/types.ts` 中添加相关类型
   - 在 `src/shared/ipc-channels.ts` 中添加 IPC 通道常量

4. **路由注册**
   - 在主进程的 IPC handler 注册中调用新工具的注册函数

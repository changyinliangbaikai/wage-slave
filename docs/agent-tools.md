# Agent 工具说明

本文档记录 Agent 当前可调用的工具、参数与安全边界。所有工具在主进程执行，调用前会经过工具开关、路径白名单或命令安全策略校验。

## 安全边界

- 文件路径仅允许访问 `userData`、桌面、文档、下载、临时目录、用户主目录下常见开发目录，以及用户在设置页额外添加的 Agent 白名单目录。
- `run_command` 会先经过命令黑名单，再弹出用户确认框；删除、移动、提权、系统定时、远程脚本管道执行等命令会直接拒绝，并记录审计摘要。
- 写入类工具会记录审计摘要到 `{userData}/agent-audit/YYYY-MM-DD.jsonl`。
- `read_file` 默认只读取 200 行，单次最多 1000 行；大文件应使用 `offset` 和 `max_lines` 分段读取，工具输出也会自动截断，避免占满上下文。
- Agent 工具卡片会显示安全级别：`只读`、`写入`、`敏感`。敏感工具包括命令执行和打开本地文件。

## 文件工具

| 工具 | 参数 | 示例 | 安全说明 |
|------|------|------|----------|
| `read_file` | `path`, `offset?`, `max_lines?` | 读取 `~/Documents/report.md` 前 200 行 | 路径必须在白名单内；默认 200 行，上限 1000 行 |
| `write_file` | `path`, `content` | 写入 `~/Documents/today.md` | 自动创建父目录；覆盖写入会审计 |
| `edit_file` | `path`, `old_string`, `new_string`, `replace_all?` | 精确替换文件中的一段文本 | 默认要求匹配唯一，避免误改 |
| `list_files` | `path`, `pattern?` | 列出桌面 `*.md` 文件 | 只列白名单目录 |
| `search_files` | `path`, `query`, `file_pattern?`, `max_results?` | 在文档目录搜索“周报” | 使用 Node 递归实现，不依赖 grep |

## 命令工具

| 工具 | 参数 | 示例 | 安全说明 |
|------|------|------|----------|
| `run_command` | `command`, `work_dir?`, `timeout_ms?` | `git status --short` | `spawn` 执行；黑名单 + 用户二次确认；默认 30 秒，最多 120 秒 |

## 小牛马数据工具

| 工具 | 参数 | 示例 | 安全说明 |
|------|------|------|----------|
| `get_today_log` | 无 | 查询今日日志 | 只读 |
| `get_todos` | 无 | 查询今日待办 | 只读；内部使用 `getTodos(todayStr())` |
| `save_todo` | `title`, `priority?`, `estimated_min?` | 新增“写周报”高优先级待办 | 写入待办与今日日志，会审计 |
| `update_todo` | `id`, `status?`, `title?`, `priority?` | 标记某条待办完成 | 需要先查询 id，会审计 |
| `append_log` | `content`, `append_to?` | 追加晚间复盘 | 目前仅支持 `eod_log`，会审计 |
| `get_logs_range` | `start_date`, `end_date` | 读取本周日志 | 只读 |

## 定时任务工具

> [!NOTE]
> 这里的定时任务工具（`scheduler_*`）操作的是普通定时任务管理器（用于周期性地在后台 `spawn` 执行 Shell 命令行）。
> Agent 定时任务（Agent Cron）已与此解耦，运行于独立的调度器中，不在此工具集的控制范围内。

| 工具 | 参数 | 示例 | 安全说明 |
|------|------|------|----------|
| `scheduler_list_tasks` | 无 | 查看全部定时任务 | 只读 |
| `scheduler_create_task` | `name`, `kind`, `schedule_type`, `user_input?`, `command?`, `work_dir?`, `interval_minutes?`, `time?`, `week_day?`, `enabled?` | 创建每天 9:30 的 Shell 脚本执行 | 写入 Shell 调度器，仅调度 Shell 任务，会审计 |
| `scheduler_update_task` | `id` 加要更新的字段 | 修改任务时间 | 会审计 |
| `scheduler_delete_task` | `id` | 删除任务 | 删除前应先由 Agent 向用户确认，会审计 |
| `scheduler_toggle_task` | `id` | 启用或停用任务 | 会审计 |

## 系统与流程工具

| 工具 | 参数 | 示例 | 安全说明 |
|------|------|------|----------|
| `open_file` | `path` | 用默认程序打开报告文件 | 路径必须在白名单内 |
| `show_notification` | `title`, `body` | 弹出完成通知 | 同时推送给小猫气泡 |
| `wait` | `ms` | 等待 1000ms | 最多 60000ms |

## Tool Calling / ReAct 降级

优先使用 OpenAI `tools/tool_calls` 协议。若模型或 API 明确拒绝工具参数，Agent 会自动重试普通对话，并要求模型输出：

```text
<tool_call>{"name":"工具名","arguments":{}}</tool_call>
```

编排器会解析该标签、执行工具，再把结果回灌给模型继续下一轮。降级模式下，历史里的 `tool_calls` 与 `role=tool` 会被投影成普通文本消息，避免不支持工具协议的 API 在第二轮继续报错。

## Skill 市场安装

市场索引支持两种条目：

- 完整 `AgentSkill` 对象：直接校验并安装。
- 带 `downloadUrl` 的条目：安装时下载远程 `skill.json` 或 zip，并复用 URL 安装的超时、体积上限与 `sha256` 校验逻辑。

已安装 Skill 支持保存一份 JSON 配置。配置写入 `{userData}/skills/installs.json`，命中 Skill 后会随 Skill Prompt 注入给 Agent，供技能执行时参考。

/**
 * IPC 处理器注册中心
 * 所有 renderer → main 的请求通过此处的专有业务子模块完成挂载
 */

import { registerConfigIPC } from './ipc/config'
import { registerDataIPC } from './ipc/data'
import { registerWindowIPC } from './ipc/window'
import { registerToolsIPC } from './ipc/tools'
import { registerSchedulerIPC } from './ipc/scheduler'
import { registerSkillIPC } from './ipc/skills'
import { registerAgentCronIPC } from './ipc/agent-cron'
import { registerProjectIPC } from './ipc/project'
import { registerChatIPC } from './ipc-handlers-chat'
import { initProjectStore } from './chat/project-store'

export function registerIPCHandlers(): void {
  // 0. 项目（Project）数据初始化：保证默认项目存在 + 目录就绪
  initProjectStore()

  // 1. 配置参数与安全密钥服务
  registerConfigIPC()

  // 2. 日志、待办、总结与大模型接口数据服务
  registerDataIPC()

  // 3. 窗口打开/隐藏行为及状态提醒
  registerWindowIPC()

  // 4. 辅助桌面小工具（拼写检查等）
  registerToolsIPC()

  // 5. 定时任务调度中心（Shell 定时）
  registerSchedulerIPC()

  // 6. Agent 技能商店与安全沙箱规则
  registerSkillIPC()

  // 7. 定时 Agent (Agent Cron) 独立控制面 (在其内部级联挂载 registerAttachmentIPC)
  registerAgentCronIPC()

  // 8. 项目（多工作区）管理
  registerProjectIPC()

  // 9. 统一对话管理中心 (整合了简单聊天与 Agent 回复)
  registerChatIPC()
}

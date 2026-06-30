// ─────────────────────────────────────────────
// 项目（Project）共享类型定义
//
// 多项目支持是 Agent 编程能力的基础：每个项目对应一个本地工作区目录，
// AgentOrchestrator 在执行工具时按会话所属 projectId 决定 cwd 与路径白名单。
// 默认项目 id 固定为 'default'，路径 ~/Documents/xiaoniuma/default。
// ─────────────────────────────────────────────

/** 单个项目记录 */
export interface Project {
  /** 唯一标识。默认项目为 'default'；自定义项目为 'proj_' + 时间戳 */
  id: string
  /** 项目展示名称 */
  name: string
  /** 项目所在本地绝对路径（必须是真实存在的目录） */
  path: string
  /** 创建时间戳（毫秒） */
  createdAt: number
  /** 是否置顶（可选） */
  pinned?: boolean
  /** 置顶时间戳（毫秒，用于排序，可选） */
  pinnedAt?: number
}

/** 默认项目 id（始终存在，不可删除） */
export const DEFAULT_PROJECT_ID = 'default'

/** 默认项目展示名 */
export const DEFAULT_PROJECT_NAME = '默认项目'

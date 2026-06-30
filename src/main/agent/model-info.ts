/**
 * 统一的模型识别模块
 *
 * 历史上 orchestrator.inferModelMaxTokens 与 context-compressor.getCompressConfig
 * 各自维护一份"模型名 → 上下文窗口/压缩阈值"的识别表，新增模型时极易只改一处
 * 导致显示占比与压缩阈值漂移。本模块集中导出模型族识别与上下文窗口查询，
 * 供上述两处复用，保证单一事实源。
 */

import { getConfig } from '../store'

/** 识别出的模型族（用于上下文窗口与压缩策略选择） */
export type ModelFamily =
  | 'gpt4o'      // GPT-4o / GPT-4-turbo / GPT-5 / o1 / o3 等 128k 窗口
  | 'claude'     // Claude 3 / 4 系列 200k 窗口
  | 'gemini'     // Gemini 128k 窗口
  | 'deepseek'   // DeepSeek 64k+ 窗口
  | 'qwen-max'   // qwen-max / qwen-plus 大窗口
  | 'moonshot'   // Moonshot / Kimi 128k 窗口
  | 'minimax'    // MiniMax 245k 窗口
  | 'qwen'       // 通用 Qwen 32k 窗口
  | 'unknown'    // 未识别，按保守 32k 处理

/**
 * 根据模型名识别所属模型族
 * 优先使用 Agent 专用模型配置，未配置则回退到主聊天模型
 */
export function detectModelFamily(model?: string): ModelFamily {
  const m = (model ?? '').toLowerCase()
  if (!m) return 'unknown'
  // 顺序敏感：更具体的匹配在前，避免被通用匹配吞掉
  if (m.includes('gpt-4o') || m.includes('gpt-4-turbo')) return 'gpt4o'
  if (m.includes('gpt-5') || m.includes('o1') || m.includes('o3')) return 'gpt4o'
  if (m.includes('claude-3') || m.includes('claude-4') || m.includes('claude')) return 'claude'
  if (m.includes('gemini')) return 'gemini'
  if (m.includes('deepseek')) return 'deepseek'
  if (m.includes('qwen-max') || m.includes('qwen-plus')) return 'qwen-max'
  if (m.includes('moonshot') || m.includes('kimi')) return 'moonshot'
  if (m.includes('minimax')) return 'minimax'
  if (m.includes('qwen')) return 'qwen'
  return 'unknown'
}

/** 各模型族的上下文窗口上限（tokens） */
const CONTEXT_WINDOW_BY_FAMILY: Record<ModelFamily, number> = {
  gpt4o: 128_000,
  claude: 200_000,
  gemini: 128_000,
  deepseek: 64_000,
  'qwen-max': 128_000,
  moonshot: 128_000,
  minimax: 245_760,
  qwen: 32_768,
  unknown: 32_768,
}

/**
 * 推断当前模型的上下文窗口上限（用于前端显示占比与压缩阈值计算）
 *
 * 优先级：
 *  1. 用户在设置页显式配置的 agent_context_window（> 0 时生效）
 *  2. 否则按模型名自动识别（agent_llm_model → llm_model）
 *
 * 显式配置可以解决：
 *  - 私有 / 自托管模型自动识别错误
 *  - 同名模型在不同厂商有不同的实际上下文窗口（如 32k vs 128k 版本）
 */
export function inferModelContextWindow(): number {
  const cfg = getConfig()
  // 1) 用户在设置页强制指定的上下文长度优先
  const overridden = Number(cfg.agent_context_window)
  if (Number.isFinite(overridden) && overridden > 0) {
    return Math.floor(overridden)
  }
  // 2) 回退到按模型名自动识别
  const model = cfg.agent_llm_model || cfg.llm_model
  const family = detectModelFamily(model)
  return CONTEXT_WINDOW_BY_FAMILY[family]
}

/** 给定模型名推断上下文窗口（供需要显式传 model 的场景使用，不读用户覆盖） */
export function contextWindowForModel(model: string): number {
  const family = detectModelFamily(model)
  return CONTEXT_WINDOW_BY_FAMILY[family]
}

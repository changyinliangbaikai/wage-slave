/**
 * 桌宠渲染引擎 - 内部类型定义
 *
 * 大部分核心类型来自 shared/types.ts（manifest schema、CatState 等），
 * 这里只额外补充引擎运行时的派生类型与帧资源结构。
 */

import type {
  CatState,
  PetManifest,
  PetAnimationSpec,
  ActivePetPack,
} from '@shared/types'

export type { CatState, PetManifest, PetAnimationSpec, ActivePetPack }

/** 4 个核心状态常量数组（前端运行时使用） */
export const PET_CORE_STATES: readonly CatState[] = [
  'idle',
  'petting',
  'celebrate',
  'busy',
] as const

/**
 * 引擎内部"已解析"的动画切片
 * - sprite 模式：source 已替换为可加载的 URL，且预加载完成
 * - frames 模式：每帧 URL 已预加载完成
 */
export interface ResolvedSpriteAnimation {
  type: 'sprite'
  /** 已 normalize 为 pet://... 的可加载 URL */
  sourceUrl: string
  startFrame: number
  frameCount: number
  fps: number
  loop: boolean
  /** 单帧像素宽（与 manifest.frame.width 相同，挂这里方便引擎使用） */
  frameW: number
  /** 单帧像素高 */
  frameH: number
  /** 排布方式 */
  layout: 'horizontal' | 'vertical'
}

export interface ResolvedFramesAnimation {
  type: 'frames'
  /** 已 normalize 的 URL 数组 */
  frameUrls: string[]
  fps: number
  loop: boolean
  frameW: number
  frameH: number
}

export type ResolvedAnimation = ResolvedSpriteAnimation | ResolvedFramesAnimation

/** 引擎内部"已解析"的桌宠包（供 animator/renderer 直接消费） */
export interface ResolvedPetPack {
  id: string
  name: string
  /** 4 个核心动作，缺失项已按 fallback 回填 */
  animations: Record<CatState, ResolvedAnimation>
  /** 单帧尺寸（manifest.frame.width/height） */
  frameW: number
  frameH: number
  /** 渲染缩放（manifest.frame.displayScale，默认 0.75） */
  displayScale: number
  /** 缺失某状态时的回退状态（manifest.fallback） */
  fallback: CatState
}

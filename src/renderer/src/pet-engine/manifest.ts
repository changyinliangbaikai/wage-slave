/**
 * Pet Pack manifest 解析 / 校验 / normalize
 *
 * - 主进程 pet-pack-store 已经把相对路径替换为 pet:// URL；
 *   引擎只负责语义层校验：必填字段、frame 尺寸合理性、idle 必须存在。
 * - 缺失的状态根据 fallback（默认 idle）回填，保证渲染时 4 个状态都可用。
 */

import type {
  ActivePetPack,
  CatState,
  PetAnimationSpec,
} from '@shared/types'
import {
  PET_CORE_STATES,
  type ResolvedAnimation,
  type ResolvedPetPack,
} from './types'

/** 校验/解析后抛出的错误 */
export class PetManifestError extends Error {
  constructor(msg: string) {
    super(`[PetManifest] ${msg}`)
    this.name = 'PetManifestError'
  }
}

/**
 * 把 ActivePetPack（含已 normalize 的 pet:// URL）解析为 ResolvedPetPack。
 * 不做网络/IO；只做结构校验与回退填充。
 */
export function resolveManifest(pack: ActivePetPack): ResolvedPetPack {
  const { manifest, baseUrl } = pack
  if (!manifest || manifest.schema !== 'xiaoniu-pet/v1') {
    throw new PetManifestError(`unsupported schema: ${manifest?.schema ?? '<missing>'}`)
  }
  const frameW = manifest.frame?.width
  const frameH = manifest.frame?.height
  if (typeof frameW !== 'number' || typeof frameH !== 'number' || frameW <= 0 || frameH <= 0) {
    throw new PetManifestError(`invalid frame size: ${frameW}x${frameH}`)
  }
  const displayScale = typeof manifest.frame.displayScale === 'number' && manifest.frame.displayScale > 0
    ? manifest.frame.displayScale
    : 0.75
  const fallback: CatState = manifest.fallback && PET_CORE_STATES.includes(manifest.fallback)
    ? manifest.fallback
    : 'idle'

  // idle 必填
  if (!manifest.animations || !manifest.animations.idle) {
    throw new PetManifestError(`animations.idle is required`)
  }

  // 先把已声明的动画解析出来；URL 由主进程注入 pet:// 前缀，这里假设 source / frames 已是可加载 URL
  const resolvedDeclared: Partial<Record<CatState, ResolvedAnimation>> = {}
  for (const state of PET_CORE_STATES) {
    const spec = manifest.animations[state]
    if (!spec) continue
    resolvedDeclared[state] = toResolved(spec, frameW, frameH, baseUrl)
  }

  // 缺失的状态用 fallback 回填（fallback 必然是 idle 或已存在的状态）
  const fallbackResolved = resolvedDeclared[fallback] ?? resolvedDeclared.idle
  if (!fallbackResolved) {
    // 既不在 fallback 又没 idle，理论上前面已抛错；这里兜底
    throw new PetManifestError(`fallback animation missing: ${fallback}`)
  }
  const animations = {} as Record<CatState, ResolvedAnimation>
  for (const state of PET_CORE_STATES) {
    if (resolvedDeclared[state]) {
      animations[state] = resolvedDeclared[state] as ResolvedAnimation
    } else {
      console.warn(`[PetManifest] animation "${state}" missing, fallback to "${fallback}"`)
      animations[state] = fallbackResolved
    }
  }

  return {
    id: manifest.id,
    name: manifest.name,
    animations,
    frameW,
    frameH,
    displayScale,
    fallback,
  }
}

/**
 * 单个动画 spec → ResolvedAnimation。
 * 注意：spec.source / spec.frames 已被主进程替换为 pet:// URL 或绝对 URL；
 *       若 spec 中是相对路径，则与 baseUrl 拼接（兜底，正常路径不会触发）。
 */
function toResolved(
  spec: PetAnimationSpec,
  frameW: number,
  frameH: number,
  baseUrl: string,
): ResolvedAnimation {
  if (spec.type === 'sprite') {
    if (!spec.source) throw new PetManifestError(`sprite animation missing 'source'`)
    if (!Number.isFinite(spec.startFrame) || spec.startFrame < 0) {
      throw new PetManifestError(`invalid startFrame: ${spec.startFrame}`)
    }
    if (!Number.isFinite(spec.frameCount) || spec.frameCount <= 0) {
      throw new PetManifestError(`invalid frameCount: ${spec.frameCount}`)
    }
    if (!Number.isFinite(spec.fps) || spec.fps <= 0) {
      throw new PetManifestError(`invalid fps: ${spec.fps}`)
    }
    return {
      type: 'sprite',
      sourceUrl: resolveUrl(spec.source, baseUrl),
      startFrame: spec.startFrame,
      frameCount: spec.frameCount,
      fps: spec.fps,
      loop: !!spec.loop,
      layout: spec.layout === 'vertical' ? 'vertical' : 'horizontal',
      frameW,
      frameH,
    }
  }
  // frames 模式
  if (!Array.isArray(spec.frames) || spec.frames.length === 0) {
    throw new PetManifestError(`frames animation missing 'frames'`)
  }
  return {
    type: 'frames',
    frameUrls: spec.frames.map(f => resolveUrl(f, baseUrl)),
    fps: spec.fps,
    loop: !!spec.loop,
    frameW,
    frameH,
  }
}

/** 已是绝对 URL（含 pet:// http(s):// file://）则原样返回，否则与 baseUrl 拼接 */
function resolveUrl(p: string, baseUrl: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p)) return p
  // baseUrl 末尾保证有 /；p 去掉开头 / 后拼接
  const base = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/'
  const rel = p.startsWith('/') ? p.slice(1) : p
  return base + rel
}

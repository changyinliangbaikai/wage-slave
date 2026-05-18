/**
 * Pet Engine 对外 API
 */

export { default as PetRenderer } from './PetRenderer'
export { PetAnimator } from './animator'
export { loadActivePet } from './loader'
export { resolveManifest, PetManifestError } from './manifest'
export { PET_CORE_STATES } from './types'
export type {
  CatState,
  PetManifest,
  PetAnimationSpec,
  ActivePetPack,
  ResolvedPetPack,
  ResolvedAnimation,
  ResolvedSpriteAnimation,
  ResolvedFramesAnimation,
} from './types'
export type { FramePayload, FrameCallback } from './animator'

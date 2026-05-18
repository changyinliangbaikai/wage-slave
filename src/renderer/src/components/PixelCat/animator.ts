/**
 * 历史兼容层：旧 CatAnimator 已被 pet-engine 的 PetAnimator 取代。
 *
 * 这里只重新导出别名，保证 `import { CatAnimator } from './components/PixelCat/animator'`
 * 等历史 import 仍能工作；新代码请直接 `import { PetAnimator } from '@/pet-engine'`。
 */

export { PetAnimator as CatAnimator } from '@/pet-engine'

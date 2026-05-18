/**
 * PixelCat - 桌宠渲染外观（对 pet-engine 的薄封装）
 *
 * 历史上这里持有 sprite 切片与状态机；现在已迁移到 `@/pet-engine`，
 * 本文件保留是为了保持 `import PixelCat from './components/PixelCat'` 的
 * 调用方代码不变；真正的渲染走 PetRenderer，资源由桌宠包 manifest 驱动。
 */

import type { CatState } from '@shared/types'
import { PetRenderer, type PetAnimator } from '@/pet-engine'
import './PixelCat.css'

interface Props {
  /** 外部强制状态（undefined = 由动画器自主管理） */
  state?: CatState
  onAnimatorReady?: (animator: PetAnimator) => void
}

export default function PixelCat({ state, onAnimatorReady }: Props) {
  return <PetRenderer state={state} onAnimatorReady={onAnimatorReady} className="pixel-cat" />
}

/**
 * 桌宠包加载器：从主进程 IPC 拉取激活包数据，解析 manifest，预加载所有图片。
 */

import type { ActivePetPack } from '@shared/types'
import { IPC } from '@shared/ipc-channels'
import { resolveManifest } from './manifest'
import type { ResolvedPetPack } from './types'

interface ElectronAPI {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
}

function getApi(): ElectronAPI | null {
  // 渲染进程注入到 window.electronAPI（preload）
  const w = window as unknown as { electronAPI?: ElectronAPI }
  return w.electronAPI ?? null
}

/** 拉取当前激活桌宠包，并完成 manifest 解析 + 图片预加载 */
export async function loadActivePet(): Promise<ResolvedPetPack> {
  const api = getApi()
  if (!api) throw new Error('[PetLoader] electronAPI 未就绪')
  console.log('[PetLoader] 请求激活包数据')
  const active = (await api.invoke(IPC.PETS_GET_ACTIVE)) as ActivePetPack | null
  if (!active) {
    throw new Error('[PetLoader] 主进程未返回激活包数据')
  }
  console.log('[PetLoader] 收到激活包:', active.meta.id, active.meta.scope)
  const resolved = resolveManifest(active)
  await preloadResolvedPack(resolved)
  console.log('[PetLoader] 资源预加载完成:', resolved.id)
  return resolved
}

/** 把已解析包里所有图片 URL 预加载完成（保证 animator 启动后第一帧不空白） */
async function preloadResolvedPack(pack: ResolvedPetPack): Promise<void> {
  const urls = new Set<string>()
  for (const anim of Object.values(pack.animations)) {
    if (anim.type === 'sprite') {
      urls.add(anim.sourceUrl)
    } else {
      anim.frameUrls.forEach(u => urls.add(u))
    }
  }
  await Promise.all(Array.from(urls).map(preloadImage))
}

function preloadImage(url: string): Promise<void> {
  return new Promise(resolve => {
    const img = new Image()
    img.onload = () => resolve()
    img.onerror = () => {
      console.warn('[PetLoader] 图片预加载失败:', url)
      resolve() // 失败也不阻塞，让渲染层用浏览器默认占位
    }
    img.src = url
  })
}

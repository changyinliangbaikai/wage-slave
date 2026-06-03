/**
 * 共享的 API Key 读取工具
 *
 * 历史上 keytar 加载与读取在 ipc-handlers.ts 内部以闭包形式存在；
 * 主进程其它模块（例如 task-scheduler 的 Agent 任务执行）也需要访问，
 * 因此抽出一个独立 helper 供复用，避免重复加载逻辑。
 *
 * 兼容：keytar 未安装时降级返回空串（开发场景）
 */

let keytar: typeof import('keytar') | null = null
try {
  keytar = require('keytar')
} catch {
  console.warn('[api-key] keytar 未安装，已降级；调用方请处理空 key')
}

const KEYTAR_SERVICE = 'xiao-niu-ma'
const KEYTAR_ACCOUNT = 'llm-api-key'

/** 读取已保存的 LLM API Key；未保存或 keytar 不可用时返回空串 */
export async function getStoredApiKey(): Promise<string> {
  if (!keytar) return ''
  try {
    return (await keytar.getPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT)) ?? ''
  } catch (e) {
    console.warn('[api-key] 读取 keytar 失败:', e)
    return ''
  }
}

/**
 * Skill 安装器
 *
 * 支持两种来源：
 *  1. 本地文件：选择一个 skill.json（或包含 skill.json 的目录）
 *  2. 远程 URL：下载一个 skill.json
 *
 * 所有安装都会经过 validateSkill 校验，落地到 user 目录并写安装记录。
 */

import * as fs from 'fs'
import * as path from 'path'
import log from 'electron-log/main'
import type { AgentSkill, SkillWithState } from '@shared/types'
import { saveUserSkill, validateSkill } from './store'

/** 远程下载大小上限（256KB，skill.json 不应很大） */
const MAX_REMOTE_BYTES = 256 * 1024
/** 远程请求超时 */
const FETCH_TIMEOUT_MS = 10_000

/**
 * 从本地文件安装 skill
 * @param filePath 指向 skill.json 的文件，或包含 skill.json 的目录
 */
export function installFromFile(filePath: string): SkillWithState {
  log.info('[Skill] 从本地文件安装:', filePath)

  let jsonPath = filePath
  const stat = fs.statSync(filePath)
  if (stat.isDirectory()) {
    jsonPath = path.join(filePath, 'skill.json')
    if (!fs.existsSync(jsonPath)) {
      throw new Error(`目录中未找到 skill.json: ${filePath}`)
    }
  }

  const raw = fs.readFileSync(jsonPath, 'utf-8')
  let skill: AgentSkill
  try {
    skill = JSON.parse(raw) as AgentSkill
  } catch {
    throw new Error('skill.json 不是合法 JSON')
  }

  if (!validateSkill(skill)) {
    throw new Error('skill.json 缺少必要字段（id/name/description/systemPromptAddition/triggers）')
  }

  return saveUserSkill(skill, 'user')
}

/**
 * 从远程 URL 安装 skill
 * @param url 指向 skill.json 的 http(s) 地址
 */
export async function installFromUrl(url: string): Promise<SkillWithState> {
  log.info('[Skill] 从远程 URL 安装:', url)

  if (!/^https?:\/\//i.test(url)) {
    throw new Error('仅支持 http(s) 链接')
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const resp = await fetch(url, { signal: controller.signal })
    if (!resp.ok) {
      throw new Error(`下载失败：HTTP ${resp.status}`)
    }
    const text = await resp.text()
    if (text.length > MAX_REMOTE_BYTES) {
      throw new Error('skill.json 体积过大，已拒绝')
    }

    let skill: AgentSkill
    try {
      skill = JSON.parse(text) as AgentSkill
    } catch {
      throw new Error('远程返回的不是合法 JSON')
    }
    if (!validateSkill(skill)) {
      throw new Error('远程 skill 缺少必要字段')
    }
    return saveUserSkill(skill, 'remote')
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      throw new Error('下载超时')
    }
    throw e
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 直接安装一个 skill 对象（市场一键安装用）
 */
export function installSkillObject(skill: AgentSkill, source: 'user' | 'remote' = 'remote'): SkillWithState {
  if (!validateSkill(skill)) {
    throw new Error('Skill 对象缺少必要字段')
  }
  return saveUserSkill(skill, source)
}

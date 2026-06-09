/**
 * Skill 安装器
 *
 * 支持三种来源：
 *  1. 本地文件：选择一个 skill.json（或包含 skill.json 的目录）
 *  2. zip 包：选择一个包含 skill.json 的 zip
 *  3. 远程 URL：下载 skill.json 或 zip
 *
 * 所有安装都会经过 validateSkill 校验，落地到 user 目录并写安装记录。
 */

import * as fs from 'fs'
import * as path from 'path'
import { createHash } from 'crypto'
import log from 'electron-log/main'
import JSZip from 'jszip'
import type { AgentSkill, SkillWithState } from '@shared/types'
import { saveUserSkill, validateSkill } from './store'

/** 远程下载大小上限（2MB，允许 zip 中携带少量说明文件） */
const MAX_REMOTE_BYTES = 2 * 1024 * 1024
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
 * 从 zip 安装 skill
 * zip 内可以把 skill.json 放在根目录，也可以放在单层目录中。
 */
export async function installFromZip(zipPath: string): Promise<SkillWithState> {
  log.info('[Skill] 从 zip 安装:', zipPath)
  const buf = fs.readFileSync(zipPath)
  const skill = await readSkillFromZip(buf)
  return saveUserSkill(skill, 'user')
}

/**
 * 从远程 URL 安装 skill
 * @param url 指向 skill.json 或 zip 的 http(s) 地址；可带 ?sha256=<hex> 或 #sha256=<hex>
 */
export async function installFromUrl(url: string): Promise<SkillWithState> {
  log.info('[Skill] 从远程 URL 安装:', url)

  if (!/^https?:\/\//i.test(url)) {
    throw new Error('仅支持 http(s) 链接')
  }

  const { cleanUrl, expectedSha256 } = parseChecksum(url)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const resp = await fetch(cleanUrl, { signal: controller.signal })
    if (!resp.ok) {
      throw new Error(`下载失败：HTTP ${resp.status}`)
    }
    const bytes = Buffer.from(await resp.arrayBuffer())
    if (bytes.length > MAX_REMOTE_BYTES) {
      throw new Error('远程 skill 体积过大，已拒绝')
    }
    if (expectedSha256) {
      const actual = sha256Hex(bytes)
      if (actual !== expectedSha256.toLowerCase()) {
        throw new Error(`校验和不匹配：期望 ${expectedSha256}，实际 ${actual}`)
      }
    }

    const contentType = resp.headers.get('content-type') ?? ''
    const isZip = /\.zip(?:[?#]|$)/i.test(cleanUrl) || /zip/i.test(contentType)
    const skill = isZip ? await readSkillFromZip(bytes) : readSkillFromJson(bytes.toString('utf-8'), '远程 skill')
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

function readSkillFromJson(raw: string, label: string): AgentSkill {
  let skill: AgentSkill
  try {
    skill = JSON.parse(raw) as AgentSkill
  } catch {
    throw new Error(`${label} 不是合法 JSON`)
  }
  if (!validateSkill(skill)) {
    throw new Error(`${label} 缺少必要字段`)
  }
  return skill
}

async function readSkillFromZip(bytes: Buffer): Promise<AgentSkill> {
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(bytes)
  } catch {
    throw new Error('zip 文件无法解压或格式不合法')
  }

  const files = Object.values(zip.files).filter(f => !f.dir)
  const skillEntry =
    files.find(f => f.name === 'skill.json') ??
    files.find(f => /(^|\/)skill\.json$/i.test(f.name))

  if (!skillEntry) {
    throw new Error('zip 中未找到 skill.json')
  }

  const raw = await skillEntry.async('string')
  return readSkillFromJson(raw, 'zip 中的 skill.json')
}

function parseChecksum(url: string): { cleanUrl: string; expectedSha256?: string } {
  const parsed = new URL(url)
  const fromQuery = parsed.searchParams.get('sha256') ?? parsed.searchParams.get('checksum') ?? undefined
  parsed.searchParams.delete('sha256')
  parsed.searchParams.delete('checksum')
  let fromHash: string | undefined
  if (parsed.hash) {
    const hash = new URLSearchParams(parsed.hash.replace(/^#/, ''))
    fromHash = hash.get('sha256') ?? hash.get('checksum') ?? undefined
    parsed.hash = ''
  }
  return { cleanUrl: parsed.toString(), expectedSha256: fromQuery ?? fromHash }
}

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

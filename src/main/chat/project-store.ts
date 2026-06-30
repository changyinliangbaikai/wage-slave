/**
 * 项目（Project）管理存储
 *
 * 持久化位置：%APPDATA%/xiao-niu-ma/projects.json
 *
 * 设计要点：
 *  - 系统首次启动时自动注册「默认项目」，路径在用户文档目录下，避免 Agent 缺省 cwd 越界。
 *  - 项目列表始终包含 default，且 default 不可被删除；可被重命名。
 *  - 删除自定义项目时不会触碰物理目录，仅从索引中移除，并把归属该项目的会话 projectId 重置为 default。
 *  - 工作目录切换不依赖 process.chdir（避免多会话竞态），仅作为 AgentOrchestrator 的运行时上下文传递。
 */

import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import log from 'electron-log/main'
import type { Project } from '@shared/types-project'
import { DEFAULT_PROJECT_ID, DEFAULT_PROJECT_NAME } from '@shared/types-project'

const PROJECTS_FILE = path.join(app.getPath('userData'), 'projects.json')

function atomicWrite(filePath: string, data: unknown): void {
  const tmp = filePath + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8')
  fs.renameSync(tmp, filePath)
}

function readJSON<T>(filePath: string, fallback: T): T {
  try {
    if (!fs.existsSync(filePath)) return fallback
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T
  } catch {
    return fallback
  }
}

/** 默认项目本地路径：~/Documents/xiaoniuma/default */
export function getDefaultProjectPath(): string {
  return path.join(app.getPath('documents'), 'xiaoniuma', 'default')
}

/** 确保默认项目目录存在（首次启动时创建） */
function ensureDefaultProjectDir(): void {
  const dir = getDefaultProjectPath()
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  } catch (e) {
    log.warn('[ProjectStore] 创建默认项目目录失败:', e)
  }
}

/**
 * 启动期初始化：
 *  - 加载 projects.json，若不存在或为空数组则写入默认项目
 *  - 校验 default 项目记录存在；若用户曾经删除（不应该发生）则补回
 */
export function initProjectStore(): void {
  ensureDefaultProjectDir()
  const current = readJSON<Project[]>(PROJECTS_FILE, [])
  if (!Array.isArray(current) || current.length === 0) {
    const defaultProject: Project = {
      id: DEFAULT_PROJECT_ID,
      name: DEFAULT_PROJECT_NAME,
      path: getDefaultProjectPath(),
      createdAt: 0,
    }
    atomicWrite(PROJECTS_FILE, [defaultProject])
    log.info(`[ProjectStore] 初始化默认项目 path=${defaultProject.path}`)
    return
  }
  // 保险起见：兜底校验 default 项目存在
  const hasDefault = current.some(p => p.id === DEFAULT_PROJECT_ID)
  if (!hasDefault) {
    const defaultProject: Project = {
      id: DEFAULT_PROJECT_ID,
      name: DEFAULT_PROJECT_NAME,
      path: getDefaultProjectPath(),
      createdAt: 0,
    }
    atomicWrite(PROJECTS_FILE, [defaultProject, ...current])
    log.info('[ProjectStore] 默认项目缺失，已自动补回')
  }
}

/** 读取所有项目（按 createdAt 升序：default=0 永远在最前） */
export function listProjects(): Project[] {
  const list = readJSON<Project[]>(PROJECTS_FILE, [])
  if (!Array.isArray(list)) return []
  return [...list].sort((a, b) => {
    if (a.id === DEFAULT_PROJECT_ID) return -1
    if (b.id === DEFAULT_PROJECT_ID) return 1

    const aPinned = !!a.pinned
    const bPinned = !!b.pinned
    if (aPinned && !bPinned) return -1
    if (!aPinned && bPinned) return 1
    if (aPinned && bPinned) {
      return (b.pinnedAt || 0) - (a.pinnedAt || 0)
    }
    return a.createdAt - b.createdAt
  })
}

/** 按 id 读取单个项目 */
export function getProject(id: string): Project | null {
  const list = listProjects()
  return list.find(p => p.id === id) ?? null
}

/** 取默认项目（保证非空） */
export function getDefaultProject(): Project {
  const p = getProject(DEFAULT_PROJECT_ID)
  if (p) return p
  // 兜底：理论上 initProjectStore 已经写入；防御性返回
  return {
    id: DEFAULT_PROJECT_ID,
    name: DEFAULT_PROJECT_NAME,
    path: getDefaultProjectPath(),
    createdAt: 0,
  }
}

/**
 * 新增项目
 *  - createDir=true：在 ~/Documents/xiaoniuma/<name> 下创建新目录
 *  - createDir=false：直接关联用户选择的已有目录
 */
export interface CreateProjectInput {
  name: string
  /** 当 createDir=false 必填，指定本地绝对路径 */
  path?: string
  createDir?: boolean
}

export function createProject(input: CreateProjectInput): Project {
  const name = (input.name || '').trim().slice(0, 32) || `项目${Date.now()}`
  let targetPath: string
  if (input.createDir) {
    targetPath = path.join(app.getPath('documents'), 'xiaoniuma', sanitizeDirName(name))
    if (!fs.existsSync(targetPath)) fs.mkdirSync(targetPath, { recursive: true })
  } else {
    if (!input.path || typeof input.path !== 'string') {
      throw new Error('未指定项目路径')
    }
    targetPath = path.resolve(input.path)
    if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isDirectory()) {
      throw new Error(`项目路径不存在或不是目录: ${targetPath}`)
    }
  }
  const project: Project = {
    id: `proj_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    name,
    path: targetPath,
    createdAt: Date.now(),
  }
  const list = listProjects()
  // 不允许同路径重复添加
  const dup = list.find(p => path.resolve(p.path) === targetPath)
  if (dup) {
    log.info(`[ProjectStore] 路径 ${targetPath} 已被项目 "${dup.name}" 占用，复用其条目`)
    return dup
  }
  atomicWrite(PROJECTS_FILE, [...list, project])
  log.info(`[ProjectStore] 新增项目 id=${project.id} name=${project.name} path=${project.path}`)
  return project
}

/** 重命名项目（default 也可重命名） */
export function renameProject(id: string, name: string): boolean {
  const list = listProjects()
  const idx = list.findIndex(p => p.id === id)
  if (idx === -1) return false
  list[idx] = { ...list[idx], name: name.trim().slice(0, 32) || list[idx].name }
  atomicWrite(PROJECTS_FILE, list)
  return true
}

/**
 * 删除项目（仅从索引移除，不动物理目录）
 *  - default 不可删除
 *  - 返回 true 表示已删除
 */
export function deleteProject(id: string): boolean {
  if (id === DEFAULT_PROJECT_ID) return false
  const list = listProjects()
  const next = list.filter(p => p.id !== id)
  if (next.length === list.length) return false
  atomicWrite(PROJECTS_FILE, next)
  log.info(`[ProjectStore] 删除项目索引 id=${id}（保留物理目录）`)
  return true
}

/** 净化目录名（避免路径穿越和非法字符） */
function sanitizeDirName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|]/g, '_').trim()
  return cleaned.slice(0, 32) || 'project'
}

/** 置顶/取消置顶项目 */
export function togglePinProject(id: string): boolean {
  if (id === DEFAULT_PROJECT_ID) return false
  const list = readJSON<Project[]>(PROJECTS_FILE, [])
  const idx = list.findIndex(p => p.id === id)
  if (idx === -1) return false
  const project = list[idx]
  const pinned = !project.pinned
  list[idx] = {
    ...project,
    pinned,
    pinnedAt: pinned ? Date.now() : undefined,
  }
  atomicWrite(PROJECTS_FILE, list)
  log.info(`[ProjectStore] 项目置顶状态切换 id=${id} pinned=${pinned}`)
  return true
}

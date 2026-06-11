/**
 * Agent 技能中心与权限安全 IPC 注册
 */

import { ipcMain, dialog } from 'electron'
import * as path from 'path'
import log from 'electron-log/main'
import { IPC } from '@shared/ipc-channels'
import { getSkillsWindow, openSkillsWindow } from '../windows'
import { AGENT_TOOL_GROUPS } from '../agent/tool-registry'
import { getAllowedPaths, getDefaultAllowedPaths, DANGEROUS_RULES } from '../agent/security'
import { getConfig } from '../store'
import {
  getAllSkills,
  getSkillById,
  searchSkills,
  toggleSkill,
  updateSkillConfig,
  deleteUserSkill,
} from '../agent/skills/store'
import { installFromFile, installFromUrl, installSkillObject, installFromZip } from '../agent/skills/installer'
import { fetchMarketSkills, getMarketSkill } from '../agent/skills/market'
import type { SkillConfig } from '@shared/types'

export function registerSkillIPC(): void {
  // skill 状态变化后通知技能窗口刷新
  const notifyChanged = (): void => {
    const win = getSkillsWindow()
    if (win && !win.isDestroyed()) win.webContents.send(IPC.SKILL_CHANGED)
  }

  // 打开技能管理窗口
  ipcMain.on(IPC.SKILL_OPEN_WINDOW, () => openSkillsWindow())

  // ── Agent 工具权限（D.1） ───────────────────────
  ipcMain.handle(IPC.AGENT_GET_TOOL_GROUPS, () => {
    return AGENT_TOOL_GROUPS
  })

  // ── Agent 安全策略（D.3） ───────────────────────
  ipcMain.handle(IPC.AGENT_GET_SECURITY_POLICY, () => {
    const allowedPaths = getAllowedPaths()
    const defaultAllowedPaths = getDefaultAllowedPaths()
    const customAllowedPaths = getConfig().agent_allowed_paths_extra ?? []
    // 提取命令黑名单的正则描述（转换为字符串用于展示）
    const commandBlacklist = DANGEROUS_RULES.map((rule) => ({
      pattern: rule.pattern.toString(),
      reason: rule.reason,
    }))
    return { allowedPaths, defaultAllowedPaths, customAllowedPaths, commandBlacklist }
  })

  // 查询类
  ipcMain.handle(IPC.SKILL_LIST, () => getAllSkills())
  ipcMain.handle(IPC.SKILL_GET, (_e, id: string) => getSkillById(id))
  ipcMain.handle(IPC.SKILL_SEARCH, (_e, query: string) => searchSkills(query))

  // 启停
  ipcMain.handle(IPC.SKILL_TOGGLE, (_e, params: { id: string; enabled?: boolean }) => {
    const result = toggleSkill(params.id, params.enabled)
    notifyChanged()
    return result
  })

  ipcMain.handle(IPC.SKILL_UPDATE_CONFIG, (_e, params: { id: string; config: SkillConfig }) => {
    try {
      const result = updateSkillConfig(params.id, params.config)
      notifyChanged()
      return { ok: Boolean(result), skill: result ?? undefined }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      log.warn('[IPC] 保存 skill 配置失败:', msg)
      return { ok: false, error: msg }
    }
  })

  // 从本地文件安装（支持 skill.json、包含 skill.json 的目录、zip 包）
  ipcMain.handle(IPC.SKILL_INSTALL_FILE, async () => {
    const result = await dialog.showOpenDialog({
      title: '选择 skill.json、Skill 目录或 zip 包',
      properties: ['openFile', 'openDirectory'],
      filters: [{ name: 'Skill', extensions: ['json', 'zip'] }],
    })
    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false, canceled: true }
    }
    try {
      const selected = result.filePaths[0]
      const skill = path.extname(selected).toLowerCase() === '.zip'
        ? await installFromZip(selected)
        : installFromFile(selected)
      notifyChanged()
      log.info('[IPC] 已安装本地 skill:', skill.id)
      return { ok: true, skill }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      log.warn('[IPC] 安装本地 skill 失败:', msg)
      return { ok: false, error: msg }
    }
  })

  // 从远程 URL 安装
  ipcMain.handle(IPC.SKILL_INSTALL_URL, async (_e, url: string) => {
    try {
      const skill = await installFromUrl(url)
      notifyChanged()
      log.info('[IPC] 已从 URL 安装 skill:', skill.id)
      return { ok: true, skill }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      log.warn('[IPC] URL 安装 skill 失败:', msg)
      return { ok: false, error: msg }
    }
  })

  // 从市场一键安装
  ipcMain.handle(IPC.SKILL_INSTALL_MARKET, async (_e, id: string) => {
    try {
      const item = await getMarketSkill(id)
      if (!item) return { ok: false, error: '市场中未找到该技能' }
      const skill = item.downloadUrl
        ? await installFromUrl(item.downloadUrl)
        : installSkillObject(item, 'remote')
      notifyChanged()
      log.info('[IPC] 已从市场安装 skill:', skill.id)
      return { ok: true, skill }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      log.warn('[IPC] 市场安装 skill 失败:', msg)
      return { ok: false, error: msg }
    }
  })

  // 卸载（内置只停用）
  ipcMain.handle(IPC.SKILL_UNINSTALL, (_e, id: string) => {
    const ok = deleteUserSkill(id)
    notifyChanged()
    return { ok }
  })

  // 拉取市场列表（远程不可用时回退本地精选）
  ipcMain.handle(IPC.SKILL_MARKET_LIST, async () => {
    try {
      const skills = await fetchMarketSkills()
      return { ok: true, skills }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { ok: false, error: msg, skills: [] }
    }
  })
}

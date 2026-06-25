/**
 * 项目类型检测器
 *
 * 通过扫描项目根目录的标志文件（package.json、Cargo.toml、go.mod 等）
 * 推断当前工作目录的语言、框架、包管理器、测试框架等信息，
 * 让 LLM 一开始就理解项目的技术栈，避免猜测。
 *
 * 设计要点：
 *  1. 所有文件操作失败均静默降级（返回 null），不影响 Agent 初始化
 *  2. 仅扫描当前目录，不递归（防止误判子项目）
 *  3. 检测规则按优先级排列：通用度高的语言放前面
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import log from 'electron-log/main'

/** 项目检测结果 */
export interface ProjectInfo {
  type: string             // 主要类型，如 "Node.js"、"Python"、"Rust"
  framework?: string       // 检测到的框架，如 "React"、"Next.js"、"Electron"
  packageManager?: string  // 包管理器，如 "npm"、"yarn"、"pnpm"、"pip"、"cargo"
  testFramework?: string   // 测试框架，如 "jest"、"vitest"、"pytest"
  /** 项目名称（如果能从配置文件里读出来） */
  name?: string
}

/**
 * 检测项目类型
 * @returns 检测到的项目信息；如果不是已知类型的项目，返回 null
 */
export async function detectProjectType(cwd: string): Promise<ProjectInfo | null> {
  const detectors: Array<() => Promise<ProjectInfo | null>> = [
    () => detectNodeProject(cwd),
    () => detectPythonProject(cwd),
    () => detectRustProject(cwd),
    () => detectGoProject(cwd),
    () => detectJavaProject(cwd),
    () => detectCppProject(cwd),
  ]

  for (const detector of detectors) {
    try {
      const info = await detector()
      if (info) return info
    } catch (e) {
      log.debug(`[ProjectDetect] 检测器出错: ${(e as Error).message}`)
    }
  }
  return null
}

// ── Node.js 生态 ─────────────────────────────────────────────────

async function detectNodeProject(cwd: string): Promise<ProjectInfo | null> {
  const pkgJsonPath = path.join(cwd, 'package.json')
  let pkg: Record<string, unknown> | null = null
  try {
    const content = await fs.readFile(pkgJsonPath, 'utf-8')
    pkg = JSON.parse(content)
  } catch {
    return null   // 没有 package.json 就不是 Node 项目
  }
  if (!pkg) return null

  const deps = {
    ...(pkg.dependencies as Record<string, string> ?? {}),
    ...(pkg.devDependencies as Record<string, string> ?? {}),
  }

  // 框架检测（按优先级：更具体的框架优先）
  let framework: string | undefined
  if (deps['next']) framework = 'Next.js'
  else if (deps['nuxt']) framework = 'Nuxt.js'
  else if (deps['@remix-run/react']) framework = 'Remix'
  else if (deps['gatsby']) framework = 'Gatsby'
  else if (deps['electron']) framework = 'Electron'
  else if (deps['react-native']) framework = 'React Native'
  else if (deps['expo']) framework = 'Expo'
  else if (deps['react']) framework = 'React'
  else if (deps['vue']) framework = 'Vue'
  else if (deps['@angular/core']) framework = 'Angular'
  else if (deps['svelte']) framework = 'Svelte'
  else if (deps['solid-js']) framework = 'Solid'
  else if (deps['express']) framework = 'Express'
  else if (deps['koa']) framework = 'Koa'
  else if (deps['fastify']) framework = 'Fastify'
  else if (deps['@nestjs/core']) framework = 'NestJS'

  // 包管理器检测（按 lockfile 优先级）
  const packageManager = await detectNodePackageManager(cwd)

  // 测试框架检测
  let testFramework: string | undefined
  if (deps['vitest']) testFramework = 'vitest'
  else if (deps['jest']) testFramework = 'jest'
  else if (deps['mocha']) testFramework = 'mocha'
  else if (deps['ava']) testFramework = 'ava'
  else if (deps['playwright'] || deps['@playwright/test']) testFramework = 'playwright'
  else if (deps['cypress']) testFramework = 'cypress'

  // 是否为 TypeScript 项目
  const isTs = deps['typescript'] !== undefined ||
    await fileExists(path.join(cwd, 'tsconfig.json'))

  return {
    type: isTs ? 'Node.js (TypeScript)' : 'Node.js',
    framework,
    packageManager,
    testFramework,
    name: typeof pkg.name === 'string' ? pkg.name : undefined,
  }
}

/** 通过 lockfile 推断包管理器 */
async function detectNodePackageManager(cwd: string): Promise<string> {
  // 优先级：bun > pnpm > yarn > npm（按 lockfile 唯一性）
  if (await fileExists(path.join(cwd, 'bun.lockb'))) return 'bun'
  if (await fileExists(path.join(cwd, 'pnpm-lock.yaml'))) return 'pnpm'
  if (await fileExists(path.join(cwd, 'yarn.lock'))) return 'yarn'
  if (await fileExists(path.join(cwd, 'package-lock.json'))) return 'npm'
  return 'npm'   // 默认
}

// ── Python ──────────────────────────────────────────────────────

async function detectPythonProject(cwd: string): Promise<ProjectInfo | null> {
  const markers = ['pyproject.toml', 'requirements.txt', 'setup.py', 'Pipfile', 'environment.yml']
  let found = false
  let projectName: string | undefined

  for (const m of markers) {
    if (await fileExists(path.join(cwd, m))) {
      found = true
      // 尝试从 pyproject.toml 读取项目名
      if (m === 'pyproject.toml') {
        try {
          const content = await fs.readFile(path.join(cwd, m), 'utf-8')
          const nameMatch = content.match(/^\s*name\s*=\s*["']([^"']+)["']/m)
          if (nameMatch) projectName = nameMatch[1]
        } catch { /* ignore */ }
      }
      break
    }
  }
  if (!found) return null

  // 框架检测：扫描 requirements.txt / pyproject.toml 的内容
  let framework: string | undefined
  let testFramework: string | undefined
  try {
    const txtPath = path.join(cwd, 'requirements.txt')
    const pyprojectPath = path.join(cwd, 'pyproject.toml')
    let content = ''
    if (await fileExists(txtPath)) content += await fs.readFile(txtPath, 'utf-8')
    if (await fileExists(pyprojectPath)) content += '\n' + await fs.readFile(pyprojectPath, 'utf-8')

    const c = content.toLowerCase()
    if (c.includes('django')) framework = 'Django'
    else if (c.includes('fastapi')) framework = 'FastAPI'
    else if (c.includes('flask')) framework = 'Flask'
    else if (c.includes('tornado')) framework = 'Tornado'
    else if (c.includes('pyramid')) framework = 'Pyramid'

    if (c.includes('pytest')) testFramework = 'pytest'
    else if (c.includes('unittest')) testFramework = 'unittest'
    else if (c.includes('nose')) testFramework = 'nose'
  } catch { /* ignore */ }

  // 包管理器检测
  let packageManager = 'pip'
  if (await fileExists(path.join(cwd, 'poetry.lock'))) packageManager = 'poetry'
  else if (await fileExists(path.join(cwd, 'Pipfile.lock'))) packageManager = 'pipenv'
  else if (await fileExists(path.join(cwd, 'uv.lock'))) packageManager = 'uv'
  else if (await fileExists(path.join(cwd, 'environment.yml'))) packageManager = 'conda'

  return {
    type: 'Python',
    framework,
    packageManager,
    testFramework,
    name: projectName,
  }
}

// ── Rust ────────────────────────────────────────────────────────

async function detectRustProject(cwd: string): Promise<ProjectInfo | null> {
  const cargoPath = path.join(cwd, 'Cargo.toml')
  if (!await fileExists(cargoPath)) return null

  let name: string | undefined
  try {
    const content = await fs.readFile(cargoPath, 'utf-8')
    const nameMatch = content.match(/^\s*name\s*=\s*["']([^"']+)["']/m)
    if (nameMatch) name = nameMatch[1]
  } catch { /* ignore */ }

  return {
    type: 'Rust',
    packageManager: 'cargo',
    testFramework: 'cargo test',
    name,
  }
}

// ── Go ──────────────────────────────────────────────────────────

async function detectGoProject(cwd: string): Promise<ProjectInfo | null> {
  if (!await fileExists(path.join(cwd, 'go.mod'))) return null

  let name: string | undefined
  try {
    const content = await fs.readFile(path.join(cwd, 'go.mod'), 'utf-8')
    const modMatch = content.match(/^\s*module\s+(\S+)/m)
    if (modMatch) name = modMatch[1]
  } catch { /* ignore */ }

  return {
    type: 'Go',
    packageManager: 'go modules',
    testFramework: 'go test',
    name,
  }
}

// ── Java / Kotlin ───────────────────────────────────────────────

async function detectJavaProject(cwd: string): Promise<ProjectInfo | null> {
  if (await fileExists(path.join(cwd, 'pom.xml'))) {
    return { type: 'Java', packageManager: 'maven' }
  }
  if (await fileExists(path.join(cwd, 'build.gradle')) ||
      await fileExists(path.join(cwd, 'build.gradle.kts'))) {
    return { type: 'Java / Kotlin', packageManager: 'gradle' }
  }
  return null
}

// ── C / C++ ─────────────────────────────────────────────────────

async function detectCppProject(cwd: string): Promise<ProjectInfo | null> {
  if (await fileExists(path.join(cwd, 'CMakeLists.txt'))) {
    return { type: 'C / C++', packageManager: 'cmake' }
  }
  if (await fileExists(path.join(cwd, 'Makefile'))) {
    return { type: 'C / C++', packageManager: 'make' }
  }
  return null
}

// ── 工具函数 ────────────────────────────────────────────────────

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

/** 把 ProjectInfo 渲染成 prompt 文本片段 */
export function renderProjectInfo(info: ProjectInfo | null): string {
  if (!info) return '- 项目类型：未检测到已知项目标志文件'
  const lines = [`- 项目类型：${info.type}`]
  if (info.name) lines[0] += `（${info.name}）`
  if (info.framework) lines.push(`- 框架：${info.framework}`)
  if (info.packageManager) lines.push(`- 包管理器：${info.packageManager}`)
  if (info.testFramework) lines.push(`- 测试框架：${info.testFramework}`)
  return lines.join('\n')
}

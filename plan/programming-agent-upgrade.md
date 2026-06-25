# 小小牛马编程智能体能力升级方案

> **目标**：将小小牛马从「桌面助手 Agent」升级为具备强大编程能力的 Agent  
> **参考对象**：Claude Code v2.1.88 (Anthropic 官方 CLI 编程智能体)  
> **分析方法**：对 `claude-code-sourcemap/restored-src/` 完整源码逆向分析  
> **方案版本**：v1.0 · 2026-06-25

---

## 目录

- [1. 现状对比分析](#1-现状对比分析)
- [2. Claude Code 核心设计理念提炼](#2-claude-code-核心设计理念提炼)
- [3. Phase 1：编程核心工具链](#3-phase-1编程核心工具链高优先级)
- [4. Phase 2：项目上下文感知](#4-phase-2项目上下文感知中优先级)
- [5. Phase 3：上下文管理优化](#5-phase-3上下文管理优化中优先级)
- [6. Phase 4：高级编程体验](#6-phase-4高级编程体验后续迭代)
- [7. 验证计划](#7-验证计划)

---

## 1. 现状对比分析

### 1.1 能力矩阵对照表

| 维度 | Claude Code 实现 | 小小牛马现状 | 差距 |
|------|------------------|------------|------|
| **代码内容搜索** | GrepTool（ripgrep 后端，支持正则、行号、上下文行、glob过滤、输出模式切换） | search_files（Node 递归，仅返回文件路径，无行号，无正则） | 🔴 严重 |
| **文件名搜索** | GlobTool（fast-glob，支持模式匹配，截断保护） | list_files（单层 readdir + glob 过滤，无递归） | 🔴 严重 |
| **代码编辑** | FileEditTool（626行：diff 补丁、相似度容错 findActualString、引号风格保留 preserveQuoteStyle、文件修改时间校验、LSP 诊断清理） | edit_file（基础 indexOf 替换，无容错，无 diff 预览） | 🟡 中等 |
| **终端执行** | BashTool（160KB 代码：多层权限模型、路径验证、sed 检测、沙箱模式、命令语义分析） | run_command（黑名单 + 二次确认弹窗，功能够用） | 🟢 够用 |
| **项目理解** | 自动注入 Git 状态（分支、status、最近提交、用户名）；项目类型检测；CLAUDE.md 项目规则 | 无 Git 上下文；无项目类型检测；无项目规则文件 | 🔴 严重 |
| **LSP 集成** | LSPTool（861行：goToDefinition、findReferences、hover、documentSymbol、workspaceSymbol、callHierarchy） | 无 | 🟡 后续 |
| **子代理** | AgentTool（233KB：fork/worktree/后台任务/探索代理/验证代理/multi-agent swarms） | 无 | 🟡 后续 |
| **上下文管理** | 自动摘要、工具结果分层清理（Function Result Clearing）、Scratchpad 临时目录、prompt 缓存分界 | context-compressor（两阶段折叠：单条截断+整体折叠，基础但可用） | 🟡 中等 |
| **Web 搜索** | WebSearchTool、WebFetchTool | 无 | 🟡 后续 |
| **并行工具调用** | 支持多个独立 tool_calls 并行执行 | 串行执行（"顺序执行，避免并发写竞争"） | 🟡 后续 |

### 1.2 小小牛马现有 24 个工具一览

```
📁 文件操作（5个）：read_file, write_file, edit_file, list_files, search_files
⚡ 命令执行（1个）：run_command
📊 数据管理（6个）：get_today_log, get_todos, save_todo, update_todo, append_log, get_logs_range
⏰ 定时任务（5个）：scheduler_list/create/update/delete/toggle_task
🛠️ 技能管理（6个）：skill_list/get/install/update/toggle/delete
🖥️ 系统操作（2个）：open_file, show_notification
🔄 流程控制（1个）：wait
```

### 1.3 Claude Code 40+ 工具分类（核心工具）

```
📁 文件操作：FileReadTool, FileWriteTool, FileEditTool, NotebookEditTool
🔍 代码搜索：GrepTool, GlobTool
🖥️ 终端执行：BashTool, PowerShellTool
🧠 代码理解：LSPTool (goToDefinition/findReferences/hover/documentSymbol/workspaceSymbol)
🤖 子代理：AgentTool (fork/worktree/探索/验证)
📋 任务管理：TodoWriteTool, TaskCreate/Get/Update/List/Stop/OutputTool
🌐 网络工具：WebSearchTool, WebFetchTool
💬 交互工具：AskUserQuestionTool, SendMessageTool, BriefTool
🔧 系统工具：ConfigTool, SkillTool, ToolSearchTool
📊 模式工具：EnterPlanModeTool, ExitPlanModeTool, EnterWorktreeTool, ExitWorktreeTool
🔌 MCP 工具：MCPTool, ListMcpResourcesTool, ReadMcpResourceTool
⏰ 定时工具：ScheduleCronTool, SleepTool
```

---

## 2. Claude Code 核心设计理念提炼

通过分析 `restored-src/src/constants/prompts.ts`（915行，54KB）中的系统提示词和工具架构，提炼出以下 Claude Code 作为编程智能体的核心设计理念：

### 2.1 「专用工具优先」原则

Claude Code 系统提示词中**反复强调**（`getUsingYourToolsSection`，L269-314）：

```
Do NOT use the Bash to run commands when a relevant dedicated tool is provided.
- To read files use FileRead instead of cat, head, tail, or sed
- To edit files use FileEdit instead of sed or awk
- To create files use FileWrite instead of cat with heredoc or echo redirection
- To search for files use Glob instead of find or ls
- To search the content of files, use Grep instead of grep or rg
- Reserve using the Bash exclusively for system commands and terminal operations
```

**启示**：小牛马目前缺少 `grep_code` 和 `glob_files`，导致 LLM 只能通过 `run_command + grep/find` 完成代码搜索，触发二次确认弹窗且无法利用专用工具的安全保障和结构化输出。

### 2.2 「先读后改」工程纪律

`getSimpleDoingTasksSection`（L199-253）中明确规定：

```
- In general, do not propose changes to code you haven't read.
- Do not create files unless they're absolutely necessary.
- Generally prefer editing an existing file to creating a new one.
- If an approach fails, diagnose why before switching tactics — read the error,
  check your assumptions, try a focused fix.
```

**启示**：这些行为准则应注入小牛马的静态系统提示词中。

### 2.3 「最小化变更」代码风格

Claude Code 对代码修改有极其严格的约束（L200-213）：

```
- Don't add features, refactor code, or make "improvements" beyond what was asked.
- Don't add error handling, fallbacks, or validation for scenarios that can't happen.
- Don't create helpers, utilities, or abstractions for one-time operations.
- Default to writing no comments. Only add one when the WHY is non-obvious.
- Don't explain WHAT the code does — well-named identifiers already do that.
```

**启示**：小牛马当前的系统提示词已有类似规则（「Minimalism」），但措辞不够具体。需要对齐 Claude Code 的详细程度。

### 2.4 「自动注入项目上下文」

Claude Code 的 `context.ts` 在每次对话开始时自动收集并注入：

```typescript
// getGitStatus() — 自动执行 5 个 git 命令并注入
const [branch, mainBranch, status, log, userName] = await Promise.all([
  getBranch(),
  getDefaultBranch(),
  execFileNoThrow(gitExe(), ['status', '--short']),
  execFileNoThrow(gitExe(), ['log', '--oneline', '-n', '5']),
  execFileNoThrow(gitExe(), ['config', 'user.name']),
])
```

同时注入环境信息（`computeSimpleEnvInfo`）：
- 工作目录、是否 Git 仓库、平台、Shell 类型、OS 版本
- 当前模型名称、知识截止日期
- 额外工作目录（多仓库场景）

**启示**：小牛马的 `buildDynamicContext` 已有基础环境信息，但完全缺失 Git 上下文和项目类型信息。

### 2.5 「可逆性与影响范围」决策框架

`getActionsSection`（L255-267）定义了一套完整的「行动前评估框架」：

```
Carefully consider the reversibility and blast radius of actions.
- Freely take: local, reversible actions (editing files, running tests)
- Check first: hard-to-reverse, shared-system, or destructive actions
- Examples requiring confirmation: deleting files/branches, force-pushing,
  creating/closing PRs, sending messages, modifying CI/CD
```

**启示**：小牛马通过黑名单+弹窗实现安全保障，但系统提示词中缺少这种「决策框架」式引导。

### 2.6 「结果可验证」准则

Claude Code 明确要求（L211）：

```
Before reporting a task complete, verify it actually works: run the test,
execute the script, check the output. Minimum complexity means no gold-plating,
not skipping the finish line.
```

**启示**：小牛马提示词中有简单的"结果可验证"规则，但缺少具体指导（如"运行测试"）。

---

## 3. Phase 1：编程核心工具链（高优先级）

> **目标**：让小牛马能像 Claude Code 一样高效地搜索、阅读、编辑代码  
> **预计工期**：3-5 天  
> **涉及文件**：tool-registry.ts, tool-executor.ts, system-prompt.ts

### 3.1 新增 `grep_code` 工具

**对标**：Claude Code `GrepTool`（`restored-src/src/tools/GrepTool/GrepTool.ts`，578行）

**Claude Code 的 GrepTool 特点**：
- 底层调用 `ripgrep`（通过 `utils/ripgrep.ts` 封装）
- 支持 3 种输出模式：`content`（匹配行+上下文）、`files_with_matches`（仅文件路径）、`count`（计数）
- 支持 `-B`（前文行数）、`-A`（后文行数）、`-C`（上下文行数）、`-n`（行号）、`-i`（大小写不敏感）
- 支持 `--type` 过滤（js, py, rust 等标准类型）
- 支持 `--glob` 过滤
- 支持 `head_limit` 截断
- 自动排除 `.git`、`node_modules`、插件缓存等
- 权限校验：通过 `checkReadPermissionForTool` 确保路径在允许范围内

**小牛马设计方案**：

```
工具名：grep_code
工具组：code（新增 "代码搜索" 工具组）

参数：
  pattern       string  [必填] 正则表达式搜索模式
  path          string  [选填] 搜索路径（文件或目录），默认 cwd
  include       string  [选填] glob 文件过滤（如 "*.ts"、"*.{js,jsx}"）
  context_lines integer [选填] 匹配行前后各显示 N 行上下文，默认 2，范围 0-10
  case_insensitive boolean [选填] 大小写不敏感，默认 false
  max_results   integer [选填] 最大匹配数，默认 50，范围 1-200

返回格式：
  [搜索: pattern, 路径: path] 命中 N 处
  src/main/agent/orchestrator.ts:
    187:   const compressedHistory = compressHistoryForLLM(this.history)
    188:   const apiMessages = [
    189:     { role: 'system' as const, content: systemPrompt },
  src/main/agent/context-compressor.ts:
    51: export function compressHistoryForLLM(
    52:   history: AgentMessage[],
  ...（超过 max_results 时截断提示）
```

**实现策略**（分两层）：

**层 1 — ripgrep 优先**：
```typescript
// 检测系统是否安装 rg
async function hasRipgrep(): Promise<boolean> {
  try {
    await execFile('rg', ['--version'])
    return true
  } catch { return false }
}

// ripgrep 调用封装
async function execRipgrep(args: GrepCodeArgs): Promise<string> {
  const rgArgs = [
    args.pattern,
    args.path || process.cwd(),
    '--json',          // JSON 输出便于解析
    '-n',              // 显示行号
    '--max-count', String(args.max_results || 50),
    '--no-heading',
  ]
  if (args.context_lines) rgArgs.push('-C', String(args.context_lines))
  if (args.case_insensitive) rgArgs.push('-i')
  if (args.include) rgArgs.push('--glob', args.include)
  // 自动排除噪音目录
  rgArgs.push('--glob', '!node_modules', '--glob', '!.git',
    '--glob', '!dist', '--glob', '!build', '--glob', '!.next')
  // ... execFile('rg', rgArgs) 并格式化输出
}
```

**层 2 — Node.js 回退**：
```typescript
// 纯 Node 实现（无 rg 时的降级方案）
async function grepWithNode(args: GrepCodeArgs): Promise<string> {
  const regex = new RegExp(args.pattern, args.case_insensitive ? 'gi' : 'g')
  // 递归遍历 + readline 逐行匹配 + 收集上下文行
  // 跳过二进制文件（通过 isTextFile 判断前 512 字节）
  // 跳过 >2MB 的文件
  // 输出格式与 rg 路径一致
}
```

**安全约束**：
- 搜索路径必须通过 `assertSafePath` 校验（复用现有白名单）
- 自动排除 `.git`、`node_modules`、`dist`、`build`、`.next`、`coverage`
- 单次搜索超时 30 秒

### 3.2 新增 `glob_files` 工具

**对标**：Claude Code `GlobTool`（`restored-src/src/tools/GlobTool/GlobTool.ts`，199行）

**Claude Code 的 GlobTool 特点**：
- 使用 `utils/glob.ts` 封装（可能基于 `fast-glob`）
- 参数简单：`pattern` + 可选 `path`
- 结果限制 100 个文件，超过时标记 `truncated: true`
- 返回结构化数据：`durationMs`、`numFiles`、`filenames[]`、`truncated`
- 只读工具，并发安全（`isConcurrencySafe: true`）

**小牛马设计方案**：

```
工具名：glob_files
工具组：code（归入 "代码搜索" 工具组）

参数：
  pattern       string  [必填] glob 模式（如 "**/*.test.ts"、"src/**/index.{js,ts}"）
  path          string  [选填] 搜索根目录，默认 cwd

返回格式：
  [Glob: **/*.test.ts, 路径: /Users/jhx/project] 找到 12 个文件
  src/__tests__/agent.test.ts
  src/__tests__/tools.test.ts
  src/main/agent/__tests__/compressor.test.ts
  ...
  （超过 100 个文件时）
  ...还有 37 个文件未显示，请使用更精确的 pattern
```

**实现要点**：
```typescript
import { glob } from 'glob' // Node.js 22+ 内置，或用 fast-glob

async function toolGlobFiles(args: GlobFilesArgs): Promise<string> {
  const basePath = expandHome(args.path || process.cwd())
  assertSafePath(basePath)

  const files = await glob(args.pattern, {
    cwd: basePath,
    ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**'],
    nodir: true,        // 只返回文件
    absolute: false,    // 返回相对路径（更简洁）
  })

  const MAX_FILES = 100
  const truncated = files.length > MAX_FILES
  const shown = truncated ? files.slice(0, MAX_FILES) : files

  const header = `[Glob: ${args.pattern}, 路径: ${basePath}] 找到 ${files.length} 个文件`
  const footer = truncated ? `\n...还有 ${files.length - MAX_FILES} 个文件未显示，请使用更精确的 pattern` : ''
  return [header, ...shown, footer].filter(Boolean).join('\n')
}
```

### 3.3 增强 `list_files` — 递归目录树

**现状问题**：当前 `list_files` 只列出单层目录内容，LLM 无法快速理解项目结构。

**增强方案**：

```
新增参数：
  depth    integer [选填] 递归深度，默认 1（即当前行为），最大 5
  show_size boolean [选填] 是否显示文件大小，默认 false

增强后的返回格式（depth=2 时）：
  [目录: /Users/jhx/project/src] 共 24 项，递归深度 2
  [DIR]  main/
  [DIR]    main/agent/         (11 文件, 2 目录)
  [DIR]    main/store/         (3 文件)
  [DIR]    main/tools/         (5 文件)
  [FILE]   main/index.ts       (2.1 KB)
  [DIR]  renderer/
  [DIR]    renderer/components/ (8 文件)
  [DIR]    renderer/hooks/      (4 文件)
  [FILE]   renderer/App.tsx     (1.5 KB)
  [DIR]  shared/
  [FILE]   shared/types.ts      (24.9 KB)
  [FILE]   shared/ipc-channels.ts (3.2 KB)
```

**实现要点**：
```typescript
async function toolListFiles(args: ListFilesArgs): Promise<string> {
  const depth = clamp(args.depth ?? 1, 1, 5)
  // 递归 readdir，按深度限制展开
  // 目录项显示子文件/子目录数量统计
  // 文件项可选显示大小（formatFileSize）
  // 总项数超过 200 时截断
}
```

### 3.4 增强 `edit_file` — 提升编辑可靠性

**对标**：Claude Code `FileEditTool` 的关键特性

**增强点 1 — 模糊匹配容错**：

Claude Code 的 `findActualString`（`FileEditTool/utils.ts`）会在精确匹配失败时尝试：
1. 忽略行尾空白差异
2. 忽略缩进差异（统一为单空格再比较）
3. 报告最相似的候选位置

小牛马方案：
```typescript
async function toolEditFile(args: EditFileArgs): Promise<string> {
  // ... 现有逻辑 ...
  const idx = content.indexOf(old_string)
  if (idx === -1) {
    // 新增：尝试忽略空白的模糊匹配
    const fuzzyIdx = findFuzzyMatch(content, old_string)
    if (fuzzyIdx !== null) {
      // 找到了近似匹配，替换并提示
      const actual = extractActualString(content, fuzzyIdx, old_string)
      const updated = content.replace(actual, new_string)
      return `已替换 1 处于 ${target}（注意：使用了模糊匹配，原文与 old_string 在空白字符上有差异）`
    }
    // 新增：显示最相似的片段帮助 LLM 修正
    const similar = findMostSimilar(content, old_string, 3)
    throw new Error(`未找到匹配文本: "${preview(old_string)}"\n` +
      (similar.length > 0 ? `最相似的片段：\n${similar.map(s => `  - 第${s.line}行: "${preview(s.text)}"`).join('\n')}` : ''))
  }
  // ... 后续不变 ...
}
```

**增强点 2 — 编辑结果 diff 预览**：

```typescript
// 返回值中附加 diff 预览（帮助 LLM 和用户确认修改效果）
const diffPreview = generateSimpleDiff(old_string, new_string, 3) // 前后各 3 行上下文
return `已替换 1 处于 ${target}\n\n变更预览：\n${diffPreview}`
```

**增强点 3 — 文件修改时间校验**：

```typescript
// 防止并发编辑导致数据丢失
const statBefore = await fs.stat(target)
// ... 执行编辑 ...
// 如果在读取和写入之间文件被修改（mtime 变化），发出警告
```

### 3.5 新增 `code` 工具组

在 `AGENT_TOOL_GROUPS` 中新增工具组：

```typescript
{
  id: 'code',
  label: '代码搜索',
  description: '在项目中搜索代码内容和文件名。编程任务的核心工具。',
  toolNames: ['grep_code', 'glob_files'],
}
```

### 3.6 系统提示词 — 工具使用引导

在 `buildSystemPrompt()` 的静态部分新增一个段落（对标 Claude Code `getUsingYourToolsSection`）：

```markdown
# 工具选择优先级

执行编程任务时，优先使用专用工具而非 run_command：
- 搜索代码内容 → 用 grep_code，不要用 run_command + grep
- 搜索文件名 → 用 glob_files，不要用 run_command + find
- 读取文件 → 用 read_file，不要用 run_command + cat/head/tail
- 编辑文件 → 用 edit_file，不要用 run_command + sed/awk
- 创建文件 → 用 write_file，不要用 run_command 重定向
- 列目录 → 用 list_files，不要用 run_command + ls

run_command 仅用于：运行测试、启动/停止服务、git 操作、包管理器操作等必须使用 shell 的场景。
```

---

## 4. Phase 2：项目上下文感知（中优先级）

> **目标**：让小牛马在对话开始时自动理解当前项目的语言、框架和 Git 状态  
> **预计工期**：2-3 天  
> **涉及文件**：system-prompt.ts（新增 project-detect.ts、git-context.ts）

### 4.1 新增 Git 上下文自动注入

**对标**：Claude Code `context.ts` 的 `getGitStatus()`（L36-111）

Claude Code 在每次对话开始时自动执行以下 git 命令并注入系统提示词：

```
Current branch: feature/xxx
Main branch: main
Git user: jhx
Status: (git status --short 的输出，截断到 2000 字)
Recent commits: (最近 5 条 oneline)
```

**小牛马实现方案**：

新增文件 `src/main/agent/git-context.ts`：

```typescript
/**
 * Git 上下文收集器
 * 在 buildDynamicContext 中调用，为 LLM 提供当前仓库状态
 */

export interface GitContext {
  isGitRepo: boolean
  branch?: string
  mainBranch?: string
  userName?: string
  statusShort?: string   // 截断到 2000 字
  recentCommits?: string // 最近 5 条
}

export async function collectGitContext(cwd: string): Promise<GitContext> {
  // 1. 检测是否 git 仓库：git rev-parse --is-inside-work-tree
  // 2. 并行执行：git branch --show-current, git status --short,
  //    git log --oneline -n 5, git config user.name
  // 3. 超时 5 秒保护（避免大仓库 git status 卡住）
  // 4. 任何 git 命令失败均静默降级（返回 isGitRepo: false）
}
```

在 `buildDynamicContext` 中集成：

```typescript
export async function buildDynamicContext(ctx: AgentContext): Promise<string> {
  const allowed = getAllowedPaths().join('\n  · ')
  const git = await collectGitContext(ctx.cwd)   // 新增
  const project = detectProjectType(ctx.cwd)     // 新增

  return `
# === DYNAMIC CONTENT BOUNDARY ===
...（现有内容）

# 项目上下文
${git.isGitRepo ? `
- Git 分支：${git.branch}（主分支：${git.mainBranch || 'main'}）
- Git 状态：${git.statusShort || '(clean)'}
- 最近提交：
${git.recentCommits || '(无)'}` : '- 非 Git 仓库'}
${project ? `- 项目类型：${project.type}（${project.framework || '无框架'}）
- 包管理器：${project.packageManager || '未检测到'}` : ''}

# 路径白名单
...（现有内容）
`
}
```

**注意**：`buildDynamicContext` 需要改为 `async function`（当前是同步的），这会影响 `orchestrator.ts` 中的调用点。

### 4.2 新增项目类型检测

新增文件 `src/main/agent/project-detect.ts`：

```typescript
/**
 * 项目类型检测器
 * 扫描标志文件推断语言、框架、包管理器
 */

export interface ProjectInfo {
  type: string          // 如 "Node.js", "Python", "Rust", "Go", "Java"
  framework?: string    // 如 "React", "Vue", "Next.js", "Express", "Django"
  packageManager?: string // 如 "npm", "yarn", "pnpm", "pip", "cargo"
  testFramework?: string  // 如 "jest", "vitest", "pytest", "cargo test"
}

// 检测规则（按优先级排列）
const DETECTION_RULES = [
  // Node.js 生态
  { file: 'package.json', type: 'Node.js', detectFramework: parsePackageJson },
  { file: 'tsconfig.json', type: 'TypeScript (Node.js)' },
  { file: 'deno.json', type: 'Deno' },
  { file: 'bun.lockb', type: 'Bun' },
  // Python
  { file: 'pyproject.toml', type: 'Python', detectFramework: parsePyproject },
  { file: 'requirements.txt', type: 'Python' },
  { file: 'setup.py', type: 'Python' },
  // Rust
  { file: 'Cargo.toml', type: 'Rust' },
  // Go
  { file: 'go.mod', type: 'Go' },
  // Java/Kotlin
  { file: 'pom.xml', type: 'Java (Maven)' },
  { file: 'build.gradle', type: 'Java/Kotlin (Gradle)' },
  // C/C++
  { file: 'CMakeLists.txt', type: 'C/C++ (CMake)' },
  { file: 'Makefile', type: 'C/C++ (Make)' },
]

function parsePackageJson(content: string): Partial<ProjectInfo> {
  const pkg = JSON.parse(content)
  const deps = { ...pkg.dependencies, ...pkg.devDependencies }
  // 检测框架
  if (deps['next']) return { framework: 'Next.js' }
  if (deps['nuxt']) return { framework: 'Nuxt' }
  if (deps['react']) return { framework: 'React' }
  if (deps['vue']) return { framework: 'Vue' }
  if (deps['svelte']) return { framework: 'Svelte' }
  if (deps['express']) return { framework: 'Express' }
  if (deps['electron']) return { framework: 'Electron' }
  // 检测包管理器
  // 检测测试框架
  return {}
}
```

### 4.3 增强系统提示词 — 编程行为准则

在 `buildSystemPrompt()` 的静态部分新增**编程任务行为准则**（对标 Claude Code `getSimpleDoingTasksSection`）：

```markdown
# 编程任务准则

1. **先读后改**：修改任何文件前先用 read_file 阅读，理解现有代码后再提出改动。不要对没有读过的代码提出修改建议。
2. **理解再动手**：收到编程任务后，先用 grep_code 和 list_files 了解项目结构和相关代码，再开始修改。
3. **最小化变更**：
   - 只修改完成任务所需的代码，不做额外重构、优化或清理。
   - 不为假设性的未来需求添加过度设计。
   - 不创建只用一次的工具函数或抽象层。
   - 三行相似代码优于一个过早的抽象。
4. **遵循项目风格**：按照项目既有的缩进、命名、注释风格编写代码。不要引入不一致的格式。
5. **验证结果**：
   - 代码修改后，必要时运行项目的测试命令验证没有引入问题。
   - 如果无法验证（没有测试、无法运行），明确告知用户而不是假装成功。
   - 如实报告结果——测试失败就说失败并附上输出，不要掩盖或简化失败信息。
6. **安全编码**：注意不要引入命令注入、XSS、SQL 注入等安全漏洞。
7. **创建 vs 编辑**：优先编辑现有文件而非创建新文件，除非新文件是完成任务的必要步骤。
```

---

## 5. Phase 3：上下文管理优化（中优先级）

> **目标**：提升长对话和大代码库场景下的上下文利用效率  
> **预计工期**：2-3 天  
> **涉及文件**：context-compressor.ts, orchestrator.ts, system-prompt.ts

### 5.1 智能工具结果清理

**对标**：Claude Code 的 Function Result Clearing（`prompts.ts` L821-841）

Claude Code 会自动清理旧的工具结果，只保留最近 N 次的完整输出：

```
# Function Result Clearing
Old tool results will be automatically cleared from context to free up space.
The N most recent results are always kept.
```

同时提示 LLM：
```
When working with tool results, write down any important information you might
need later in your response, as the original tool result may be cleared later.
```

**小牛马改进方案**：

在 `context-compressor.ts` 中新增**阶段 0**（在现有两阶段之前执行）：

```typescript
/**
 * 阶段 0：智能工具结果清理
 *
 * 策略：保留最近 keepRecentTools 条 tool 消息的完整输出，
 * 更早的 tool 消息内容替换为一行摘要。
 *
 * 效果：read_file 读了 10 个文件，只有最近 3 个文件内容保留完整，
 * 前 7 个只保留 "[read_file: /path/to/file.ts — 已清理，保留摘要]"
 */

interface ToolResultClearingConfig {
  keepRecentTools: number  // 保留最近 N 条 tool 结果完整，默认 6
  summaryMaxChars: number  // 清理后的摘要最长字符数，默认 120
}

function clearOldToolResults(
  history: AgentMessage[],
  config: ToolResultClearingConfig
): AgentMessage[] {
  // 1. 从后往前找到所有 role=tool 消息
  // 2. 保留最近 keepRecentTools 条的完整内容
  // 3. 更早的 tool 消息内容替换为：
  //    "[工具结果已清理] {tool_name}: {content前 summaryMaxChars 字}..."
  // 4. 不修改 tool_call_id（保持配对关系）
}
```

在 `buildSystemPrompt()` 中添加提示：

```markdown
工具结果可能会被自动清理以节省上下文。如果你从工具结果中获取了后续步骤需要的关键信息（如文件路径、行号、变量名等），请在回复中记录下来，因为原始工具结果可能在后续轮次中被清理。
```

### 5.2 分层压缩策略

改进现有 `compressHistoryForLLM` 的触发逻辑：

```
当前策略（一刀切）：
  消息数 > 30 或 总字符 > 24000 → 折叠到 keepRecent=12

改进策略（分层触发）：
  Level 1: 总字符 > 16000 → 仅清理旧工具结果（阶段 0）
  Level 2: 总字符 > 24000 → 清理工具结果 + 折叠早期消息（保留最近 12 条）
  Level 3: 总字符 > 32000 → 激进折叠（保留最近 8 条）+ 摘要更精简
```

### 5.3 自适应配置

当前 `CompressConfig` 是硬编码的 16k 上下文配置。增加根据模型自动调整：

```typescript
function getCompressConfig(): CompressConfig {
  const model = getConfig().agent_llm_model || ''
  // DeepSeek v4 通常支持 64k+
  if (model.includes('deepseek')) {
    return { keepRecent: 20, triggerCount: 50, triggerChars: 48000, maxToolChars: 8000 }
  }
  // GPT-4o 128k
  if (model.includes('gpt-4o')) {
    return { keepRecent: 24, triggerCount: 60, triggerChars: 64000, maxToolChars: 12000 }
  }
  // 默认保守配置（16k 模型安全）
  return DEFAULT_CONFIG
}
```

---

## 6. Phase 4：高级编程体验（后续迭代）

以下功能工程量较大或依赖外部基础设施，列为后续方向：

### 6.1 项目规则文件（.niuma.md）

**对标**：Claude Code 的 `CLAUDE.md`（通过 `getUserContext` → `getClaudeMds` 加载）

- 项目根目录放置 `.niuma.md` 文件
- 小牛马在对话开始时自动读取并注入系统提示词
- 内容可以包含：项目说明、编码规范、技术栈说明、常用命令等
- 支持嵌套：`.niuma.md` 在项目根目录 + 子目录

### 6.2 LSP 集成

**对标**：Claude Code `LSPTool`（861行，9 种操作）

- 需要在 Electron 主进程中启动 LSP server（如 typescript-language-server）
- 支持的操作（按优先级）：
  1. `goToDefinition` — 跳转定义（最核心）
  2. `findReferences` — 查找引用
  3. `hover` — 查看类型信息
  4. `documentSymbol` — 获取文件中的所有符号（函数、类、变量）
  5. `workspaceSymbol` — 全局符号搜索
- 工程量大，建议作为独立 Phase 实施

### 6.3 子代理 / 并行执行

**对标**：Claude Code `AgentTool`

- **轻量方案**：支持并行执行独立的 tool_calls（当前是串行）
- **重量方案**：支持 fork 子 Agent（独立 LLM 会话，后台执行，结果合并）
- 建议先实现并行 tool_calls（改动较小），子代理留后

### 6.4 Web 搜索工具

**对标**：Claude Code `WebSearchTool`、`WebFetchTool`

- `web_search`：搜索引擎查询，返回摘要结果
- `web_fetch`：抓取网页内容（转为 Markdown）
- 依赖外部搜索 API（如 SearXNG、Tavily 等）

### 6.5 Git 操作工具

将 Git 操作从 `run_command` 中独立出来成为专用工具：

```
git_status  — 查看当前仓库状态（不需要二次确认）
git_diff    — 查看文件差异（不需要二次确认）
git_log     — 查看提交历史（不需要二次确认）
git_commit  — 提交变更（需要二次确认）
git_branch  — 分支操作（需要二次确认）
```

好处：读操作绕过 `run_command` 的二次确认弹窗，提升体验。

---

## 7. 验证计划

### 7.1 Phase 1 验证

**编译检查**：
```bash
cd /Users/jhx/Documents/learn/mark-ai/mark-series/mark-ten-cat-claude/xiao-niu-ma
npx tsc --noEmit
```

**功能测试场景**：

| # | 测试场景 | 输入示例 | 预期行为 |
|---|---------|---------|---------|
| 1 | grep_code 基础搜索 | "搜索项目中所有使用了 useState 的地方" | 调用 grep_code，返回文件:行号:内容 |
| 2 | grep_code 带过滤 | "在 .ts 文件中搜索 AgentMessage" | 调用 grep_code + include=*.ts |
| 3 | glob_files 搜索 | "列出所有测试文件" | 调用 glob_files + pattern=**/*.test.* |
| 4 | list_files 递归 | "看看 src/main/agent 目录的结构" | 调用 list_files + depth=2 |
| 5 | edit_file 模糊匹配 | LLM 提供带轻微空白差异的 old_string | 模糊匹配成功并提示 |
| 6 | 工具选择测试 | "在项目中搜索 TODO 注释" | 应调用 grep_code 而非 run_command |
| 7 | 安全测试 | "搜索 /etc 目录下的文件" | 被路径白名单拦截 |

### 7.2 Phase 2 验证

| # | 测试场景 | 验证方式 |
|---|---------|---------|
| 1 | Git 上下文注入 | 在 Git 仓库内启动对话，检查 trace 记录中 system prompt 是否包含分支名 |
| 2 | 项目类型检测 | 在 Node.js 项目中启动对话，检查是否检测到 "Node.js / Electron" |
| 3 | 非 Git 目录降级 | 在非 Git 目录启动对话，检查不报错且不显示 Git 信息 |
| 4 | 编程行为准则生效 | 让 LLM 修改代码，观察是否先 read_file 再 edit_file |

### 7.3 Phase 3 验证

| # | 测试场景 | 验证方式 |
|---|---------|---------|
| 1 | 工具结果清理 | 连续读取 10+ 个文件后，检查 trace 中发送给 LLM 的 messages 是否只保留最近 6 条完整结果 |
| 2 | 分层压缩 | 进行 30+ 轮对话，检查压缩日志是否按 Level 1→2→3 递进触发 |
| 3 | Prompt Cache 回归 | 检查 Jarvis Studio trace 中的 prompt_cache_hit_tokens 未因动态内容增加而下降 |

### 7.4 回归测试

所有 Phase 完成后需回归验证：
- 现有 24 个工具功能不受影响
- ReAct 文本降级协议兼容新工具
- 定时任务触发的 Agent 会话正常工作
- 技能匹配引擎正常工作
- 上下文压缩不破坏 tool_call ↔ tool_result 配对
- Trace 记录正常推送到 Jarvis Studio

---

## 附录 A：文件变更清单

### Phase 1 变更

| 操作 | 文件路径 | 说明 |
|------|---------|------|
| MODIFY | `src/main/agent/tool-registry.ts` | 新增 grep_code、glob_files schema；新增 code 工具组；增强 list_files 参数 |
| MODIFY | `src/main/agent/tool-executor.ts` | 新增 toolGrepCode、toolGlobFiles 执行逻辑；增强 toolListFiles 递归支持；增强 toolEditFile 模糊匹配 |
| MODIFY | `src/main/agent/system-prompt.ts` | 静态提示词新增「工具选择优先级」段落 |
| MODIFY | `src/main/agent/security.ts` | grep_code/glob_files 路径校验复用 assertSafePath |

### Phase 2 变更

| 操作 | 文件路径 | 说明 |
|------|---------|------|
| NEW | `src/main/agent/git-context.ts` | Git 上下文收集器 |
| NEW | `src/main/agent/project-detect.ts` | 项目类型检测器 |
| MODIFY | `src/main/agent/system-prompt.ts` | buildDynamicContext 改为 async，注入 Git 和项目上下文；静态提示词新增「编程任务准则」 |
| MODIFY | `src/main/agent/orchestrator.ts` | 适配 buildDynamicContext 的 async 变更 |

### Phase 3 变更

| 操作 | 文件路径 | 说明 |
|------|---------|------|
| MODIFY | `src/main/agent/context-compressor.ts` | 新增阶段 0 工具结果清理；分层压缩策略；自适应配置 |
| MODIFY | `src/main/agent/orchestrator.ts` | 集成工具结果清理触发逻辑 |
| MODIFY | `src/main/agent/system-prompt.ts` | 提示 LLM 工具结果可能被清理 |

---

## 附录 B：Claude Code 源码关键文件索引

以下文件是本方案分析的主要参考来源，位于 `claude-code-sourcemap/restored-src/src/`：

| 文件 | 大小 | 说明 |
|------|------|------|
| `constants/prompts.ts` | 54KB / 915行 | 系统提示词完整定义（最核心的参考） |
| `tools.ts` | 17KB / 390行 | 工具注册与组装 |
| `Tool.ts` | 30KB / 793行 | 工具基类与类型定义 |
| `tools/GrepTool/GrepTool.ts` | 20KB / 578行 | 代码搜索工具 |
| `tools/GlobTool/GlobTool.ts` | 6KB / 199行 | 文件名搜索工具 |
| `tools/FileEditTool/FileEditTool.ts` | 21KB / 626行 | 代码编辑工具 |
| `tools/FileReadTool/` | — | 文件读取工具 |
| `tools/FileWriteTool/` | — | 文件写入工具 |
| `tools/BashTool/BashTool.tsx` | 161KB | 终端执行工具 |
| `tools/BashTool/bashSecurity.ts` | 103KB | 命令安全检查 |
| `tools/LSPTool/LSPTool.ts` | 26KB / 861行 | LSP 集成工具 |
| `tools/AgentTool/AgentTool.tsx` | 234KB / 1398行 | 子代理工具 |
| `tools/AgentTool/runAgent.ts` | 36KB | 子代理执行引擎 |
| `context.ts` | 6KB / 190行 | 上下文管理（Git 状态、CLAUDE.md） |
| `QueryEngine.ts` | 47KB / 1296行 | 查询引擎（Agent 循环核心） |
| `constants/systemPromptSections.ts` | 2KB | 提示词分段缓存机制 |

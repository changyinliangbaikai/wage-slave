# 文件上传功能设计方案

> **目标**：为快速对话和 Agent 模式统一实现文件上传功能  
> **现状**：AIChat 前端有 UI 但无后端支持，AgentChat 完全缺失  
> **预计工期**：2-3 天

---

## 1. 现状分析

### 1.1 AIChat（快速对话）现状

```
AIChat.tsx
├── ✅ 附件状态管理 (attachments state)
├── ✅ 文件选择按钮 (handlePickAttachments)
├── ✅ 拖拽上传支持 (dragOver, onDrop)
├── ✅ 附件列表展示 (附件 chip、图标、大小)
├── ✅ 附件内容拼接进 Prompt (buildPromptWithAttachments)
├── ❌ IPC 后端未实现 (AI_CHAT_PICK_ATTACHMENTS 无 handler)
└── ❌ 文件读取逻辑未实现 (AI_CHAT_READ_ATTACHMENTS 无 handler)
```

### 1.2 AgentChat 现状

```
AgentChat.tsx / useAgent.ts
├── ❌ 无附件状态
├── ❌ 无文件选择 UI
├── ❌ 无拖拽支持
├── ❌ 无附件展示
└── ❌ 附件未加入 Agent Prompt
```

---

## 2. 设计方案

### 2.1 核心决策

| 决策 | 方案 | 理由 |
|------|------|------|
| 存储 | 只读，不持久化存储文件 | 隐私安全，减少磁盘占用 |
| 处理 | 主进程读取 → 渲染进程展示 | 绕过浏览器安全限制 |
| 大小限制 | 单文件 5MB，总计 20MB | 防止 Token 超限 |
| 支持格式 | 文本类优先（txt/md/pdf/docx/code） | 图片需要 Vision 模型 |
| 处理方式 | 提取文本内容拼接入 Prompt | 最通用，无需多模态 |

### 2.2 架构图

```
┌─────────────────────────────────────────────────────────┐
│                      渲染进程                            │
│  ┌─────────────┐         ┌─────────────┐               │
│  │  AIChat.tsx │         │ AgentChat   │               │
│  │  (快速对话)  │         │ (Agent模式)  │               │
│  └──────┬──────┘         └──────┬──────┘               │
│         │                       │                       │
│         └───────────┬───────────┘                       │
│              useFileAttachments (通用 Hook)              │
│              AttachmentList (通用组件)                     │
└─────────────────────────┬───────────────────────────────┘
                          │ IPC
┌─────────────────────────▼───────────────────────────────┐
│                      主进程                              │
│              FileAttachmentService                       │
│         ┌───────────────┬───────────────┐               │
│         │ ContentExtractor │ Security    │               │
│         │ • 文本提取      │ Validator   │               │
│         │ • PDF解析     │ • 大小限制    │               │
│         │ • Office文档  │ • 路径安全    │               │
│         └───────────────┴───────────────┘               │
└─────────────────────────────────────────────────────────┘
```

---

## 3. 详细设计

### 3.1 类型定义（src/shared/types.ts）

```typescript
/** 文件附件 */
export interface FileAttachment {
  id: string
  fileName: string
  fileType: string      // 'txt' | 'pdf' | 'docx' | ...
  mimeType: string
  sizeBytes: number
  content: string        // 提取的文本内容（已截断）
  charCount: number      // 原始字符数
  truncated: boolean    // 是否因超长被截断
  status: 'pending' | 'reading' | 'success' | 'error'
  error?: string
  createdAt: number
}

/** 附件读取结果 */
export interface AttachmentReadResult {
  ok: boolean
  attachments: FileAttachment[]
  errors: Array<{ fileName: string; error: string; code: string }>
  warnings: Array<{ fileName: string; warning: string; code: string }>
}

// AIChatMessage 和 AgentMessage 都需要添加：
attachments?: FileAttachment[]
```

### 3.2 主进程服务（src/main/file-attachment/service.ts）

```typescript
export class FileAttachmentService {
  // 配置
  MAX_FILE_SIZE = 5 * 1024 * 1024      // 5MB
  MAX_TOTAL_SIZE = 20 * 1024 * 1024    // 20MB
  MAX_CONTENT_CHARS = 50000            // 5万字符
  
  SUPPORTED_EXTENSIONS = new Set([
    '.txt', '.md', '.pdf', '.doc', '.docx',
    '.xls', '.xlsx', '.csv', '.json',
    '.js', '.ts', '.py', '.java', '.go',
    '.html', '.css', '.sql', '.sh', '.log',
  ])
  
  // 打开文件选择器
  async pickAttachmentsFromDialog(): Promise<AttachmentReadResult>
  
  // 读取文件内容
  async readAttachments(filePaths: string[]): Promise<AttachmentReadResult>
  
  // 提取文本内容（支持多种格式）
  private async extractText(filePath: string): Promise<string>
}

export const fileAttachmentService = new FileAttachmentService()
```

### 3.3 IPC Handler（src/main/ipc-handlers-attachment.ts）

```typescript
import { IPC } from '@shared/ipc-channels'
import { fileAttachmentService } from './file-attachment/service'

export function registerAttachmentIPC(): void {
  // 文件选择器
  ipcMain.handle(IPC.ATTACHMENT_PICK, async () => {
    return await fileAttachmentService.pickAttachmentsFromDialog()
  })
  
  // 拖拽文件
  ipcMain.handle(IPC.ATTACHMENT_READ, async (_, filePaths: string[]) => {
    return await fileAttachmentService.readAttachments(filePaths)
  })
}
```

### 3.4 IPC 通道扩展（src/shared/ipc-channels.ts）

```typescript
export const IPC = {
  // 新增
  ATTACHMENT_PICK:      'renderer:attachment-pick',
  ATTACHMENT_READ:      'renderer:attachment-read',
  
  // 保留旧通道兼容
  AI_CHAT_PICK_ATTACHMENTS: 'renderer:ai-chat-pick-attachments',
  AI_CHAT_READ_ATTACHMENTS: 'renderer:ai-chat-read-attachments',
}
```

### 3.5 通用 Hook（src/renderer/src/hooks/useFileAttachments.ts）

```typescript
export interface UseFileAttachmentsResult {
  attachments: FileAttachment[]
  isReading: boolean
  
  pickFiles: () => Promise<void>
  addFilesFromDrop: (files: FileList) => Promise<void>
  removeAttachment: (id: string) => void
  clearAttachments: () => void
  
  lastErrors: Array<{ fileName: string; error: string }>
  lastWarnings: Array<{ fileName: string; warning: string }>
}

export function useFileAttachments(): UseFileAttachmentsResult {
  // 实现...
}
```

### 3.6 通用组件（src/renderer/src/components/AttachmentList.tsx）

展示已添加的文件，支持删除、错误提示、截断标记。

---

## 4. 改造清单

### 4.1 新建文件（8 个）

```
src/main/file-attachment/
  ├── service.ts              # 核心服务
  ├── extractors/
  │   ├── text-extractor.ts   # 纯文本提取
  │   ├── pdf-extractor.ts    # PDF 解析（需要依赖）
  │   └── office-extractor.ts # Office 文档解析（需要依赖）
  └── index.ts

src/main/ipc-handlers-attachment.ts

src/renderer/src/hooks/useFileAttachments.ts

src/renderer/src/components/
  ├── AttachmentList.tsx
  └── AttachmentList.css
```

### 4.2 修改文件（6 个）

```
src/shared/types.ts              # 添加 FileAttachment 类型
src/shared/ipc-channels.ts       # 添加 ATTACHMENT_* 通道
src/main/index.ts                # 注册 registerAttachmentIPC()
src/main/agent/orchestrator.ts   # Agent Prompt 添加附件拼接

src/renderer/src/pages/AIChat.tsx     # 接入 useFileAttachments
src/renderer/src/pages/AgentChat.tsx  # 添加附件 UI 和 Hook
```

---

## 5. 实现步骤

### Phase 1: 基础设施（1 天）

1. 实现 `FileAttachmentService`
   - 文件选择器
   - 文本文件读取
   - 安全验证（大小、路径）
   
2. 实现 IPC Handlers
   - `ATTACHMENT_PICK`
   - `ATTACHMENT_READ`

3. 实现 `useFileAttachments` Hook

### Phase 2: AIChat 接入（0.5 天）

1. 连接后端 IPC（复用现有 UI）
2. 测试文件读取功能

### Phase 3: AgentChat 接入（0.5 天）

1. 添加 `useFileAttachments` Hook
2. 添加 `AttachmentList` 组件到输入区
3. 修改 `AgentOrchestrator`，支持附件加入 Prompt

### Phase 4: PDF/Office 支持（可选，1 天）

安装依赖：
- `pdf-parse` 或 `pdfjs-dist`（PDF 解析）
- `mammoth`（docx 解析）
- `xlsx`（Excel 解析）

---

## 6. 安全考虑

1. **路径验证**：禁止访问系统目录（/System, /Windows等）
2. **大小限制**：防止内存溢出和 Token 超限
3. **类型白名单**：只读取文本类文件，禁止可执行文件
4. **错误隔离**：单文件读取失败不影响其他文件
5. **不保留路径**：渲染进程不获取真实文件路径

---

## 7. 后续扩展

1. **图片支持**：接入 Vision 模型（GPT-4V、Claude 3 等）
2. **代码文件特殊处理**：语法高亮预览
3. **大文件分片读取**：进度条展示
4. **文件夹上传**：递归读取代码项目

---

**创建时间**: 2026-06-10  
**预计工期**: 2-3 天

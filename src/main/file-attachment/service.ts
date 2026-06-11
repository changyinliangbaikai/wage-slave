/**
 * 文件附件服务
 *
 * 职责：
 * 1. 安全地读取用户选择的文件
 * 2. 提取文本内容（支持多种格式）
 * 3. 应用大小限制和内容截断
 * 4. 返回标准化的 AIChatAttachment 对象
 */

import { dialog } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import * as readline from 'readline'
import type { AIChatAttachment, AttachmentReadResult } from '@shared/types'
import mammoth from 'mammoth'
import * as XLSX from 'xlsx'
const pdfParse = require('pdf-parse')

// ═══════════════════════════════════════════════
// 配置常量
// ═══════════════════════════════════════════════

const CONFIG = {
  // 大小限制
  MAX_FILE_SIZE: 5 * 1024 * 1024,      // 单文件 5MB
  MAX_TOTAL_SIZE: 20 * 1024 * 1024,    // 总计 20MB
  MAX_CONTENT_CHARS: 50000,            // 单文件内容最大字符数

  // 支持的扩展名白名单
  SUPPORTED_EXTENSIONS: new Set([
    '.txt', '.md', '.markdown',
    '.pdf',
    '.doc', '.docx',
    '.xls', '.xlsx', '.csv',
    '.json', '.xml', '.yaml', '.yml',
    '.js', '.ts', '.jsx', '.tsx', '.vue', '.mjs', '.cjs',
    '.py', '.java', '.go', '.rs', '.c', '.cpp', '.h', '.hpp', '.cs', '.php', '.rb',
    '.swift', '.kt',
    '.html', '.htm', '.css', '.scss', '.sass', '.less',
    '.sql',
    '.sh', '.bash', '.zsh', '.ps1', '.bat', '.cmd',
    '.log',
  ]),
}

// ═══════════════════════════════════════════════
// MIME 类型映射
// ═══════════════════════════════════════════════

const MIME_TYPE_MAP: Record<string, string> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.js': 'application/javascript',
  '.ts': 'application/javascript',
  '.jsx': 'application/javascript',
  '.tsx': 'application/javascript',
  '.vue': 'application/javascript',
  '.mjs': 'application/javascript',
  '.cjs': 'application/javascript',
  '.py': 'text/x-python',
  '.java': 'text/x-java',
  '.go': 'text/x-go',
  '.rs': 'text/x-rust',
  '.c': 'text/x-c',
  '.cpp': 'text/x-c++',
  '.h': 'text/x-c',
  '.hpp': 'text/x-c++',
  '.cs': 'text/x-csharp',
  '.php': 'text/x-php',
  '.rb': 'text/x-ruby',
  '.swift': 'text/x-swift',
  '.kt': 'text/x-kotlin',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.scss': 'text/x-scss',
  '.sass': 'text/x-sass',
  '.less': 'text/x-less',
  '.sql': 'text/x-sql',
  '.sh': 'text/x-shellscript',
  '.bash': 'text/x-shellscript',
  '.zsh': 'text/x-shellscript',
  '.ps1': 'text/x-powershell',
  '.bat': 'text/x-batch',
  '.cmd': 'text/x-batch',
  '.log': 'text/plain',
}

// ═══════════════════════════════════════════════
// 内容提取器
// ═══════════════════════════════════════════════

/**
 * 提取纯文本文件内容
 */
async function extractTextFile(filePath: string, maxChars: number): Promise<{ content: string; charCount: number; truncated: boolean }> {
  const fileStream = fs.createReadStream(filePath, { encoding: 'utf-8' })
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity })

  let content = ''
  let charCount = 0
  let truncated = false

  for await (const line of rl) {
    charCount += line.length + 1  // +1 for newline

    if (content.length + line.length + 1 <= maxChars) {
      content += line + '\n'
    } else if (!truncated) {
      // 还能加一部分
      const remaining = maxChars - content.length - 25  // 预留截断提示空间
      if (remaining > 0) {
        content += line.slice(0, remaining) + '\n[内容已截断...]'
      } else {
        content += '\n[内容已截断...]'
      }
      truncated = true
      break
    }
  }

  fileStream.destroy()

  return { content: content.trimEnd(), charCount, truncated }
}

/**
 * 提取 Word 文档（.docx, .doc）内容
 */
async function extractDocxFile(filePath: string, maxChars: number): Promise<{ content: string; charCount: number; truncated: boolean }> {
  try {
    const result = await mammoth.extractRawText({ path: filePath })
    let text = result.value || ''
    const charCount = text.length
    let truncated = false
    if (text.length > maxChars) {
      text = text.slice(0, maxChars - 25) + '\n[内容已截断...]'
      truncated = true
    }
    return { content: text.trimEnd(), charCount, truncated }
  } catch (err) {
    throw new Error(`Word文档解析失败: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * 提取 PDF 文件内容
 */
async function extractPdfFile(filePath: string, maxChars: number): Promise<{ content: string; charCount: number; truncated: boolean }> {
  try {
    const dataBuffer = fs.readFileSync(filePath)
    const data = await pdfParse(dataBuffer)
    let text = data.text || ''
    const charCount = text.length
    let truncated = false
    if (text.length > maxChars) {
      text = text.slice(0, maxChars - 25) + '\n[内容已截断...]'
      truncated = true
    }
    return { content: text.trimEnd(), charCount, truncated }
  } catch (err) {
    throw new Error(`PDF文件解析失败: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * 提取 Excel 工作表内容（转换为 CSV 格式）
 */
async function extractExcelFile(filePath: string, maxChars: number): Promise<{ content: string; charCount: number; truncated: boolean }> {
  try {
    const workbook = XLSX.readFile(filePath)
    let text = ''
    for (const sheetName of workbook.SheetNames) {
      const worksheet = workbook.Sheets[sheetName]
      const csv = XLSX.utils.sheet_to_csv(worksheet)
      if (csv.trim()) {
        text += `[工作表: ${sheetName}]\n${csv}\n`
      }
    }
    const charCount = text.length
    let truncated = false
    if (text.length > maxChars) {
      text = text.slice(0, maxChars - 25) + '\n[内容已截断...]'
      truncated = true
    }
    return { content: text.trimEnd(), charCount, truncated }
  } catch (err) {
    throw new Error(`Excel文件解析失败: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// ═══════════════════════════════════════════════
// 核心服务类
// ═══════════════════════════════════════════════

export class FileAttachmentService {

  /**
   * 打开文件选择器，读取用户选择的文件
   */
  async pickAttachmentsFromDialog(): Promise<AttachmentReadResult> {
    const extensions = Array.from(CONFIG.SUPPORTED_EXTENSIONS).map(e => e.slice(1))
    const { canceled, filePaths } = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '支持的文档', extensions },
        { name: '所有文件', extensions: ['*'] },
      ],
    })

    if (canceled || !filePaths || filePaths.length === 0) {
      return { ok: true, attachments: [], errors: [], warnings: [] }
    }

    return this.readAttachments(filePaths)
  }

  /**
   * 从文件路径读取附件
   */
  async readAttachments(filePaths: string[]): Promise<AttachmentReadResult> {
    const result: AttachmentReadResult = {
      ok: true,
      attachments: [],
      errors: [],
      warnings: [],
    }

    let totalSize = 0

    for (const filePath of filePaths) {
      try {
        // 安全检查 1：路径验证
        if (!this.isSafePath(filePath)) {
          result.errors.push({
            fileName: path.basename(filePath),
            error: '路径包含非法字符或试图访问系统目录',
            code: 'SECURITY_VIOLATION',
          })
          continue
        }

        // 安全检查 2：文件存在性
        if (!fs.existsSync(filePath)) {
          result.errors.push({
            fileName: path.basename(filePath),
            error: '文件不存在',
            code: 'READ_ERROR',
          })
          continue
        }

        const stats = fs.statSync(filePath)

        // 安全检查 3：不是目录
        if (stats.isDirectory()) {
          result.errors.push({
            fileName: path.basename(filePath),
            error: '不支持上传文件夹',
            code: 'UNSUPPORTED_TYPE',
          })
          continue
        }

        // 安全检查 4：文件大小
        if (stats.size > CONFIG.MAX_FILE_SIZE) {
          result.errors.push({
            fileName: path.basename(filePath),
            error: `文件大小 ${(stats.size / 1024 / 1024).toFixed(2)}MB 超过限制 ${CONFIG.MAX_FILE_SIZE / 1024 / 1024}MB`,
            code: 'TOO_LARGE',
          })
          continue
        }

        totalSize += stats.size
        if (totalSize > CONFIG.MAX_TOTAL_SIZE) {
          result.errors.push({
            fileName: path.basename(filePath),
            error: `总计大小超过限制 ${CONFIG.MAX_TOTAL_SIZE / 1024 / 1024}MB`,
            code: 'TOO_LARGE',
          })
          break
        }

        // 读取文件
        const attachment = await this.readSingleFile(filePath, stats.size)
        result.attachments.push(attachment)

        if (attachment.truncated) {
          result.warnings.push({
            fileName: attachment.fileName,
            warning: `内容已截断至 ${CONFIG.MAX_CONTENT_CHARS} 字符`,
            code: 'TRUNCATED',
          })
        }

      } catch (error) {
        result.errors.push({
          fileName: path.basename(filePath),
          error: error instanceof Error ? error.message : '未知错误',
          code: 'READ_ERROR',
        })
      }
    }

    result.ok = result.errors.length === 0 || result.attachments.length > 0
    return result
  }

  /**
   * 读取单个文件
   */
  private async readSingleFile(filePath: string, sizeBytes: number): Promise<AIChatAttachment> {
    const fileName = path.basename(filePath)
    const ext = path.extname(filePath).toLowerCase()
    const fileType = ext.slice(1) || 'txt'
    const mimeType = MIME_TYPE_MAP[ext] || 'application/octet-stream'

    // 检查是否支持该类型
    const isSupported = CONFIG.SUPPORTED_EXTENSIONS.has(ext)

    if (!isSupported) {
      // 不支持的类型，返回元数据但标记错误
      return {
        id: this.generateId(),
        fileName,
        fileType,
        mimeType,
        sizeBytes,
        content: `[文件类型 ${ext || '无扩展名'} 暂不支持文本提取]`,
        charCount: 0,
        truncated: false,
        status: 'error',
        error: `不支持 ${ext || '无扩展名'} 文件类型的文本提取`,
        createdAt: Date.now(),
      }
    }

    // 差异化提取文本内容，避免二进制文件解析乱码
    let content = ''
    let charCount = 0
    let truncated = false

    try {
      if (ext === '.docx' || ext === '.doc') {
        const result = await extractDocxFile(filePath, CONFIG.MAX_CONTENT_CHARS)
        content = result.content
        charCount = result.charCount
        truncated = result.truncated
      } else if (ext === '.pdf') {
        const result = await extractPdfFile(filePath, CONFIG.MAX_CONTENT_CHARS)
        content = result.content
        charCount = result.charCount
        truncated = result.truncated
      } else if (ext === '.xlsx' || ext === '.xls') {
        const result = await extractExcelFile(filePath, CONFIG.MAX_CONTENT_CHARS)
        content = result.content
        charCount = result.charCount
        truncated = result.truncated
      } else {
        const result = await extractTextFile(filePath, CONFIG.MAX_CONTENT_CHARS)
        content = result.content
        charCount = result.charCount
        truncated = result.truncated
      }

      return {
        id: this.generateId(),
        fileName,
        fileType,
        mimeType,
        sizeBytes,
        content,
        charCount,
        truncated,
        truncatedAt: truncated ? CONFIG.MAX_CONTENT_CHARS : undefined,
        status: 'success',
        createdAt: Date.now(),
      }
    } catch (err) {
      return {
        id: this.generateId(),
        fileName,
        fileType,
        mimeType,
        sizeBytes,
        content: `[提取文件内容失败: ${err instanceof Error ? err.message : String(err)}]`,
        charCount: 0,
        truncated: false,
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
        createdAt: Date.now(),
      }
    }
  }

  /**
   * 安全检查：路径是否合法
   */
  private isSafePath(filePath: string): boolean {
    // 禁止访问系统目录和路径遍历
    const forbiddenPatterns = [
      /\/System\/Library/i,
      /\/Windows\/System/i,
      /\/etc\/passwd/i,
      /\.\./,  // 路径遍历尝试
    ]

    return !forbiddenPatterns.some(p => p.test(filePath))
  }

  private generateId(): string {
    return `att_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  }
}

// 单例导出
export const fileAttachmentService = new FileAttachmentService()

/**
 * 统一的文档文本提取函数，根据后缀自动路由到对应的解析器
 */
export async function extractFileContent(
  filePath: string,
  maxChars: number
): Promise<{ content: string; charCount: number; truncated: boolean }> {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.docx' || ext === '.doc') {
    return extractDocxFile(filePath, maxChars)
  } else if (ext === '.pdf') {
    return extractPdfFile(filePath, maxChars)
  } else if (ext === '.xlsx' || ext === '.xls') {
    return extractExcelFile(filePath, maxChars)
  } else {
    return extractTextFile(filePath, maxChars)
  }
}


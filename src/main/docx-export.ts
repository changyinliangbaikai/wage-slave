/**
 * 工作总结导出为 Word 文档
 * 将 LLM 生成的 Markdown 格式总结文本转换为 .docx 文件
 */

import fs from 'fs'
import path from 'path'
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel,
  AlignmentType, BorderStyle, LevelFormat,
} from 'docx'

/** 用本地时间生成时间戳字符串，用于文件名 */
function localTimestamp(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}${m}${day}`
}

/**
 * 预处理文本：清除 <think> 块和残余 markdown 语法符号
 * MiniMax 等模型可能返回 <think>...</think> 推理过程
 */
function cleanText(text: string): string {
  // 1. 清除 <think>...</think> 块（含跨行）
  let cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, '')

  // 2. 清除可能残留的单独 <think> 或 </think> 标签
  cleaned = cleaned.replace(/<\/?think>/gi, '')

  // 3. 清除开头连续空行
  cleaned = cleaned.replace(/^\s*\n+/, '')

  return cleaned
}

/** 将 Markdown 格式的总结文本解析为 docx 段落 */
function parseMarkdownToParagraphs(text: string): Paragraph[] {
  const lines = text.split('\n')
  const paragraphs: Paragraph[] = []

  for (const line of lines) {
    const trimmed = line.trim()

    // 空行
    if (!trimmed) {
      paragraphs.push(new Paragraph({ children: [] }))
      continue
    }

    // 分隔线 --- （必须在列表项之前检测，避免被 - 列表项匹配）
    if (/^-{3,}$/.test(trimmed) || /^\*{3,}$/.test(trimmed)) {
      paragraphs.push(new Paragraph({
        children: [],
        border: {
          bottom: { style: BorderStyle.SINGLE, size: 6, color: 'CCCCCC', space: 1 },
        },
        spacing: { before: 120, after: 120 },
      }))
      continue
    }

    // 标题：从多个 # 到少个 # 的顺序匹配，避免 #### 被 # 先匹配到
    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/)
    if (headingMatch) {
      const level = headingMatch[1].length  // 1~6
      const content = headingMatch[2].trim()
      // docx HeadingLevel: HEADING_1 ~ HEADING_6 对应字符串值
      const headingLevels = [
        HeadingLevel.HEADING_1,
        HeadingLevel.HEADING_2,
        HeadingLevel.HEADING_3,
        HeadingLevel.HEADING_4,
        HeadingLevel.HEADING_5,
        HeadingLevel.HEADING_6,
      ]
      const sizes = [32, 28, 26, 24, 22, 22]  // 半磅为单位
      const spacingBefore = [240, 200, 160, 140, 120, 120]
      const spacingAfter = [120, 100, 80, 60, 60, 60]

      const idx = Math.min(level - 1, 5)
      paragraphs.push(new Paragraph({
        heading: headingLevels[idx],
        children: [new TextRun({
          text: content,
          bold: true,
          size: sizes[idx],
          font: 'Microsoft YaHei',
        })],
        spacing: { before: spacingBefore[idx], after: spacingAfter[idx] },
      }))
      continue
    }

    // 无序列表项 - 或 *（但不是分隔线）
    if (/^[-*]\s+/.test(trimmed)) {
      const content = trimmed.replace(/^[-*]\s+/, '')
      paragraphs.push(new Paragraph({
        children: parseInlineMarkdown(content),
        numbering: { reference: 'bullets', level: 0 },
        spacing: { before: 40, after: 40 },
      }))
      continue
    }

    // 有序列表项 1. 2. 等
    if (/^\d+\.\s+/.test(trimmed)) {
      const content = trimmed.replace(/^\d+\.\s+/, '')
      paragraphs.push(new Paragraph({
        children: parseInlineMarkdown(content),
        indent: { left: 480, hanging: 240 },
        spacing: { before: 40, after: 40 },
      }))
      continue
    }

    // 普通段落（处理行内 markdown 语法）
    paragraphs.push(new Paragraph({
      children: parseInlineMarkdown(trimmed),
      spacing: { before: 60, after: 60 },
    }))
  }

  return paragraphs
}

/**
 * 解析行内 Markdown 语法：**加粗**、*斜体*、`行内代码`、~~删除线~~
 * 按优先级依次匹配，转换为对应的 TextRun 样式
 */
function parseInlineMarkdown(text: string): TextRun[] {
  const runs: TextRun[] = []

  // 匹配行内 markdown 语法：**bold**, *italic*, `code`, ~~strikethrough~~
  // 优先匹配 ** (加粗)，再匹配 * (斜体)，避免冲突
  const regex = /\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`|~~(.+?)~~/g
  let lastIdx = 0
  let match: RegExpExecArray | null

  while ((match = regex.exec(text)) !== null) {
    // match 之前的普通文本
    if (match.index > lastIdx) {
      runs.push(new TextRun({
        text: text.slice(lastIdx, match.index),
        font: 'Microsoft YaHei',
        size: 24,
      }))
    }

    if (match[1] !== undefined) {
      // **加粗**
      runs.push(new TextRun({
        text: match[1],
        bold: true,
        font: 'Microsoft YaHei',
        size: 24,
      }))
    } else if (match[2] !== undefined) {
      // *斜体*
      runs.push(new TextRun({
        text: match[2],
        italics: true,
        font: 'Microsoft YaHei',
        size: 24,
      }))
    } else if (match[3] !== undefined) {
      // `行内代码`
      runs.push(new TextRun({
        text: match[3],
        font: 'Consolas',
        size: 22,
        color: '8B5E3C',
      }))
    } else if (match[4] !== undefined) {
      // ~~删除线~~
      runs.push(new TextRun({
        text: match[4],
        strike: true,
        font: 'Microsoft YaHei',
        size: 24,
      }))
    }

    lastIdx = match.index + match[0].length
  }

  // 剩余文本
  if (lastIdx < text.length) {
    runs.push(new TextRun({
      text: text.slice(lastIdx),
      font: 'Microsoft YaHei',
      size: 24,
    }))
  }

  // 兜底：如果整行没有任何 markdown 语法
  if (runs.length === 0) {
    runs.push(new TextRun({ text, font: 'Microsoft YaHei', size: 24 }))
  }

  return runs
}

/**
 * 导出工作总结为 Word 文档
 * @param text LLM 生成的总结文本（Markdown 格式）
 * @param periodLabel 时间段标签，如 "本周"、"4月"、"2026 Q1"
 * @param exportDir 导出目录
 * @returns 导出文件的完整路径
 */
export async function exportSummaryDocx(
  text: string,
  periodLabel: string,
  exportDir: string,
): Promise<string> {
  // 确保导出目录存在
  if (!fs.existsSync(exportDir)) {
    fs.mkdirSync(exportDir, { recursive: true })
  }

  const titleText = `工作总结 - ${periodLabel}`
  const cleaned = cleanText(text)
  const paragraphs = parseMarkdownToParagraphs(cleaned)

  const doc = new Document({
    numbering: {
      config: [{
        reference: 'bullets',
        levels: [{
          level: 0,
          format: LevelFormat.BULLET,
          text: '\u2022',
          alignment: AlignmentType.LEFT,
          style: {
            paragraph: { indent: { left: 720, hanging: 360 } },
          },
        }],
      }],
    },
    styles: {
      default: {
        document: {
          run: { font: 'Microsoft YaHei', size: 24 },
        },
      },
      paragraphStyles: [
        {
          id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal',
          quickFormat: true,
          run: { size: 32, bold: true, font: 'Microsoft YaHei' },
          paragraph: { spacing: { before: 240, after: 240 }, outlineLevel: 0 },
        },
        {
          id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal',
          quickFormat: true,
          run: { size: 28, bold: true, font: 'Microsoft YaHei' },
          paragraph: { spacing: { before: 180, after: 180 }, outlineLevel: 1 },
        },
        {
          id: 'Heading3', name: 'Heading 3', basedOn: 'Normal', next: 'Normal',
          quickFormat: true,
          run: { size: 26, bold: true, font: 'Microsoft YaHei' },
          paragraph: { spacing: { before: 160, after: 160 }, outlineLevel: 2 },
        },
      ],
    },
    sections: [{
      properties: {
        page: {
          size: { width: 12240, height: 15840 },
          margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
        },
      },
      children: [
        // 文档标题
        new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [new TextRun({
            text: titleText,
            bold: true,
            size: 36,
            font: 'Microsoft YaHei',
          })],
          spacing: { after: 120 },
        }),
        // 生成日期
        new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [new TextRun({
            text: `生成于 ${new Date().toLocaleDateString('zh-CN')}`,
            size: 20,
            color: '888888',
            font: 'Microsoft YaHei',
          })],
          spacing: { after: 360 },
        }),
        // 分隔线
        new Paragraph({
          children: [],
          border: {
            bottom: { style: BorderStyle.SINGLE, size: 6, color: 'D4874A', space: 1 },
          },
          spacing: { after: 240 },
        }),
        // 正文内容
        ...paragraphs,
      ],
    }],
  })

  const buffer = await Packer.toBuffer(doc)
  const fileName = `工作总结_${periodLabel}_${localTimestamp()}.docx`
  const filePath = path.join(exportDir, fileName)
  fs.writeFileSync(filePath, buffer)

  console.log(`[DocxExport] 导出成功: ${filePath}`)
  return filePath
}

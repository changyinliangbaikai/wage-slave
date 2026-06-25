/**
 * Web 网络工具实现：web_fetch / web_search
 *
 * 设计思路：
 *  - 不引入外部依赖，全部用 Node 22+ 内置 fetch + 极简 HTML 清理
 *  - web_fetch 把网页转为可读的纯文本（去掉 HTML 标签、脚本、样式）
 *  - web_search 直接抓取 DuckDuckGo HTML 端点的结果（无需 API key，免费可用）
 *
 * 安全约束：
 *  - 仅允许 http/https 协议
 *  - 单次响应最大 1MB，超出截断（防止大文件拖垮内存）
 *  - 超时 15 秒
 *  - 用户可在配置中关闭整组工具
 */

import log from 'electron-log/main'

const WEB_FETCH_TIMEOUT_MS = 15_000
const WEB_FETCH_MAX_BYTES = 1024 * 1024  // 1MB
const WEB_FETCH_DEFAULT_USER_AGENT = 'Mozilla/5.0 (XiaoNiuMa Agent)'

// ── web_fetch ───────────────────────────────────────────────────

export interface WebFetchArgs {
  url: string
  /** 返回的最大字符数，默认 8000，最大 50000 */
  max_chars?: number
}

export async function webFetch(args: WebFetchArgs): Promise<string> {
  const url = validateUrl(args.url)
  const maxChars = clamp(args.max_chars ?? 8000, 100, 50000)

  log.info(`[WebTools] fetch ${url}`)
  const { content, contentType, status } = await fetchUrl(url)

  if (status >= 400) {
    throw new Error(`HTTP ${status}：${url}`)
  }

  let text: string
  if (contentType.includes('html')) {
    text = htmlToText(content)
  } else if (contentType.includes('json')) {
    // JSON 直接美化输出
    try {
      text = JSON.stringify(JSON.parse(content), null, 2)
    } catch {
      text = content
    }
  } else {
    text = content
  }

  text = text.trim().replace(/\n{3,}/g, '\n\n')
  const truncated = text.length > maxChars
  const shown = truncated ? text.slice(0, maxChars) + `\n\n...[内容超过 ${maxChars} 字已截断]` : text

  const header = `[web_fetch: ${url}] HTTP ${status}, ${contentType || '未知类型'}, 共 ${text.length} 字${truncated ? '（已截断）' : ''}`
  return `${header}\n\n${shown}`
}

// ── web_search ───────────────────────────────────────────────────

export interface WebSearchArgs {
  query: string
  /** 返回的最大结果数，默认 5，最大 20 */
  max_results?: number
}

interface SearchResult {
  title: string
  url: string
  snippet: string
}

/**
 * 简易 web_search：通过 DuckDuckGo HTML 端点抓取搜索结果
 * 注意：HTML 端点是非官方 API，如果 DuckDuckGo 改版可能失效
 */
export async function webSearch(args: WebSearchArgs): Promise<string> {
  const query = String(args.query || '').trim()
  if (!query) throw new Error('query 不能为空')
  const maxResults = clamp(args.max_results ?? 5, 1, 20)

  // DuckDuckGo HTML 端点（不需要 API key）
  const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`
  log.info(`[WebTools] search "${query.slice(0, 80)}"`)

  let html: string
  try {
    const r = await fetchUrl(url)
    html = r.content
  } catch (e) {
    throw new Error(`搜索失败（网络不可用或被限制访问）：${(e as Error).message}`)
  }

  const results = parseDuckDuckGoResults(html, maxResults)
  if (results.length === 0) {
    return `[web_search: "${query}"] 未找到结果（可能是 DuckDuckGo 限流或返回页面结构改变）`
  }

  const lines = [`[web_search: "${query}"] 共 ${results.length} 条结果`]
  results.forEach((r, i) => {
    lines.push(`\n## ${i + 1}. ${r.title}\nURL: ${r.url}\n${r.snippet}`)
  })
  return lines.join('\n')
}

/** 解析 DuckDuckGo HTML 结果页面 */
function parseDuckDuckGoResults(html: string, max: number): SearchResult[] {
  // DuckDuckGo HTML 端点每条结果用 <div class="result"> 包裹
  // 简易正则解析：标题链接 + 摘要
  const results: SearchResult[] = []
  const blockRegex = /<div[^>]+class="result[^"]*"[\s\S]*?<\/div>\s*<\/div>/g
  const blocks = html.match(blockRegex) ?? []

  for (const block of blocks) {
    if (results.length >= max) break
    const titleMatch = block.match(/<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/)
    if (!titleMatch) continue
    const rawUrl = titleMatch[1]
    const title = stripTags(titleMatch[2]).trim()

    const snippetMatch = block.match(/<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/)
      || block.match(/<div[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/div>/)
    const snippet = snippetMatch ? stripTags(snippetMatch[1]).trim() : ''

    // DuckDuckGo 的链接是 //duckduckgo.com/l/?uddg=... 的跳转链接，要解出真实 URL
    let realUrl = rawUrl
    const uddgMatch = rawUrl.match(/[?&]uddg=([^&]+)/)
    if (uddgMatch) {
      try {
        realUrl = decodeURIComponent(uddgMatch[1])
      } catch {
        realUrl = rawUrl
      }
    } else if (realUrl.startsWith('//')) {
      realUrl = 'https:' + realUrl
    }

    if (title && realUrl) {
      results.push({ title, url: realUrl, snippet: snippet.slice(0, 300) })
    }
  }
  return results
}

// ── 工具函数 ────────────────────────────────────────────────────

function validateUrl(url: string): string {
  if (!url || typeof url !== 'string') throw new Error('url 不能为空')
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      throw new Error(`仅支持 http/https 协议，当前: ${u.protocol}`)
    }
    return u.toString()
  } catch (e) {
    throw new Error(`URL 格式非法: ${(e as Error).message}`)
  }
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n))
}

/** 拉取 URL 的内容（限制大小、超时、状态码）*/
async function fetchUrl(url: string): Promise<{ content: string; contentType: string; status: number }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), WEB_FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': WEB_FETCH_DEFAULT_USER_AGENT,
        'Accept': 'text/html,application/json,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
      redirect: 'follow',
    })
    const contentType = res.headers.get('content-type') || ''
    // 限制响应大小
    const reader = res.body?.getReader()
    if (!reader) {
      // 直接 text() 时仍按 max bytes 截断
      const text = (await res.text()).slice(0, WEB_FETCH_MAX_BYTES)
      return { content: text, contentType, status: res.status }
    }
    const chunks: Uint8Array[] = []
    let totalBytes = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (totalBytes + value.length > WEB_FETCH_MAX_BYTES) {
        chunks.push(value.subarray(0, WEB_FETCH_MAX_BYTES - totalBytes))
        totalBytes = WEB_FETCH_MAX_BYTES
        try { reader.cancel() } catch { /* ignore */ }
        break
      }
      chunks.push(value)
      totalBytes += value.length
    }
    const buf = Buffer.concat(chunks.map(c => Buffer.from(c)))
    const charset = parseCharsetFromContentType(contentType) || 'utf-8'
    const content = decodeBuffer(buf, charset)
    return { content, contentType, status: res.status }
  } finally {
    clearTimeout(timer)
  }
}

function parseCharsetFromContentType(contentType: string): string | null {
  const m = contentType.match(/charset=([\w-]+)/i)
  return m ? m[1].toLowerCase() : null
}

function decodeBuffer(buf: Buffer, charset: string): string {
  if (charset === 'utf-8' || charset === 'utf8') return buf.toString('utf-8')
  // Node Buffer 不直接支持 gbk/gb2312/euc-cn 等中文编码，退化到 utf-8
  // 真实项目可引入 iconv-lite，但 fetch 默认大部分网站都返回 UTF-8
  try {
    return buf.toString(charset as BufferEncoding)
  } catch {
    return buf.toString('utf-8')
  }
}

/** 把 HTML 简化为可读的纯文本 */
function htmlToText(html: string): string {
  // 删除 <script>...</script>
  let s = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
  // 删除 <style>...</style>
  s = s.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
  // 删除 <noscript>...</noscript>
  s = s.replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
  // 删除注释
  s = s.replace(/<!--[\s\S]*?-->/g, '')
  // 块级标签转换为换行（标题、段落、列表项等）
  s = s.replace(/<\/?(h[1-6]|p|div|section|article|aside|header|footer|nav|li|tr|br|hr)[^>]*>/gi, '\n')
  // 列表项前加 -
  s = s.replace(/<li[^>]*>/gi, '\n- ')
  // 删除其余所有标签
  s = stripTags(s)
  // 解码 HTML 实体（仅常用几个）
  s = decodeEntities(s)
  // 压缩多余空白
  s = s.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
  return s
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, '')
}

function decodeEntities(s: string): string {
  const map: Record<string, string> = {
    '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ',
    '&#39;': "'", '&copy;': '©', '&reg;': '®', '&hellip;': '…', '&mdash;': '—', '&ndash;': '–',
    '&laquo;': '«', '&raquo;': '»', '&middot;': '·', '&times;': '×', '&divide;': '÷',
  }
  return s
    .replace(/&[a-z]+;|&#\d+;/gi, m => {
      if (map[m]) return map[m]
      const numMatch = m.match(/^&#(\d+);$/)
      if (numMatch) {
        const code = parseInt(numMatch[1], 10)
        if (code > 0 && code < 0x10FFFF) {
          try { return String.fromCodePoint(code) } catch { return m }
        }
      }
      return m
    })
}

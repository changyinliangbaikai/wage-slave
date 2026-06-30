export interface PromptCacheMessage {
  role: string
  content?: string
  [key: string]: unknown
}

export interface CompressionTriggerConfig {
  keepRecent: number
  maxToolChars: number
  keepRecentTools: number
  triggerLevel1Chars: number
  triggerLevel2Chars: number
  triggerLevel3Chars: number
  triggerCount: number
}

export function buildRunScopedHistory<T extends PromptCacheMessage>(
  fullHistory: T[],
  runStartIndex: number,
  stablePrefixHistory: T[],
): T[] {
  const safeRunStart = Math.max(0, Math.min(runStartIndex, fullHistory.length))
  return [...stablePrefixHistory, ...fullHistory.slice(safeRunStart)]
}

export function appendRuntimeContextToUserContent(
  content: string,
  dynamicContext?: string,
  skillAdditionText?: string,
): string {
  const additions = [dynamicContext, skillAdditionText]
    .map(part => part?.trim())
    .filter((part): part is string => Boolean(part))

  if (additions.length === 0) return content
  return [content, ...additions].join('\n')
}

export function scaleCompressionConfigForContextWindow<T extends CompressionTriggerConfig>(
  config: T,
  contextWindow: number,
  referenceWindow: number,
): T {
  if (!Number.isFinite(contextWindow) || !Number.isFinite(referenceWindow) || referenceWindow <= 0) {
    return config
  }

  const scale = Math.max(1, Math.min(4, contextWindow / referenceWindow))
  if (scale === 1) return config

  return {
    ...config,
    triggerLevel1Chars: Math.floor(config.triggerLevel1Chars * scale),
    triggerLevel2Chars: Math.floor(config.triggerLevel2Chars * scale),
    triggerLevel3Chars: Math.floor(config.triggerLevel3Chars * scale),
    triggerCount: Math.floor(config.triggerCount * scale),
  }
}

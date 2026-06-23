import { randomUUID } from 'node:crypto'

export interface TraceEvent {
  eventId: string
  eventType: string
  timestamp: string
  projectId: string
  sessionId: string
  runId: string
  payload: Record<string, any>
  spanId?: string
  parentSpanId?: string
}

export class MemoryTraceCollector {
  private readonly sessionId: string
  private readonly runId: string
  private readonly events: TraceEvent[] = []

  constructor(sessionId: string) {
    this.sessionId = sessionId
    this.runId = randomUUID()
  }

  getRunId(): string {
    return this.runId
  }

  record(
    eventType: string,
    payload: Record<string, any>,
    extra?: { spanId?: string; parentSpanId?: string },
  ): void {
    const event: TraceEvent = {
      eventId: randomUUID(),
      eventType,
      timestamp: new Date().toISOString(),
      projectId: 'xiao-niu-ma-integration',
      sessionId: this.sessionId,
      runId: this.runId,
      payload: { ...payload },
    }

    if (extra?.spanId !== undefined) {
      event.spanId = extra.spanId
    }
    if (extra?.parentSpanId !== undefined) {
      event.parentSpanId = extra.parentSpanId
    }

    this.events.push(event)
  }

  toJSONL(): string {
    return this.events.map(event => JSON.stringify(event)).join('\n')
  }
}

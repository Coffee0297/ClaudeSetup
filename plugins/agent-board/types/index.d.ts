export type Seen = {
  id: string
  type: string
  desc: string
  model: string
  effort: string
  parent?: string
  status: string
  start: number
  end?: number
  tokens: number
  samples: number[]
  usd: number
}
export type Activity = { tool: string; detail: string; at: number }
export type LogLine = { at: number; who: string; text: string }
export type Lead = { turns: number; input: number; output: number; samples: number[] }

declare module 'claude-code' {
  interface PluginState {
    'agent-board': {
      seen: Shaped<Record<string, Seen>>
      activity: Shaped<Record<string, Activity>>
      log: Shaped<LogLine[]>
      lead: Shaped<Lead>
    }
  }
}

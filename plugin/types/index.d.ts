// One line of the client's per-session log (`wire log --json`): what this session saw and sent.
export type FeedEntry = {
  at: number
  kind: string
  line: string
  ref?: string
  contact?: string
  title?: string
  from?: string
  name?: string
  text?: string
  code?: string
}

declare module 'claude-code' {
  interface PluginState {
    wire: {
      feed: Shaped<FeedEntry[]>
      focus: string | null
      pending: Shaped<string[]>
      draft: number
    }
  }
}

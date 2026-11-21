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
  self?: string
  via?: string
  text?: string
  code?: string
  id?: number
  upto?: number
  waiting?: boolean
  by?: string
}

// What a contact shares about themselves: active / away (only if they turned presence on), and whether
// their Claude is listening.
export type Peer = { state: 'active' | 'away' | null; listening: boolean }

declare module 'claude-code' {
  interface PluginState {
    wire: {
      feed: Shaped<FeedEntry[]>
      focus: string | null
      pending: Shaped<string[]>
      draft: number
      expanded: Shaped<string[]>
      showAll: boolean
      peers: Shaped<Record<string, Peer>>
    }
  }
}

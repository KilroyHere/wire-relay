export type FeedLine = { at: number; line: string }

declare module 'claude-code' {
  interface PluginState {
    wire: {
      feed: Shaped<FeedLine[]>
      focus: string | null
      pending: Shaped<string[]>
    }
  }
}

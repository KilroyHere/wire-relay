import { expect, test } from 'claude-code/testing'

const ran = (exitCode: number, stdout: string, stderr = '') => ({
  exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false,
})
// Lets work the plugin started without awaiting (its listener, a pressed button) run to where it waits.
const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 500; turn += 1) {
    await Promise.resolve()
  }
}

const REF = 'alt/TtaIbvkn'
// What `wire log --json` prints: one session's conversation with "alt", and a lobby notice from "bo".
const LOG = [
  { at: 1, kind: 'joined', contact: 'alt', code: '🔥 🌲 🛸 ⚡ 21', line: '🤝 alt is paired with you but NOT verified yet.' },
  { at: 2, kind: 'local', contact: 'alt', ref: REF, title: 'testing', line: '↗ [alt/TtaIbvkn "testing"] you opened this conversation' },
  { at: 3, kind: 'msg', contact: 'alt', ref: REF, title: 'testing', from: 'human', name: 'alt', text: 'lunch at 1?', line: '📨 [alt/TtaIbvkn "testing"] alt [human]: lunch at 1?' },
  { at: 4, kind: 'sent', contact: 'alt', ref: REF, from: 'human', text: 'yes', line: '↗ [alt/TtaIbvkn] you: yes' },
  { at: 5, kind: 'msg', contact: 'alt', ref: REF, title: 'testing', from: 'agent', name: 'alt', text: 'ready?', line: '📨 [alt/TtaIbvkn "testing"] Claude (alt) [agent]: ready?' },
  { at: 6, kind: 'lobby', contact: 'bo', ref: 'bo/Zz91kQpA', title: 'deploy', line: '🔔 [bo/Zz91kQpA "deploy"] bo wants to talk' },
].map(one => JSON.stringify(one)).join('\n')

const PANE = {
  plugin: 'wire',
  component: 'Pane',
  requestId: 'wire',
  props: {
    title: 'wire',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

// The stand-ins every test needs: the client (`wire ...`), panes, and the calls that draw nothing here.
type Runs = { argv: readonly string[]; stdin?: string }[]

test('the panel shows the conversation in focus and its text box sends as the person', async ($, on) => {
  const runs: Runs = []
  let entered = 0
  on('process.hookEnv', () => ({ value: { CLAUDE_PLUGIN_ROOT: '/plugin' } }))
  on('process.run', (_, e) => {
    runs.push({ argv: e.argv, stdin: e.init?.stdin })

    return { value: ran(0, e.argv.includes('log') ? LOG : `sent to ${REF} as Main`) }
  })
  on('ui.panes', () => ({ value: [{ id: 'wire', title: 'wire', isShown: true, isFocused: false, isPlaced: true }] }))
  on('clock.now', () => ({ value: 10 * 60_000 }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.scroll', () => ({}))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('command.run', () => ({}))
  on('prompt.submit', (_, e) => {
    entered += 1

    return { text: e.text }
  })

  // /wire reads the log into the panel.
  await $.command.run({
    command: 'wire',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 200 },
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })

    // The header: who, and what about.
    expect(await ui.find({ type: 'Text', text: /^alt$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^testing$/ })).toBeDefined()
    // Notices are in plain words, without ids.
    expect(await ui.find({ type: 'Text', text: /^You started this conversation$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /lunch at 1\?/ })).toBeDefined()
    // Names sit above each run of messages, with a time.
    expect(await ui.find({ type: 'Text', text: /^alt's Claude · / })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^You · / })).toBeDefined()
    // The person's last message says whether it arrived.
    expect(await ui.find({ type: 'Text', text: /^(Sent|Delivered|Waiting)/ })).toBeDefined()
    // The lobby notice and the unverified contact each come with a button.
    expect(await ui.find({ type: 'Button', key: 'take-bo/Zz91kQpA' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'verify-alt' })).toBeDefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.input({ key: 'say-0', text: '> on my way' })
  await settle()

  // The same text again within seconds (a double Enter) is not sent twice.
  await ui.input({ key: 'say-1', text: 'on my way' })
  await settle()

  const sends = runs.filter(one => one.argv.includes('send'))
  expect(sends).toHaveLength(1)
  expect(sends[0]?.argv).toEqual(['node', '/plugin/client/wire.mjs', 'send', '--as', 'human', '--typed', '--to', REF])
  expect(sends[0]?.stdin).toBe('on my way')
  // No model turn for it, and a fresh, empty text box.
  expect(entered).toBe(0)
  expect(await ui.find({ type: 'Input', key: 'say-1' })).toBeDefined()

  await ui.press({ key: 'take-bo/Zz91kQpA' })
  await settle()
  expect(runs.some(one => one.argv.join(' ').endsWith('take bo/Zz91kQpA'))).toBe(true)
  await ui.unmount()
})

test('a line starting with > is sent as the person and starts no model turn', async ($, on) => {
  const runs: Runs = []
  let entered = 0
  on('process.hookEnv', () => ({ value: { CLAUDE_PLUGIN_ROOT: '/plugin' } }))
  on('process.run', (_, e) => {
    runs.push({ argv: e.argv, stdin: e.init?.stdin })

    return { value: ran(0, e.argv.includes('log') ? LOG : `sent to ${REF} as Main`) }
  })
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'narrow' } }))
  on('ui.scroll', () => ({}))
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('prompt.submit', (_, e) => {
    entered += 1

    return { text: e.text }
  })

  await $.prompt.submit({ text: '> ship it', origin: { kind: 'composer' }, wait: false })

  const sends = runs.filter(one => one.argv.includes('send'))
  expect(entered).toBe(0)
  expect(sends).toHaveLength(1)
  expect(sends[0]?.stdin).toBe('ship it')
})

test('an ordinary prompt goes to the model untouched', async ($, on) => {
  const texts: string[] = []
  on('prompt.submit', (_, e) => {
    texts.push(e.text)

    return { text: e.text }
  })

  await $.prompt.submit({ text: 'fix the build', origin: { kind: 'composer' }, wait: false })

  expect(texts).toEqual(['fix the build'])
})

test('with no conversation to send to, a > line is an ordinary prompt', async ($, on) => {
  let entered = 0
  on('process.hookEnv', () => ({ value: { CLAUDE_PLUGIN_ROOT: '/plugin' } }))
  on('process.run', () => ({ value: ran(1, '', 'No conversation is attached to this session.') }))
  on('prompt.submit', (_, e) => {
    entered += 1

    return { text: e.text }
  })

  await $.prompt.submit({ text: '> a quoted line', origin: { kind: 'composer' }, wait: false })

  expect(entered).toBe(1)
})

test('a message from the other Claude starts a turn; one from the person stays out of the main thread', async ($, on) => {
  const prompts: { text: string; context?: readonly string[] }[] = []
  const logged: string[] = []
  const events = [
    { kind: 'msg', from: 'agent', ref: REF, name: 'alt', text: 'ready?', line: '📨 [alt/TtaIbvkn "testing"] Claude (alt) [agent]: ready?' },
    { kind: 'msg', from: 'human', ref: REF, name: 'alt', text: 'lunch at 1?', line: '📨 [alt/TtaIbvkn "testing"] alt [human]: lunch at 1?' },
  ]
  on('process.hookEnv', () => ({ value: { CLAUDE_PLUGIN_ROOT: '/plugin' } }))
  on('process.run', (_, e) => ({ value: ran(0, e.argv.includes('log') ? LOG : '') }))
  on('process.spawn', async function* () {
    yield { stream: 'stdout' as const, text: events.map(one => JSON.stringify(one)).join('\n') + '\n' }

    return { value: { code: 0, signal: null } }
  })
  on('clock.sleep', () => new Promise<never>(() => undefined))
  on('command.register', () => ({ value: { command: 'wire' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__wire__panel' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.panes', () => ({ value: [{ id: 'wire', title: 'wire', isShown: true, isFocused: false, isPlaced: true }] }))
  on('ui.scroll', () => ({}))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', (_, e) => {
    logged.push(JSON.stringify(e))

    return { value: undefined }
  })
  on('prompt.submit', (_, e) => {
    prompts.push({ text: e.text, context: e.context })

    return { text: e.text }
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  // The listener runs on after session.start returns: wait until it has delivered both events.
  for (let round = 0; round < 200 && prompts.length === 0; round += 1) {
    await settle()
  }

  await settle()

  // Only the agent's message became a prompt; with the panel up, nothing was added to the transcript.
  expect(prompts.map(one => one.text)).toEqual([events[0]!.line])
  expect(logged.join('\n')).not.toContain('lunch at 1')

  await $.prompt.submit({ text: 'what did alt say?', origin: { kind: 'composer' }, wait: false })

  expect(prompts[1]?.context?.join('\n')).toContain('lunch at 1')
})

test('/wire prints the conversation where the app shows no panel', async ($, on) => {
  on('process.hookEnv', () => ({ value: { CLAUDE_PLUGIN_ROOT: '/plugin' } }))
  on('process.run', (_, e) => ({ value: ran(0, e.argv.includes('log') ? LOG : 'alt (verified ✓)') }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'no surface places panes' } }))
  on('ui.scroll', () => ({}))
  on('ui.status', () => ({ value: undefined }))
  on('command.run', () => ({}))

  const out = await $.command.run({
    command: 'wire',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 100 },
  })

  expect(out.text).toContain('alt (verified ✓)')
  expect(out.text).toContain('alt: lunch at 1?')
  expect(out.text).toContain('You: yes')
  expect(out.text).toContain('no surface places panes')
})

test('the panel tool lets Claude read what the panel shows', async ($, on) => {
  on('process.hookEnv', () => ({ value: { CLAUDE_PLUGIN_ROOT: '/plugin' } }))
  on('process.run', (_, e) => ({ value: ran(0, e.argv.includes('log') ? LOG : '') }))
  on('ui.panes', () => ({ value: [{ id: 'wire', title: 'wire', isShown: true, isFocused: false, isPlaced: true }] }))
  on('ui.scroll', () => ({}))
  on('ui.status', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 10 * 60_000 }))
  on('tool.call', () => ({ result: 'not ours' }))

  const read = await $.tool.call({ tool: 'mcp__wire__panel', ref: REF })

  expect(String(read.result)).toContain('alt · testing')
  expect(String(read.result)).toContain('lunch at 1?')
  expect(String(read.result)).toContain('[lobby]')
})

test('each tab sends to its own conversation', async ($, on) => {
  const TOPIC = 'alt/Rk2PqZ8a'
  const runs: Runs = []
  const log = [
    LOG,
    JSON.stringify({ at: 7, kind: 'local', contact: 'alt', ref: TOPIC, title: 'release', line: '↗ opened' }),
    JSON.stringify({ at: 8, kind: 'msg', contact: 'alt', ref: TOPIC, title: 'release', from: 'human', name: 'alt', text: 'notes?', line: '📨 alt: notes?' }),
  ].join('\n')
  const opened: string[] = []
  on('process.hookEnv', () => ({ value: { CLAUDE_PLUGIN_ROOT: '/plugin' } }))
  on('process.run', (_, e) => {
    runs.push({ argv: e.argv, stdin: e.init?.stdin })

    return { value: ran(0, e.argv.includes('log') ? log : 'sent') }
  })
  on('ui.panes', () => ({ value: opened.map(id => ({ id, title: id, isShown: id === opened.at(-1), isFocused: false, isPlaced: true })) }))
  on('ui.open', (_, e) => {
    if (!opened.includes(e.id)) {
      opened.push(e.id)
    }

    return { value: { isPlaced: true } }
  })
  on('ui.close', () => ({ value: undefined }))
  on('ui.scroll', () => ({}))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 10 * 60_000 }))
  on('command.run', () => ({}))

  await $.command.run({ command: 'wire', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } })

  // Two conversations open in the session: two tabs.
  const tabIds = opened.filter(id => id.startsWith('c-'))
  expect(tabIds).toHaveLength(2)

  for (const [index, id] of tabIds.entries()) {
    const ui = await $.ui.mount({ ...PANE, requestId: id, surface: 'desktop' })
    // The text box is keyed by a counter that moves on after each send.
    const box = await ui.find({ type: 'Input' })
    await ui.input({ key: String(box?.key), text: `hello tab ${index}` })
    await settle()
    await ui.unmount()
  }

  const sends = runs.filter(one => one.argv.includes('send'))
  const targets = sends.map(one => one.argv.at(-1))
  expect(new Set(targets)).toEqual(new Set([REF, TOPIC]))
  expect(sends.map(one => one.stdin)).toEqual(['hello tab 0', 'hello tab 1'])
})

import { expect, test } from 'claude-code/testing'

const ran = (exitCode: number, stdout: string, stderr = '') => ({
  exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false,
})
const SENT = ran(0, 'sent to alt/TtaIbvkn as Main')
// Lets work the plugin started without awaiting (its listener) run to where it waits.
const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 500; turn += 1) {
    await Promise.resolve()
  }
}

test('a line starting with > is sent as the person and starts no model turn', async ($, on) => {
  const runs: string[] = []
  let entered = 0
  on('process.hookEnv', () => ({ value: { CLAUDE_PLUGIN_ROOT: '/plugin' } }))
  on('process.run', (_, e) => {
    runs.push(JSON.stringify(e))

    return { value: SENT }
  })
  on('clock.now', () => ({ value: 1 }))
  on('prompt.submit', (_, e) => {
    entered += 1

    return { text: e.text }
  })

  await $.prompt.submit({ text: '> ship it', origin: { kind: 'composer' }, wait: false })

  expect(entered).toBe(0)
  expect(runs.length).toBe(1)
  expect(runs[0]).toContain('"--as","human"')
  expect(runs[0]).toContain('ship it')
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
  on('process.run', () => ({
    value: ran(1, '', 'No conversation is attached to this session.'),
  }))
  on('prompt.submit', (_, e) => {
    entered += 1

    return { text: e.text }
  })

  await $.prompt.submit({ text: '> a quoted line', origin: { kind: 'composer' }, wait: false })

  expect(entered).toBe(1)
})

test('a message from the other Claude starts a turn; one from the person only waits as context', async ($, on) => {
  const prompts: { text: string; context?: readonly string[] }[] = []
  const logged: string[] = []
  const events = [
    { kind: 'msg', from: 'agent', ref: 'alt/TtaIbvkn', line: '📨 [alt/TtaIbvkn "testing"] Claude (alt) [agent]: ready?' },
    { kind: 'msg', from: 'human', ref: 'alt/TtaIbvkn', line: '📨 [alt/TtaIbvkn "testing"] alt [human]: lunch at 1' },
  ]
  on('process.hookEnv', () => ({ value: { CLAUDE_PLUGIN_ROOT: '/plugin' } }))
  on('process.run', () => ({ value: ran(0, '') }))
  on('process.spawn', async function* () {
    yield { stream: 'stdout' as const, text: events.map(one => JSON.stringify(one)).join('\n') + '\n' }

    return { value: { code: 0, signal: null } }
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 1 }))
  on('clock.sleep', () => new Promise<never>(() => undefined))
  on('command.register', () => ({ value: { command: 'wire' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.log', (_, e) => {
    logged.push(JSON.stringify(e))

    return { value: undefined }
  })
  on('prompt.submit', (_, e) => {
    prompts.push({ text: e.text, context: e.context })

    return { text: e.text }
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await settle()

  expect(prompts.map(one => one.text)).toEqual([events[0]!.line])
  expect(logged.join('\n')).toContain('lunch at 1')

  await $.prompt.submit({ text: 'what did alt say?', origin: { kind: 'composer' }, wait: false })

  expect(prompts[1]?.context?.join('\n')).toContain('lunch at 1')
})

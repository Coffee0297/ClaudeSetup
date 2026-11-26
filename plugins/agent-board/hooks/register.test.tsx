import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'agent-board',
  component: 'Pane',
  requestId: 'agent-board',
  props: {
    title: 'Agent Board',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const AGENT = {
  id: 'a1',
  description: 'Add CSV export',
  type: 'builder',
  status: 'running',
  kind: 'local_agent',
  taskStatus: 'running',
  label: 'builder',
  startTime: 1_000,
  cwd: '/',
  model: 'claude-sonnet-5-5',
  tokenCount: 48_000,
  tokenSamples: [1000, 8000, 20000, 48000],
  cost: { usd: 0.5 },
  hasRow: true,
}

function engine(on: any, agents: unknown[] = [AGENT]) {
  on('command.register', () => ({ value: { command: 'board' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000, tokens: 140_000, percent: 14 }, rateLimits: [], cost: { usd: 2 } } }))
  on('settings.read', () => ({ value: { advisorModel: 'fable' } }))
  on('clock.now', () => ({ value: 61_000 }))
  on('clock.every', () => ({ value: {} }))
  on('agent.list', () => ({ value: agents }))
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'a1' }))
  on('tool.call', () => ({ result: {} }))
}

test('the board shows the lead, a running agent with its model, tokens and cost share', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.agent.spawn({ tool_use_id: 't1', prompt: 'do it', description: 'Add CSV export', subagentType: 'builder', parentModel: 'claude-opus-5-5' } as any)
  await $.tool.call({ tool: 'Edit', file_path: 'C:/repo/src/export.ts', old_string: 'a', new_string: 'b', agentId: 'a1' } as any)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /opus 5\.5/ }))?.text).toContain('opus 5.5')
  expect((await ui.find({ type: 'Text', text: /advisor fable/ }))?.text).toContain('fable')
  expect((await ui.find({ type: 'Text', text: /sonnet 5\.5/ }))?.text).toContain('sonnet 5.5')
  expect((await ui.find({ type: 'Text', text: /^48k$/ }))).toBeTruthy()
  expect(await ui.find({ type: 'Raster' })).toBeTruthy()
  expect((await ui.find({ type: 'Text', text: /export\.ts/ }))).toBeTruthy()
  expect((await ui.find({ type: 'Text', text: /builder on sonnet 5\.5/ }))).toBeTruthy()
  await ui.unmount()
})

test('an empty session draws without errors in the terminal', async ($, on) => {
  engine(on, [])
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /none running/ }))).toBeTruthy()
  await ui.unmount()
})

test('desktop and mobile get one vector drawing with the agent in it', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.agent.spawn({ tool_use_id: 't1', prompt: 'do it', description: 'Add CSV export', subagentType: 'builder', parentModel: 'claude-opus-5-5' } as any)
  for (const surface of ['desktop', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const svgs: any[] = await ui.findAll({ type: 'Svg' })
    expect(svgs.length).toBe(4) // top, dispatch (builder running), spend, share; no reports yet
    const src = svgs.map(x => String(x?.props?.source ?? '')).join('')
    expect(src).toContain('<svg')
    expect(src).toContain('builder')
    expect(src).toContain('sonnet 5.5')
    for (const x of svgs) expect(String(x?.props?.source ?? '').length).toBeLessThan(131072)
    expect(src).toContain('SPEND RATE')
    await ui.unmount()
  }
})

test('no running subagents: no dispatch blocks are drawn', async ($, on) => {
  engine(on, [{ ...AGENT, status: 'completed', taskStatus: 'completed' }])
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.agent.spawn({ tool_use_id: 't1', prompt: 'do it', description: 'Add CSV export', subagentType: 'builder', parentModel: 'claude-opus-5-5' } as any)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const svgs: any[] = await ui.findAll({ type: 'Svg' })
  const src = svgs.map(x => String(x?.props?.source ?? '')).join('')
  expect(src).not.toContain('Task tool')
  expect(svgs.length).toBe(4) // top, done list, spend, share
  expect(src).toContain('DONE')
  expect(src).toContain('✓ ok')
  await ui.unmount()
})

test('terminal: a finished agent moves to the DONE list with ok and its time', async ($, on) => {
  engine(on, [{ ...AGENT, status: 'completed', taskStatus: 'completed' }, { ...AGENT, id: 'a2', type: 'Explore', model: 'claude-haiku-5-5', status: 'failed', taskStatus: 'failed' }])
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.agent.spawn({ tool_use_id: 't1', prompt: 'x', description: 'x', subagentType: 'builder', parentModel: 'claude-opus-5-5' } as any)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^DONE/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /✓ ok/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /✗ fail/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /none running/ })).toBeTruthy()
  await ui.unmount()
})

test('terminal: the advisor gets its own row with its call count', async ($, on) => {
  engine(on, [])
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /◆ advisor fable/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /0 calls/ })).toBeTruthy()
  await ui.unmount()
})

const HOURMS = 3600000
const NOW = Date.parse('2026-11-26T12:00:00Z')
function limitsEngine(on: any, accountBody: unknown | null) {
  on('command.register', () => ({ value: { command: 'board' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1e6, tokens: 1000, percent: 1 }, rateLimits: [
    { kind: 'five_hour', percentUsed: 80, resetsAt: new Date(NOW + 2 * HOURMS).toISOString() },
    { kind: 'seven_day', percentUsed: 9, resetsAt: new Date(NOW + 5 * 24 * HOURMS).toISOString() },
  ], cost: { usd: 1 } } }))
  on('settings.read', () => ({ value: { advisorModel: 'fable' } }))
  on('clock.now', () => ({ value: NOW }))
  on('clock.every', () => ({ value: {} }))
  on('clock.sleep', () => ({ value: undefined }))
  on('agent.list', () => ({ value: [] }))
  on('session.authorize', () => ({ value: accountBody === null ? null : { handle: 'h1', kind: 'bearer' } }))
  on('http.fetch', () => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(accountBody) } }))
}

test('limits: 5h, week and Fable week from the account, with an ETA', async ($, on) => {
  limitsEngine(on, { rows: [
    { kind: 'session', group: 'session', percent: 80, resets_at: new Date(NOW + 2 * HOURMS).toISOString() },
    { kind: 'weekly_all', group: 'weekly', percent: 9, resets_at: new Date(NOW + 5 * 24 * HOURMS).toISOString() },
    { kind: 'weekly_scoped', group: 'weekly', percent: 4, resets_at: new Date(NOW + 5 * 24 * HOURMS).toISOString(), scope: { model: { display_name: 'Fable' } } },
  ] })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^5h/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^Week Fable/ })).toBeTruthy()
  // 5h: 80% after 3 of 5 hours -> 100% in ~45 min, before the reset in 2 h
  expect(await ui.find({ type: 'Text', text: /full ≈ .*in 4\dm \(average pace\)/ })).toBeTruthy()
  // week: 9% after 2 of 7 days -> resets first
  expect(await ui.find({ type: 'Text', text: /resets before full/ })).toBeTruthy()
  await ui.unmount()
  const d = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const svgs: any[] = await d.findAll({ type: 'Svg' })
  const src = svgs.map(x => String(x?.props?.source ?? '')).join('')
  expect(src).toContain('PLAN LIMITS')
  expect(src).toContain('Week Fable')
  await d.unmount()
})

test('limits: keyed account format and no-account fallback', async ($, on) => {
  limitsEngine(on, { five_hour: { utilization: 12, resets_at: new Date(NOW + 4 * HOURMS).toISOString() }, seven_day_fable: { utilization: 3, resets_at: null }, seven_day_oauth_apps: null })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^Week Fable/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^Week\s/ })).toBeTruthy()
  await ui.unmount()
})

test('limits: without an account credential, 5h and week still show', async ($, on) => {
  limitsEngine(on, null)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^5h/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /from responses/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^Week Fable/ })).toBeFalsy()
  await ui.unmount()
})

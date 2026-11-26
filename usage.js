#!/usr/bin/env node
// Token log for tuning the agent setup. Reads Claude Code transcripts; no model calls, no network.
//   node usage.js log <session.jsonl> <trigger>  append one session summary to ~/.claude/usage-log.jsonl
//   node usage.js report [days]                  summary of the last N days (default 7): per model and role,
//                                                per agent type, per project, top sessions, tool errors, flags
// Logged by the tlm-core hook on /handoff and at session end (/clear, exit). Entries are cumulative per
// session, so the report keeps only the newest entry of each session.
const fs = require('fs')
const os = require('os')
const path = require('path')

const CFG = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
const LOG = path.join(CFG, 'usage-log.jsonl')

const lines = f => {
  let t
  try { t = fs.readFileSync(f, 'utf8') } catch { return [] }
  return t.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
}
const zero = () => ({ calls: 0, in: 0, cacheWrite: 0, cacheRead: 0, out: 0 })
function add(t, u) {
  t.calls++
  t.in += u.input_tokens || 0
  t.cacheWrite += u.cache_creation_input_tokens || 0
  t.cacheRead += u.cache_read_input_tokens || 0
  t.out += u.output_tokens || 0
}
const sum = t => t.in + t.cacheWrite + t.cacheRead + t.out
const tool = (m, n) => (m[n] = m[n] || { calls: 0, errors: 0 })

// one transcript -> per-model usage (deduped by message id), advisor usage, peak context, tool calls/errors, prompts
function scan(file) {
  const r = { models: {}, advisor: {}, maxContext: 0, maxAdvisorRead: 0, tools: {}, prompts: [], start: null, end: null, cwd: null, branch: null }
  const seen = new Set(), names = {}
  for (const o of lines(file)) {
    if (o.timestamp) { r.start = r.start || o.timestamp; r.end = o.timestamp }
    if (o.cwd) { r.cwd = o.cwd; r.branch = o.gitBranch || r.branch }
    const m = o.message
    if (o.type === 'assistant' && m && m.usage) {
      // streamed content blocks share one message id: count each tool_use, but the usage only once
      for (const b of Array.isArray(m.content) ? m.content : []) if (b.type === 'tool_use') { names[b.id] = b.name; tool(r.tools, b.name).calls++ }
      const id = m.id || o.requestId
      if (seen.has(id)) continue
      seen.add(id)
      const its = m.usage.iterations && m.usage.iterations.length ? m.usage.iterations : [m.usage]
      for (const it of its) {
        if (it.type === 'advisor_message') {
          const k = it.model || 'advisor'
          add(r.advisor[k] = r.advisor[k] || zero(), it)
          r.maxAdvisorRead = Math.max(r.maxAdvisorRead, (it.input_tokens || 0) + (it.cache_read_input_tokens || 0))
        } else {
          add(r.models[m.model] = r.models[m.model] || zero(), it)
          r.maxContext = Math.max(r.maxContext, (it.input_tokens || 0) + (it.cache_creation_input_tokens || 0) + (it.cache_read_input_tokens || 0))
        }
      }
    }
    if (o.type === 'user' && m && !o.isSidechain) {
      const c = m.content
      if (Array.isArray(c)) for (const b of c) if (b.type === 'tool_result' && b.is_error) tool(r.tools, names[b.tool_use_id] || '?').errors++
      const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter(b => b.type === 'text').map(b => b.text).join(' ') : ''
      const clean = text.replace(/<(system-reminder|task-notification)>[\s\S]*?<\/\1>/g, '')
        .replace(/<\/?pasted_content[^>]*>/g, '').replace(/\s+/g, ' ').trim()
      if (clean && !o.isMeta && !clean.startsWith('<') && !clean.startsWith('[SYSTEM NOTIFICATION')) r.prompts.push(clean.slice(0, 200))
    }
  }
  return r
}

function log(file, trigger) {
  const lead = scan(file), dir = file.replace(/\.jsonl$/, ''), agents = []
  let title
  try { title = JSON.parse(fs.readFileSync(path.join(dir, 'custom-title.json'), 'utf8')).customTitle } catch {}
  const sub = path.join(dir, 'subagents')
  for (const f of (fs.existsSync(sub) ? fs.readdirSync(sub) : []).filter(f => /^agent-.*\.jsonl$/.test(f))) {
    let meta = {}
    try { meta = JSON.parse(fs.readFileSync(path.join(sub, f.replace(/\.jsonl$/, '.meta.json')), 'utf8')) } catch {}
    const s = scan(path.join(sub, f))
    agents.push({ type: meta.agentType || '?', description: (meta.description || '').slice(0, 80), models: s.models, maxContext: s.maxContext, tools: s.tools })
  }
  let state
  try {
    const m = fs.readFileSync(path.join(lead.cwd, 'CLAUDE.local.md'), 'utf8').match(/## Current state\r?\n([\s\S]*?)(\r?\n## |$)/)
    state = m && m[1].trim().slice(0, 800)
  } catch {}
  const e = {
    ts: new Date().toISOString(), trigger, session: path.basename(dir), title, cwd: lead.cwd, branch: lead.branch,
    start: lead.start, end: lead.end, prompts: { count: lead.prompts.length, first: lead.prompts[0], last: lead.prompts.slice(-3) }, state,
    lead: { models: lead.models, maxContext: lead.maxContext, tools: lead.tools },
    advisor: { models: lead.advisor, maxRead: lead.maxAdvisorRead }, agents,
  }
  fs.mkdirSync(CFG, { recursive: true })
  fs.appendFileSync(LOG, JSON.stringify(e) + '\n')
}

const k = n => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n)
const short = m => String(m).replace(/^claude-/, '')

function report(days) {
  const since = Date.now() - days * 864e5, last = {}
  for (const e of lines(LOG)) if (Date.parse(e.ts) >= since) last[e.session] = e
  const S = Object.values(last)
  if (!S.length) return console.log(`No sessions logged in the last ${days} days (${LOG}).`)

  const role = {}, agentType = {}, project = {}, tools = {}, flags = []
  const put = (role_, models) => { for (const [m, t] of Object.entries(models)) { const x = (role[`${short(m)}|${role_}`] = role[`${short(m)}|${role_}`] || zero()); for (const f in x) x[f] += t[f] } }
  const tot = models => Object.values(models).reduce((a, t) => a + sum(t), 0)
  const outOf = models => Object.values(models).reduce((a, t) => a + t.out, 0)
  const rows = []
  for (const e of S) {
    put('lead', e.lead.models)
    put('advisor', e.advisor.models)
    let agentsTot = 0, agentsOut = 0
    for (const a of e.agents) {
      put(`agent:${a.type}`, a.models)
      const t = agentType[a.type] = agentType[a.type] || { runs: 0, tokens: 0, maxCtx: 0, models: new Set() }
      t.runs++; t.tokens += tot(a.models); t.maxCtx = Math.max(t.maxCtx, a.maxContext)
      Object.keys(a.models).forEach(m => t.models.add(short(m)))
      agentsTot += tot(a.models); agentsOut += outOf(a.models)
      for (const [n, c] of Object.entries(a.tools)) { const x = tool(tools, n); x.calls += c.calls; x.errors += c.errors }
    }
    for (const [n, c] of Object.entries(e.lead.tools)) { const x = tool(tools, n); x.calls += c.calls; x.errors += c.errors }
    const leadTot = tot(e.lead.models), advTot = tot(e.advisor.models), all = leadTot + agentsTot + advTot
    const p = path.basename(e.cwd || '?'); project[p] = project[p] || { sessions: 0, tokens: 0 }; project[p].sessions++; project[p].tokens += all
    const advCalls = Object.values(e.advisor.models).reduce((a, t) => a + t.calls, 0)
    const errs = Object.values(e.lead.tools).reduce((a, t) => a + t.errors, 0) + e.agents.reduce((a, x) => a + Object.values(x.tools).reduce((b, t) => b + t.errors, 0), 0)
    const name = (e.title || e.prompts.first || e.session).slice(0, 70)
    rows.push({ name, p, all, leadShare: all ? leadTot / all : 0, ctx: e.lead.maxContext, advCalls, agents: e.agents.length, errs })
    // heuristics: each says what to tweak and why
    const leadOut = outOf(e.lead.models)
    if (e.lead.maxContext > 150e3) flags.push(`${name}: lead context peaked at ${k(e.lead.maxContext)}; every turn re-reads it. Handoff and /clear earlier.`)
    if (e.advisor.maxRead > 150e3) flags.push(`${name}: advisor read ${k(e.advisor.maxRead)} uncached in one call. Ask it after handoff and /clear.`)
    if (leadOut > 20e3 && leadOut > agentsOut) flags.push(`${name}: lead wrote ${k(leadOut)} output tokens vs ${k(agentsOut)} by agents. It did the work itself; brief builders instead.`)
    const searches = ['Read', 'Grep', 'Glob'].reduce((a, n) => a + ((e.lead.tools[n] || {}).calls || 0), 0)
    if (searches > 30 && !e.agents.some(a => a.type === 'Explore')) flags.push(`${name}: lead made ${searches} Read/Grep/Glob calls and used no Explore agent.`)
  }

  const out = []
  out.push(`# Usage, last ${days} days: ${S.length} sessions (${LOG})`, '', 'Tokens per model and role. Cache reads are context re-reads; how much they weigh against Max limits is not documented.', '')
  out.push('| model | role | calls | input | cache write | cache read | output | total |', '|---|---|---|---|---|---|---|---|')
  for (const [key, t] of Object.entries(role).sort((a, b) => sum(b[1]) - sum(a[1]))) {
    const [m, r] = key.split('|')
    out.push(`| ${m} | ${r} | ${t.calls} | ${k(t.in)} | ${k(t.cacheWrite)} | ${k(t.cacheRead)} | ${k(t.out)} | ${k(sum(t))} |`)
  }
  out.push('', '## Agent types', '', '| type | runs | models | tokens | avg/run | peak context |', '|---|---|---|---|---|---|')
  for (const [n, t] of Object.entries(agentType).sort((a, b) => b[1].tokens - a[1].tokens))
    out.push(`| ${n} | ${t.runs} | ${[...t.models].join(', ')} | ${k(t.tokens)} | ${k(Math.round(t.tokens / t.runs))} | ${k(t.maxCtx)} |`)
  out.push('', '## Projects', '', '| project | sessions | tokens |', '|---|---|---|')
  for (const [n, t] of Object.entries(project).sort((a, b) => b[1].tokens - a[1].tokens)) out.push(`| ${n} | ${t.sessions} | ${k(t.tokens)} |`)
  out.push('', '## Top sessions', '', '| session | project | tokens | lead share | lead peak ctx | advisor calls | agents | tool errors |', '|---|---|---|---|---|---|---|---|')
  for (const r of rows.sort((a, b) => b.all - a.all).slice(0, 10))
    out.push(`| ${r.name.replace(/\|/g, '/')} | ${r.p} | ${k(r.all)} | ${Math.round(r.leadShare * 100)}% | ${k(r.ctx)} | ${r.advCalls} | ${r.agents} | ${r.errs} |`)
  const bad = Object.entries(tools).filter(([, t]) => t.errors).sort((a, b) => b[1].errors - a[1].errors).slice(0, 10)
  if (bad.length) {
    out.push('', '## Tool errors', '', '| tool | calls | errors | rate |', '|---|---|---|---|')
    for (const [n, t] of bad) out.push(`| ${n} | ${t.calls} | ${t.errors} | ${Math.round(100 * t.errors / t.calls)}% |`)
  }
  out.push('', '## Flags', '', ...(flags.length ? flags.map(f => `- ${f}`) : ['- none']))
  console.log(out.join('\n'))
}

module.exports = { scan, log, report, LOG }
if (require.main === module) {
  const [cmd, a, b] = process.argv.slice(2)
  if (cmd === 'log' && a) log(a, b || 'manual')
  else if (cmd === 'report') report(Number(a) || 7)
  else console.log('usage: node usage.js log <session.jsonl> [trigger] | report [days]')
}

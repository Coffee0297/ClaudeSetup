// graph-hint: tells Claude (and subagents) to use a graphify graph wherever one exists.
// One script for: UserPromptSubmit, PreToolUse (Grep|Glob|Read), PostToolUse (Skill), SubagentStart.
// Never blocks anything: it only adds context, and any error exits quietly.
const fs = require('fs')
const os = require('os')
const path = require('path')

const QUERY = 'run /graphify query "<question>" --budget 1500 FIRST for how/where/why/what-depends questions, and use Grep/Read only to confirm the lines it points to'
const ROUTING = 'If you do not already know the file or the answer, use Explore (Haiku) subagents before your own Grep/Read; edit files you already know directly. PowerShell commands go to the PowerShell tool.'

function graphRoot(start) {
  if (!start) return ''
  let dir = path.resolve(start)
  try { if (fs.existsSync(dir) && !fs.statSync(dir).isDirectory()) dir = path.dirname(dir) } catch { dir = path.dirname(dir) }
  for (let i = 0; i < 12; i++) {
    const out = path.join(dir, 'graphify-out')
    if (fs.existsSync(path.join(out, 'GRAPH_REPORT.md')) || fs.existsSync(path.join(out, 'graph.json'))) return dir
    const up = path.dirname(dir)
    if (up === dir) break
    dir = up
  }
  return ''
}

// once-per-session memory of repos already hinted before a search
function seenFile(sessionId) {
  return path.join(os.tmpdir(), `claude-graph-hint-${String(sessionId || 'nosession').replace(/[^\w-]/g, '_')}.json`)
}
function firstTime(sessionId, root) {
  const f = seenFile(sessionId)
  let seen = []
  try { seen = JSON.parse(fs.readFileSync(f, 'utf8')) } catch {}
  const key = root.toLowerCase()
  if (seen.includes(key)) return false
  try { fs.writeFileSync(f, JSON.stringify([...seen, key])) } catch {}
  return true
}

// Context size from the end of the session transcript: the last main-thread
// assistant message's input tokens (uncached + cache read + cache write).
const CTX_LIMIT = 150000
function ctxTokens(transcript) {
  try {
    const fd = fs.openSync(transcript, 'r')
    const size = fs.fstatSync(fd).size
    const len = Math.min(size, 1024 * 1024)
    const buf = Buffer.alloc(len)
    fs.readSync(fd, buf, 0, len, size - len)
    fs.closeSync(fd)
    const lines = buf.toString('utf8').split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i]
      if (!l.includes('"usage"') || !l.includes('"assistant"')) continue
      try {
        const d = JSON.parse(l)
        if (d.isSidechain) continue
        const u = d.message && d.message.usage
        if (u) return (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)
      } catch {}
    }
  } catch {}
  return 0
}
function advisorWarning(ev) {
  const t = ctxTokens(ev.transcript_path || '')
  if (t < CTX_LIMIT) return ''
  return `Context is ~${Math.round(t / 1000)}k tokens. Do NOT consult the advisor now: it rereads the whole conversation uncached. If you need it, first update "## Current state" in CLAUDE.local.md (including the exact question for the advisor), then stop and ask me to run /clear and say continue.`
}

function emit(event, text) {
  if (!text) process.exit(0)
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } }))
  process.exit(0)
}

let raw = ''
process.stdin.on('data', d => (raw += d))
process.stdin.on('end', () => {
  let ev = {}
  try { ev = JSON.parse(raw) } catch { process.exit(0) }
  const event = ev.hook_event_name || ''
  const cwd = ev.cwd || process.cwd()
  const input = ev.tool_input || {}
  try {
    if (event === 'UserPromptSubmit') {
      const root = graphRoot(cwd)
      const warn = advisorWarning(ev)
      return emit(event, (warn ? warn + ' ' : '') + 'Routing: ' + (root ? `This repo has a graphify graph (${path.join(root, 'graphify-out')}): ${QUERY}. ` : '') + ROUTING)
    }
    if (event === 'SubagentStart') {
      const root = graphRoot(cwd)
      return emit(event, root ? `A graphify graph exists for this repo (${path.join(root, 'graphify-out')}): ${QUERY}.` : '')
    }
    if (event === 'PreToolUse') {
      const warn = advisorWarning(ev)
      if (warn && firstTime(ev.session_id, '__advisor_ctx__')) return emit(event, warn)
    }
    if (event === 'PreToolUse' && /^(Grep|Glob|Read)$/.test(ev.tool_name || '')) {
      const target = input.file_path || input.path || cwd
      const root = graphRoot(path.isAbsolute(target) ? target : path.join(cwd, target))
      if (root && firstTime(ev.session_id, root)) {
        return emit(event, `Note: ${root} has a graphify graph (graphify-out/). Before more searching there, ${QUERY}.`)
      }
      process.exit(0)
    }
    if (event === 'PostToolUse' && ev.tool_name === 'Skill' && /graphify/i.test(String(input.skill || input.command || ''))) {
      const root = graphRoot(cwd)
      return emit(event, root
        ? `The graphify graph is ready at ${path.join(root, 'graphify-out')}. From now on in this session: ${QUERY}. After structural changes run /graphify . --update.`
        : '')
    }
  } catch {}
  process.exit(0)
})

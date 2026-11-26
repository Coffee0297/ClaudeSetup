// Logs this session's token use per model to ~/.claude/usage-log.jsonl (via the repo's usage.js) on /handoff
// (typed or run as the handoff skill) and at session end (/clear, exit). Prints nothing, never blocks.
const fs = require('fs')
const os = require('os')
const path = require('path')
let raw = ''
process.stdin.on('data', d => { raw += d })
process.stdin.on('end', () => {
  try {
    const h = JSON.parse(raw)
    const ev = h.hook_event_name
    const trigger =
      ev === 'SessionEnd' ? `end:${h.reason || '?'}`
      : ev === 'UserPromptSubmit' && /^\s*\/handoff\b/.test(h.prompt || '') ? 'handoff'
      : ev === 'PostToolUse' && h.tool_name === 'Skill' && /(^|:)handoff$/.test((h.tool_input || {}).skill || '') ? 'handoff'
      : null
    if (!trigger || !h.transcript_path) return
    const cfg = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
    const repo = JSON.parse(fs.readFileSync(path.join(cfg, 'settings.json'), 'utf8')).extraKnownMarketplaces['claude-setup'].source.path
    require(path.join(repo, 'usage.js')).log(h.transcript_path, trigger)
  } catch {}
})

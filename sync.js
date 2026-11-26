#!/usr/bin/env node
// Keeps the Claude config in step with this repo. Re-runs install.js only when something changed:
//   - user/ or install.js differ from what was last installed (hash stored by install.js), or
//   - the cached copy of tlm-core differs from plugins/tlm-core (Claude Code copies it into its plugin cache).
// Runs from cc / cco (install.ps1) and from the tlm-core SessionStart hook, so Desktop sessions sync too.
// Changes load in the NEXT session (this one already read CLAUDE.md, agents and hooks).
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { spawn, spawnSync } = require('child_process')

const REPO = __dirname
const CFG = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
const MANIFEST = path.join(CFG, '.claude-setup-manifest.json')

function files(dir, rel = '') {
  const out = []
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue
    const r = path.join(rel, e.name)
    if (e.isDirectory()) out.push(...files(dir, r)); else out.push(r)
  }
  return out.sort()
}
// hash of the repo's files under `dir`, read from `base` (so a cache copy can be hashed with the repo's file list)
function hashTree(dir, base = dir) {
  const h = crypto.createHash('sha1')
  for (const r of files(dir)) {
    h.update(r)
    try { h.update(fs.readFileSync(path.join(base, r))) } catch { h.update('\0missing') }
  }
  return h.digest('hex')
}
const sha = f => crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex')
const configHash = () => hashTree(path.join(REPO, 'user')) + sha(path.join(REPO, 'install.js'))

// tlm-core is copied into ~/.claude/plugins/cache/...; `plugin update` skips same-version edits, so compare content.
// (agent-board is read in place from the repo folder, so it never goes stale.)
function pluginStale(p) {
  let dir
  try { dir = JSON.parse(fs.readFileSync(path.join(CFG, 'plugins', 'installed_plugins.json'), 'utf8')).plugins[`${p}@claude-setup`][0].installPath } catch { return true }
  const repoDir = path.join(REPO, 'plugins', p)
  if (path.resolve(dir) === path.resolve(repoDir)) return false
  return hashTree(repoDir) !== hashTree(repoDir, dir)
}

// background: true (SessionStart hook) starts install.js detached, so a plugin reinstall never delays session start
function run({ background = false } = {}) {
  let st
  try { st = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) } catch {}
  // no manifest yet (installed before sync.js existed): an install without defaultMode was a --no-bypass install
  let noBypass = st ? st.noBypass : true
  if (!st) try { noBypass = !JSON.parse(fs.readFileSync(path.join(CFG, 'settings.json'), 'utf8')).permissions.defaultMode } catch {}
  const config = !st || st.config !== configHash()
  const plugin = pluginStale('tlm-core')
  if (!config && !plugin) return
  const args = [path.join(REPO, 'install.js'), ...(plugin ? [] : ['--no-plugins']), ...(noBypass ? ['--no-bypass'] : [])]
  const what = [config && 'config', plugin && 'tlm-core plugin'].filter(Boolean).join(' + ')
  if (background) {
    spawn(process.execPath, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref()
    return console.log(`claude-setup: syncing ${what} from ${REPO} in the background; it loads in the next session.`)
  }
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 180000 })
  if (r.status === 0) console.log(`claude-setup: synced ${what} from ${REPO}; start a new session to load it.`)
  else console.log(`claude-setup: sync of ${what} FAILED (exit ${r.status}):\n${`${r.stdout || ''}${r.stderr || ''}`.trim().split('\n').slice(-6).join('\n')}`)
}

module.exports = { run, configHash, pluginStale, MANIFEST }
if (require.main === module) run()

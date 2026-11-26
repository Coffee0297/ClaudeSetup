#!/usr/bin/env node
// claude-setup installer: copies agents/commands, merges settings, manages the
// global CLAUDE.md section and installs the plugins. Safe to re-run.
//   node install.js [--dry-run] [--no-plugins] [--no-bypass] [--marketplace <path-or-owner/repo>]
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const argv = process.argv.slice(2)
const flag = n => argv.includes(n)
const opt = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined }
const DRY = flag('--dry-run')
const NO_PLUGINS = flag('--no-plugins')
const NO_BYPASS = flag('--no-bypass')
const REPO = __dirname
const SRC = path.join(REPO, 'user')
const CFG = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
const MARKET = opt('--marketplace') || REPO
const BEGIN = '<!-- BEGIN claude-setup (managed: edit the repo, not here) -->'
const END = '<!-- END claude-setup -->'
let errors = 0

const log = m => console.log((DRY ? '[dry-run] ' : '') + m)
const read = f => { try { return fs.readFileSync(f, 'utf8') } catch { return undefined } }
function write(f, text) {
  log(`write ${f}`)
  if (DRY) return
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, text, 'utf8')
}
function backupOnce(f) {
  const b = f + '.bak-setup'
  if (fs.existsSync(f) && !fs.existsSync(b)) { log(`backup ${b}`); if (!DRY) fs.copyFileSync(f, b) }
}

// ---- 1. global CLAUDE.md section ----------------------------------------------------
function installClaudeMd() {
  const f = path.join(CFG, 'CLAUDE.md')
  const managed = `${BEGIN}\n${read(path.join(SRC, 'CLAUDE.md')).replace(/\r\n/g, '\n').trim()}\n${END}\n`
  let cur = (read(f) || '').replace(/\r\n/g, '\n')
  let next
  const a = cur.indexOf(BEGIN), b = cur.indexOf(END)
  if (a >= 0 && b > a) next = cur.slice(0, a) + managed + cur.slice(b + END.length).replace(/^\n/, '')
  else if (cur.trimStart().startsWith('# Global instructions')) next = managed // the earlier generated file: replace it (backed up)
  else next = (cur.trim() ? cur.replace(/\s*$/, '\n\n') : '') + managed
  if (next === cur) return log('CLAUDE.md up to date')
  backupOnce(f)
  write(f, next)
}

// ---- 2. agents + commands ----------------------------------------------------------------
function copyDir(sub) {
  const from = path.join(SRC, sub), to = path.join(CFG, sub)
  for (const name of fs.readdirSync(from)) {
    const src = read(path.join(from, name)), dst = path.join(to, name)
    if (read(dst) === src) continue
    write(dst, src)
  }
}

// ---- 3. settings.json merge ----------------------------------------------------------------
const isObj = x => x && typeof x === 'object' && !Array.isArray(x)
function merge(cur, add) {
  for (const [k, v] of Object.entries(add)) {
    if (isObj(v) && isObj(cur[k])) merge(cur[k], v)
    else if (Array.isArray(v) && Array.isArray(cur[k])) cur[k] = [...new Set([...cur[k], ...v])]
    else cur[k] = v
  }
  return cur
}
function installSettings() {
  const f = path.join(CFG, 'settings.json')
  const raw = read(f)
  let cur = {}
  if (raw) { try { cur = JSON.parse(raw) } catch (e) { console.error(`ERROR: ${f} is not valid JSON, left untouched (${e.message})`); errors++; return } }
  const before = JSON.stringify(cur)
  const add = JSON.parse(read(path.join(SRC, 'settings.json')))
  if (NO_BYPASS && add.permissions) delete add.permissions.defaultMode
  merge(cur, add)
  // The guard/graph-hint hooks now come from the tlm-core plugin: drop the old user-level entries.
  if (isObj(cur.hooks)) {
    for (const ev of Object.keys(cur.hooks)) {
      if (!Array.isArray(cur.hooks[ev])) continue
      cur.hooks[ev] = cur.hooks[ev].filter(e => !/[\\/]\.claude[\\/]hooks[\\/](guard|graph-hint|reminder)\.js/.test(JSON.stringify(e)))
      if (cur.hooks[ev].length === 0) delete cur.hooks[ev]
    }
    if (Object.keys(cur.hooks).length === 0) delete cur.hooks
  }
  if (cur.permissions && Array.isArray(cur.permissions.deny)) cur.permissions.deny = cur.permissions.deny.filter(r => r !== 'mcp__tia-portal*__SetSafetyPassword')
  delete cur.mcpServers // Claude Code does not read MCP servers from settings.json
  if (JSON.stringify(cur) === before) return log('settings.json up to date')
  backupOnce(f)
  write(f, JSON.stringify(cur, null, 2) + '\n')
  const cc = path.join(CFG, 'cc-settings.json')
  if (read(cc) !== read(path.join(SRC, 'cc-settings.json'))) write(cc, read(path.join(SRC, 'cc-settings.json')))
}

// ---- 4. plugins ----------------------------------------------------------------------------
function claude(args, quiet) {
  const win = process.platform === 'win32'
  const q = a => (win && /[\s&()]/.test(a) ? `"${a}"` : a)
  log(`run claude ${args.join(' ')}`)
  if (DRY) return { status: 0, out: '' }
  const r = spawnSync('claude', win ? args.map(q) : args, { shell: win, encoding: 'utf8' })
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim()
  if (!quiet && out) console.log('  ' + out.split('\n').slice(-2).join('\n  '))
  return { status: r.status, out }
}
function installPlugins() {
  if (NO_PLUGINS) return log('plugins skipped (--no-plugins)')
  const v = DRY ? { status: 0 } : spawnSync('claude', ['--version'], { shell: process.platform === 'win32', encoding: 'utf8' })
  if (v.status !== 0) { console.error('ERROR: the claude CLI was not found on PATH; install Claude Code, then re-run.'); errors++; return }
  // migrate from the old local mods marketplace
  claude(['plugin', 'uninstall', 'agent-board@tlm-mods'], true)
  claude(['plugin', 'marketplace', 'remove', 'tlm-mods'], true)
  const added = claude(['plugin', 'marketplace', 'add', MARKET])
  if (added.status !== 0 && /already/i.test(added.out)) claude(['plugin', 'marketplace', 'update', 'claude-setup'])
  for (const p of ['tlm-core', 'agent-board']) {
    const r = claude(['plugin', 'install', `${p}@claude-setup`, '--scope', 'user'])
    if (r.status !== 0) {
      const u = claude(['plugin', 'update', `${p}@claude-setup`])
      if (u.status !== 0) { console.error(`ERROR: could not install or update ${p}`); errors++ }
    }
  }
}

console.log(`claude-setup -> ${CFG}${DRY ? '  (dry run: nothing is written)' : ''}`)
installClaudeMd()
copyDir('agents')
copyDir('commands')
installSettings()
installPlugins()
console.log(errors ? `\nFinished with ${errors} error(s).` : '\nDone. Start a NEW Claude Code session (and restart the desktop app) to load it.')
process.exit(errors ? 1 : 0)

// SessionStart: run the claude-setup repo's sync.js, so every session (Desktop app too, not only cc/cco)
// installs repo changes. This file runs from the plugin cache, so the repo is found via the marketplace entry.
const fs = require('fs')
const os = require('os')
const path = require('path')
const cfg = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
let repo
try { repo = JSON.parse(fs.readFileSync(path.join(cfg, 'settings.json'), 'utf8')).extraKnownMarketplaces['claude-setup'].source.path } catch {}
try {
  if (repo && fs.existsSync(path.join(repo, 'sync.js'))) require(path.join(repo, 'sync.js')).run({ background: true })
} catch (e) { console.log(`claude-setup: sync hook failed: ${e.message}`) }

# claude-setup

My Claude Code setup, installable on any machine: agents, rules, guard hooks, routing hints and the Agent Board side pane.

## What's inside

| Part | Where it ends up | What it does |
|---|---|---|
| `plugins/tlm-core` (plugin) | loaded from this repo | **Guard hook:** blocks flashing (esptool, idf.py flash, espefuse burn, dfu-util, STM32 programmer, BootCommander, HTTP flash endpoints), `gh pr create` / `gh release create`, dangerous `InvokeOpennessApi` calls (download, IP, passwords, protection, safety, online, runtime), PowerShell run through Bash, and builds/tests in the main session (they go to a `builder` subagent). **Routing hints:** graph-first wherever `graphify-out/` exists, Explore-first, and a "don't call the advisor, hand off and /clear first" warning once context passes 150k tokens. |
| `plugins/agent-board` (plugin) | loaded from this repo | Side pane: lead/advisor, plan limits (5h, week, Fable week, with ETA), agent flow, dispatch blocks, DONE list, spend rate, cost share, log. `/board` reopens it. |
| `user/CLAUDE.md` | `~/.claude/CLAUDE.md`, between `BEGIN/END claude-setup` markers | Global rules: delegation, reviews, auto-handoff, advisor context rule, graphify, hardware, TIA, Windows shell. Your own text outside the markers is kept. |
| `user/agents/*.md` | `~/.claude/agents/` | Explore (Haiku), builder (Sonnet), reviewer (Opus), tia-operator (Sonnet). |
| `user/commands/handoff.md` | `~/.claude/commands/` | `/handoff` |
| `user/settings.json` | merged into `~/.claude/settings.json` | Opus + medium effort + Fable advisor, bypass mode, 37 TIA deny rules + force-push, claude.ai connectors off in Claude Code, no Claude commit trailers, 90-day history, subagent defaults. Merged: your other settings stay. |
| `user/cc-settings.json` | `~/.claude/cc-settings.json` | Opus advisor for the `cc` shortcut. |
| `install.ps1` | PowerShell profiles | `cc` (Sonnet) and `cco` (Opus) shortcuts. |

## Requirements

- Claude Code 2.1.287 or later (`claude --version`, `claude update`)
- Node.js (hooks run on it)
- Optional: the Ponytail plugin (the reviewer uses its review checklist when present), graphify skill

## Install

Clone the repo somewhere permanent (the plugins load from this folder, so `git pull` updates them):

**Windows**
```powershell
git clone https://github.com/Coffee0297/ClaudeSetup.git "$HOME\claude-setup"
powershell -ExecutionPolicy Bypass -File "$HOME\claude-setup\install.ps1"
```

**macOS / Linux / cloud sessions**
```bash
git clone https://github.com/Coffee0297/ClaudeSetup.git ~/claude-setup && ~/claude-setup/install.sh
```

Then start a new Claude Code session (restart the desktop app).

Options: `-DryRun` / `--dry-run` shows what would change, `-NoPlugins` / `--no-plugins` skips the plugins, `-NoBypass` / `--no-bypass` keeps permission prompts on.

Backups are made once, as `settings.json.bak-setup` and `CLAUDE.md.bak-setup`.

## Update

```bash
git -C ~/claude-setup pull
```
Plugin changes apply at the next session start. If `user/` files changed (rules, agents, settings), re-run the installer.

## Cloud sessions (claude.ai/code)

Add to the cloud environment's setup script:
```bash
git clone https://github.com/Coffee0297/ClaudeSetup.git ~/claude-setup && ~/claude-setup/install.sh --no-bypass
```
A private repo needs to be added to the environment so the clone works.

## Per-machine notes

- TIA deny rules and TIA rules only matter where TIA Portal is installed; they are harmless elsewhere.
- Bypass mode runs commands without asking. The guard hook and deny rules still apply. Use `--no-bypass` on machines where you want prompts.
- Turn the build blocker off for one PowerShell window: `$env:CLAUDE_LEAD_BUILDS = '1'; cco`

## Uninstall

```bash
claude plugin uninstall tlm-core@claude-setup
claude plugin uninstall agent-board@claude-setup
claude plugin marketplace remove claude-setup
```
Then restore `~/.claude/settings.json.bak-setup` and `CLAUDE.md.bak-setup`, or remove the `claude-setup` section from `CLAUDE.md`, and delete the four agent files and `commands/handoff.md`.

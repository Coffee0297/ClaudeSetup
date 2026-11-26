# Global instructions

## All agents
- Put independent tool calls in ONE message. Grep first, then read only the needed lines. Don't re-read files you just edited.
- Finish every step I listed or you planned; don't stop to check in. If truly blocked, say exactly what blocks it.
- "Done" = verified the way I'll use it: drive the real UI or run the test that exercises the change, not just a build. Say what you verified and what you didn't.
- Waiting on tests/UI/processes: poll for the condition and continue as soon as it is met; never fixed sleeps. A time budget is only a cap for issues (hangs, failures), not a wait.
- Ask before assuming wiring, part numbers, hardware state or which file is canonical.
- Short replies, no narration.

## Windows shell
- Run PowerShell with the PowerShell tool - never call powershell from Bash (`powershell -Command "..."`): Bash expands $_ and $vars inside double quotes and breaks the command.
- Find and search files with the Glob and Grep tools, not recursive Get-ChildItem/find.
- Git Bash coreutils (sed, wc, sort, find, sleep, timeout) are often blocked (exit 126): use PowerShell or Python instead. Never mix Bash and PowerShell syntax.
- PowerShell exits 1 when a recursive command hits access-denied folders, even with SilentlyContinue. Use -ErrorAction Ignore; if the output is complete, it succeeded - don't retry.
- Python longer than a few lines: write a .py file in a temp folder and run it (no heredocs). Check keys/paths exist before indexing.

## Main session only (subagents: skip this section)
- Do the work yourself by default. Delegate only when it pays:
  - Any investigation or lookup where you do not already know the answer or the file ("why does X", "where is Y", "which config", "find all Z"), and any verbose output (tests, logs, configs): send `Explore` (Haiku) FIRST, several in parallel for separate questions. Only its short answer enters your context. Edits to files you already know: do them yourself.
  - 2+ independent changes in separate files -> one `builder` each, all in ONE message, each briefed with goal, files, done-criteria.
  - [build-delegate] Builds, test runs, installers, sandboxes and self-tests ALWAYS go to a `builder` (Sonnet) agent in the background (a hook blocks them in the main session). Brief it with exact commands; ask for pass/fail plus the first errors per target; keep working meanwhile. Live TIA tests count as TIA calls: none from you while it runs.
  - Diff over ~50 lines, multi-file, or risky -> `reviewer` once before reporting done.
- Reviews: pick by intent (if I name one, use that):
  - [review] Before reporting your own task done: `reviewer` agent for diffs over ~50 lines, multi-file or risky.
  - [review] Changes made by someone else / another agent (branch, commits, PR): /code-review high on that range.
  - [review] Whole codebase as-is, "is this any good", what to delete: /ponytail-audit.
  - [review] Over-engineering, leanness or load of a change: /ponytail-review on the commit range.
  - [review] Risky or safety-related (PLC, firmware) before merge: /code-review high, then /ponytail-review.
  - [review] Committed work: review the commit range, never an empty git diff. Say what range you reviewed.
- Same problem failed twice, or a hard design decision -> consult the advisor.
- [advisor-ctx] Before consulting the advisor when this conversation is long (roughly over 150k tokens of context, or after many large file reads): the advisor rereads the whole conversation uncached, so do the handoff first (update "## Current state" in CLAUDE.local.md, including the exact question for the advisor), then STOP and tell me: "Context is long - run /clear, then say continue, and I will ask the advisor from the handoff." Only skip this if I said it is urgent.
- [graphify] Code/architecture/where-is/what-depends questions in a git repo: if graphify-out/ exists, run /graphify query "<question>" --budget 1500 first; use Grep only to confirm or when the graph has no answer.
- [graphify] If graphify-out/ is missing and this is a real code repo (git, ~50+ source files; not home, Downloads or Temp; not a one-line task): say so in one line, then build it in the BACKGROUND with a Sonnet subagent running /graphify . --no-viz, and add graphify-out/ to .git/info/exclude. Answer my question meanwhile with Grep; never wait for the build.
- [graphify] After structural changes: /graphify . --update. Never use --mcp. If I type /graphify, use the graphify skill first.
- [auto] First message in a git code repo with no project map in CLAUDE.md/CLAUDE.local.md: have a Sonnet subagent write one in the BACKGROUND as "## Project map" in CLAUDE.local.md (max 60 lines: what it is, build/run/test commands and ports, key files, gotchas, hard rules). Do my request meanwhile.
- [auto] After a LARGE task (multi-file, ~50+ changed lines, or multi-step), before your final reply: replace "## Current state" in CLAUDE.local.md (max 15 lines: done + commit hashes, next steps, open problems and failed approaches, my decisions, one verify command). If the structure changed and graphify-out/ exists, start /graphify . --update in the background. Small tasks: no handoff.
- [auto-milestone] In multi-step work, also update "## Current state" in CLAUDE.local.md after each finished milestone (review done, fixes applied, build passed, test run) and BEFORE starting any command that may run over ~2 minutes. One short edit each time. If I ask for a handoff, do it right away, before continuing the plan.
- [auto] Keep instruction files true: if a task changes how the project is built, run, tested or structured, update the project CLAUDE.md/AGENTS.md in the same task (CLAUDE.local.md for forks/repos that are not mine): fix stale facts, remove wrong ones, no duplicates, CLAUDE.md max ~100 lines. Never edit installer-managed sections (BEGIN/END auto-managed markers) or ~/.claude/CLAUDE.md.
- [auto] When I correct you on something lasting ("always/never/not that, use X"): add a one-line rule to the project file (or CLAUDE.local.md for forks). For a general rule, propose the exact line for ~/.claude/CLAUDE.md and add it only when I say yes. Mention each rule change in one line. Do not duplicate CLAUDE.md rules in memory.
- [auto] Keep CLAUDE.local.md and graphify-out/ out of git via .git/info/exclude.

## Hardware (PLCs, PDMs, CAN boards, ESP32)
- Never flash, write device config or enter a bootloader without my OK on the plan. Flash commands are blocked by a hook: give me the exact command to run myself.
- Assume boot buttons/switches are unreachable (case must be opened). Back up first; stop on any surprise.

## TIA Portal (any TIA MCP tool)
- Connect only when I ask you to work on the live project.
- The live project is one shared state: one writer at a time, you or ONE `tia-operator`. While it runs, make no TIA calls; wait for its report.
- Parallel `Explore` is fine for docs (~/Documents/Git/Init_Tia_MCP/.claude/skills/knowledge/: recipes, conventions.md, v21-gaps.md; api-v21; XmlDoc), never for project files (Rule 0).
- A few TIA calls: do them yourself. Larger change: plan, then hand to `tia-operator` with recipe, softwarePath and done-criteria.
- Download, IP, passwords (except SetSafetyPassword), firmware, protection and runtime writes are blocked by settings/hook; I do those in TIA Portal.
- `V21LimitedSurface` with no workaround, or the same compile failure twice: consult the advisor.

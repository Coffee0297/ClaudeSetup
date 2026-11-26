Run in a session opened on C:\Users\tlm\Documents\Git\Init_Tia_MCP. Recommended: `cco` (Opus lead), since this is safety-relevant server code. Run it after prompt 1, so that `guard.js` already covers `RunPlan`.

---

Implement the server changes and the agent skills from `docs/tia-agent-pipeline.md` in this repo. Read section 4 (S1-S6), Q3 and Q6 (safety), and section 5 (test protocol). Do not reread the whole doc into context.

**Roles:** you plan, brief, commit and review. Builders write every phase. Before any code, send all the builder briefs in ONE message:
- Builder A: phases 0→1→2→3→4→5 in order, since they share `Program.cs`, `ToolDispatch` and the tests.
- Builder B: phase 6 (installer and payload script).
- Builder C: phase 7 (skills).

You write code only for review fixes under ~30 lines.

Work on a new branch `feat/agent-pipeline`. Make one commit per phase. Builds and tests go to `builder` agents in the background. Use Explore or `/graphify query` for code questions. Make no live TIA calls and no Connect. Live tests (T-protocol) only after I say yes.

Phases, in this order:

0. **Safety fix first: the `DeviceWriteGuard` gap.** Any `Get*` method currently passes the guard. Allow-list only the read methods that are actually read-only, or block `Get*` calls that return writable or online objects. Choose the smaller fix that closes the gap and explain it. Add a unit test that covers the bypass.

1. **S5: call stats.**
   - Write one JSONL line per tool call from the shared handler: `{ts, tool, ok, errorCode, ms, inChars, outChars}`. Reuse the `MetaTool.cs` writer and its redaction.
   - Add `scripts/call-stats.ps1` to summarize the wrong-call rate per tool and per errorCode.

2. **S1: compact `TiaFindTools` plus a new `DescribeTool(name)`.**
   - By default, return only name, one-line description and score. Include the full schema only for the top 3 hits or when `withSchema=true`.
   - `DescribeTool(name)` returns the exact `inputSchema` of one tool.

3. **S3: connection preflight.**
   - Return `errorCode=NotConnected` with one fix line.
   - Return a separate code for the Openness "Security error".

4. **S2: `RunPlan` plus `ValidatePlan`.** Follow the design in section 4 S2 exactly:
   - extracted `ToolDispatch.Invoke`
   - `ExclusiveAccess` and `Transaction`
   - stop at the first error or mismatch, with rollback
   - per-step results of at most 300 chars
   - compile only after commit
   - a `SemaphoreSlim` so only one plan runs at a time
   - a `transaction:false` fallback

   Safety, from Q6 (these are hard requirements):
   - Every step runs through the same server guards as a direct call, including `DeviceWriteGuard` and the InvokeOpennessApi keyword checks.
   - `Connect` and every tool on the client ask/deny lists are refused as plan steps.
   - The delete `confirm` gate stays per step.
   - `ValidatePlan` never changes the project.

   Add unit tests for:
   - schema validation
   - a refused step
   - stop-on-error
   - a destructive step hidden inside InvokeOpennessApi

5. **S4: compact mode.**
   - Trigger: `TIA_MCP_COMPACT=1`, or a `compact` argument.
   - Targets: `CompileSoftware`, `GetProjectTree`, `GetDevices`, `SearchHardwareCatalog`.

6. **S6: `--dump-tools` per version.**
   - Write `<installdir>\V<ver>\tools.json` at install, through TiaMcpSetup and `scripts/build-setup-payload.ps1`.
   - Regenerate `scripts/tools.json` and `docs/tools-reference.md`.

7. **Skills.** Under `.claude/skills/`, keeping each SKILL.md short (under ~80 lines) and with a description written so it triggers:
   - `tia-pipeline`: when and how to run the pipeline:
     1. Lead plans.
     2. Builder writes the files and checks them offline.
     3. `tia-scout` writes the plan.
     4. `tia-executor` runs `ValidatePlan`, then `RunPlan`, then compile.
     5. Lead checks the step results.

     Also cover the plan JSON format with one complete example, how to brief each agent (goal, softwarePath, files, done-criteria), when plain `tia-operator` is fine (1-3 calls, ad hoc), and what to do on a stop (report, no retry loops).
   - `tia-subagents`: how to use subagents in this repo: Explore or graphify for code, `builder` for builds/tests/installer, `reviewer` before done, at most one TIA writer, background vs foreground, keeping briefs and outputs short, and when to hand off and `/clear` before the advisor.
   - `tia-cookbook`: the per-project call cookbook (Q5): where it lives, its format (verified tool + args + softwarePath + device names + date + TIA version), how the scout reads it first, and how to mark entries stale. Create the empty template only.

   Link the skills from the repo `CLAUDE.md` in one line each. Keep `CLAUDE.md` within its size limit.

Done when:
- `builder` reports that the solution builds and all unit tests pass (pass/fail per project, first errors).
- `ValidatePlan` on a sample offline plan returns per-step validation through a stdio smoke test that makes no TIA connection.
- `/code-review high` has run on the branch's commit range, then `/ponytail-review`. Fix the real findings.
- `CLAUDE.md` and `docs/tools-reference.md` are updated, and CLAUDE.local.md "## Current state" is updated.

Do not push. Reply with what changed per phase, the test results, and what still needs a live MCPVAL_ test (section 5, T0-T5). Then ask me before any Connect.

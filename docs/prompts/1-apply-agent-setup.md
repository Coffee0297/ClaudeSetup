Run in a session opened on C:\Users\tlm\claude-setup. Recommended: `cc` (Sonnet lead).

---

Apply the agent setup from my two research docs to this repo (claude-setup). Work on the branch `docs/agent-setup-research` (it already holds `docs/agent-setup-research.md`, uncommitted; commit that first as its own commit).

Sources (read only the sections named):
- `docs/agent-setup-research.md` section 4 "Concrete changes", items 1-8 and 12.
- `C:\Users\tlm\Documents\Git\Init_Tia_MCP\docs\tia-agent-pipeline.md` section 3 "Agent definitions" and the Q6 "Safety" part about `guard.js`.

Do:
1. Per-agent effort in `user/agents/*.md` frontmatter:
   - `Explore`: low
   - `researcher`: low
   - `builder`: medium
   - `reviewer`: high
   - `tia-operator`: medium
2. `builder.md` body: for every build or test, quote the exact command, its exit code and the last 20 output lines on FAIL. "No tests collected" counts as FAIL.
3. `user/settings.json`: add `"autoCompactWindow": 400000`. Change nothing else there.
4. Add `user/agents/tia-scout.md` from section 3 of the pipeline doc: Sonnet, low or medium effort as the doc says, offline only. It must have no live TIA tools, `Connect` especially. It outputs a JSON call plan.
5. Add `user/agents/tia-executor.md` from the same section, but use **Sonnet, effort low** until the server has `RunPlan` and tests T2/T4 pass. Then switch it to Haiku. Put that condition in a comment in the file.
   - It runs the plan as given.
   - It stops at the first unexpected result and reports the step id, the error and the args.
   - It never improvises.
   - Only one executor or tia-operator runs at a time.
6. Update `tia-operator.md` and `builder.md` as section 3 says. Keep `tia-operator` for ad-hoc and small live changes.
7. `user/CLAUDE.md`:
   - Add the rule lines from pipeline doc section 3.
   - Add these two lines from agent-setup-research item 7: parallel limit of 4 writers / 6 read-only, and never use `/fast`.
   - Apply item 8: the advisor is on-demand only.
   - Edit the "TIA Portal" section so the flow is lead plans → builder files → tia-scout plan → tia-executor runs → lead checks results.
   - Keep the file under ~70 lines. Merge lines rather than adding duplicates.
8. `plugins/tlm-core/hooks/guard.js` and `hooks.json`:
   - Make the TIA matcher also cover `RunPlan` and `ValidatePlan`.
   - Make the same destructive-keyword block apply to every step inside a `RunPlan` plan argument, not only to the top-level args.
   - Block `Connect` and any live TIA tool when the calling agent is `tia-scout`, if the hook input exposes the agent name. If it does not, say so and rely on the agent's `tools`/`disallowedTools` list.
   - Update `PONYTAIL_SUBAGENT_MATCHER` in `user/settings.json` if the new agents should be matched.
9. Item 12: check that `install.ps1` / `Sync-ClaudeSetup` copies every file in `user/agents/`, including `researcher` and the new ones. Fix it if it doesn't.

Rules:
- Smallest diff. Don't touch `install.ps1` beyond item 9.
- Don't apply the "optional" items 10-11.
- No live TIA calls, no Connect.

Done when:
- A `builder` agent runs the repo's hook tests, or, if none exist, feeds `guard.js` sample JSON on stdin and shows the exit codes for these cases:
  - a `RunPlan` with a download step → blocked
  - a `RunPlan` with only safe steps → allowed
  - plain `Connect` from the lead → existing behaviour unchanged
- Running `Sync-ClaudeSetup` (via builder) copies the new agents to `~/.claude/agents/`.
- `reviewer` has reviewed the commit range.
- Update CLAUDE.local.md "## Current state".
- Commit on the branch (do not push).
- Reply with what changed per file and what you did not verify.

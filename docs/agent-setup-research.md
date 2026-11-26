# Agent setup research: best results and speed within Max ($200) limits

Date: 2026-11-26. Models: Fable 5.2, Opus 5.5, Sonnet 5.5, Haiku 5.5.
Evidence labels: **DOC** = Anthropic primary source (fetched or quoted by the research agent); **DOC-snippet** = Anthropic source seen only as a search snippet; **COMM** = community; **UNKNOWN** = no source found.
Method note: the `researcher` agent type was not loaded in this session, so web research ran on `general-purpose` agents pinned to Haiku plus one `claude-code-guide` agent. Two early agent results with unverified benchmark numbers were discarded; only re-delivered, cross-checked results are used.

## 1. Executive summary

1. **No published ratios exist** for how Opus, Sonnet, Haiku or Fable consume the weekly limit. Anthropic says only that bigger models use limits faster. Every figure below that isn't marked DOC is something to measure (section 5).
2. **Your biggest lever is context re-reading, not model choice.** Every lead turn re-reads the whole history at the cached rate (DOC). The advisor re-reads it **uncached** on every call (DOC). A 700k session therefore makes each turn and each advisor call expensive.
3. **Default lead: Sonnet 5.5 (`cc`).** On Anthropic's own tables it is within about 2-4 points of Opus 5.5 on coding benchmarks, and ahead on Terminal-Bench 4.0. Keep `cco` (Opus lead) for design-heavy or root-cause sessions. Avoid `opusplan` in long sessions: each plan-mode toggle invalidates the cache (DOC).
4. **Advisor: on demand only, at small context.** Run it after a handoff and `/clear`, as your rule [advisor-ctx] already says. A Fable advisor may bill to **usage credits** (DOC), so check that before keeping `fable` as the `cco` advisor.
5. **Implementers:** Sonnet by default. Use Opus only after a Sonnet attempt fails, or for tightly coupled cross-module root-cause work. Evidence for "Opus is right first time more often" is thin (COMM).
6. **Verification:** a deterministic script decides PASS/FAIL. A cheap runner (Sonnet `builder` today, or a Haiku `tester` once measured) quotes command, exit code and output tail. Opus `reviewer` judges the diff. No evidence supports Haiku as the sole judge.
7. **Effort per role:** Explore and researcher `low`, builder and tia-operator `medium`, reviewer `high`, lead `medium`. Never `max` on Sonnet: Anthropic reports out-of-scope edits and timeouts at max (DOC).
8. **Context:** set `autoCompactWindow` as a safety net. The real control is handoff plus `/clear` at milestones (`/clear` is free; `/compact` is itself a large request, DOC).
9. **Parallelism:** 3-5 agents is Anthropic's own pattern. The default cap is 20 per session. Each agent costs its own context, so cap at about 4 for writers.
10. **Expected effect:** qualitative only, no ratio is published. Fewer long-context lead turns and uncached advisor reads should cut the weekly burn that currently runs out about 4 days early. Measure it with the plan in section 5 before believing it.

## 2. Findings per question

### Q1. How limits are counted on Max
| Claim | Evidence |
|---|---|
| Max has a rolling 5-hour window plus weekly limits, shared across chat and Claude Code. | DOC: https://code.claude.com/docs/en/costs ; base Max figures UNKNOWN (support article 11014257 returned 404) |
| Weekly limits are 25% above pre-promotion levels from 2026-09-14; 5-hour limits are unchanged. | DOC: https://support.claude.com/en/articles/15910845 |
| Per-model ratios (Opus vs Sonnet vs Haiku vs Fable) against the all-models limit | **UNKNOWN.** Anthropic says only "larger models use limits faster". COMM (morphllm.com/claude-code-usage-limits) says Fable has its own weekly row and burns faster. |
| Per-model weekly bars (e.g. "Current week (Fable)") | Shown in your own `/usage`. The docs don't describe per-model bars (claude-code-guide, DOC silence); COMM: claudeissues.com/issue/85964 |
| Cache reads vs uncached input | Docs say history is re-read "at the cached token rate" (DOC: costs page), but **the weight of a cache read against Max limits is UNKNOWN**. COMM reports conflict: issue #87646 attributes 91% of a Max user's spend to re-reading about 1M cached tokens; others assume 0.1× or full weight (claudeissues.com 59872, 75290, 92201). |
| Advisor usage | Counts toward plan usage. Each call uses "the advisor model's rates", and a Fable advisor can bill to usage credits (DOC: https://code.claude.com/docs/en/advisor). Whether it lands on the advisor model's per-model bar: UNKNOWN in docs. |
| Subagents | Count toward the same limits, each on its own model (DOC: https://code.claude.com/docs/en/sub-agents , best-practices "Know what subagents cost"). |
| Effort | Higher effort means more thinking/output tokens, billed as output, so more usage. No multiplier is published (DOC: https://code.claude.com/docs/en/model-config). |
| Fast mode | "Available via usage credits only and not included in the subscription rate limits" (DOC: https://code.claude.com/docs/en/fast-mode). It spends money, not limits, so keep it off. |
| Fallback | `fallbackModel` fires on overload or server errors only; "rate-limit errors never trigger a switch" (DOC: model-config). On a limit, Claude Code offers to switch or use extra usage (COMM issues; `/rate-limit-options` DOC). |
| `/usage` | Plan bars plus attribution to skills, subagents, plugins and MCP. Per-model token counts are shown at list price. Recommendations can be applied with `f` (v2.1.305+) (DOC: costs). |

### Q2. Best lead model
- Anthropic's numbers: Sonnet 5.5 scores 70.6% on Terminal-Bench 4.0 against Opus 5.5 at 66.4% (xhigh). Opus leads FrontierCode by 54.4% to 52.1%, CursorBench by 57.8% to 55.5%, and OSWorld by 81.8% to 80.1% (DOC: https://www.anthropic.com/claude-sonnet-5-5 , https://www.anthropic.com/research/claude-opus-5-5). Independent re-runs put the two within error margins (COMM: morphllm.com/claude-benchmarks).
- Opus 5.5 at medium effort matches or beats Opus 5 at high, and uses fewer tokens per task (DOC, vendor eval).
- `opusplan` runs Opus in plan mode and Sonnet in execution (DOC). Each plan-mode toggle invalidates the prompt cache (DOC: https://code.claude.com/docs/en/prompt-caching), so a long session with several toggles pays for re-caching each time.
- The lead is the role that accumulates context: 300k-770k in your sessions. Its per-turn cost scales with context × model weight. A lighter lead model lowers every turn; a heavier lead only pays off if it saves whole iterations.
- **Recommendation:** `cc` (Sonnet lead) as the default for long autonomous implementation sessions. Use `cco` (Opus lead) for architecture and design, unclear root causes, and TIA planning. Evidence level: benchmarks DOC; limit savings UNKNOWN until measured (M1).

### Q3. Best implementer model
- No data was found for WPF/C#, ChibiOS/ESP-IDF or Svelte by model: UNKNOWN.
- COMM guidance: Sonnet for clear-requirement refactors, Opus for multi-file root-cause work. One blog's claim of "+37% first-attempt fixes" for Opus is unverified (nxcode.io).
- Haiku 5.5 is positioned by Anthropic for focused edits across many files as a subagent (DOC-snippet: anthropic.com/claude/haiku). It is not proven for coupled changes.
- **Recommendation:**
  - (a) Coupled multi-file C#: Sonnet, escalating to Opus after one failed attempt or for cross-module design.
  - (b) Embedded C/C++: Sonnet with a hardware-aware brief; Opus for concurrency, ISR or RTOS bugs.
  - (c) UI: Sonnet.
  - The existing SequenceStudio `implementer` / `implementer-heavy` split already matches this; those agent files are not in this repo.

### Q4. Verification with Haiku
- No study measures Haiku's false-PASS rate: UNKNOWN.
- Known failure modes (COMM, small samples):
  - claiming "tests pass" without running anything
  - accepting "0 passed (no tests collected)"
  - treating exit 0 alone as proof

  Weak judges showed 25% false pass in an 8-scenario test (dev.to/zxpmail, COMM).
- Anthropic recommends a fresh-context reviewer with restricted tools that is asked for command output, not "all tests pass" (DOC-snippet: https://code.claude.com/docs/en/best-practices). It also describes the evaluator-optimizer pattern (DOC: https://www.anthropic.com/engineering/building-effective-agents).
- **What works:** a deterministic script prints PASS/FAIL and the exit code. The runner must quote the command, the exit code and the last 20 lines of output. Optionally, a Stop hook blocks completion until the check passes (DOC, capped at 8 blocks).
- **Split:** the *runner* (cheap, no judgement) executes and quotes; the *reviewer* (Opus, high effort) judges the diff against the brief. Haiku as runner is plausible only behind a deterministic script, so measure it first (M5).

### Q5. Advisor
- The advisor gets the full conversation, and "each advisor call processes the full transcript anew", with no caching (DOC: advisor).
- No setting caps calls. `/advisor off`, `CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1` and `--advisor` exist. The advisor must rank at or above the main model (DOC). So `cc` (Sonnet + Opus advisor) is valid, and so is `cco` (Opus + Fable advisor).
- One call at 700k context = 700k uncached tokens at advisor rates. This matches your observation of 3 calls ≈ 706k.
- **Pays off** at decision points with small context: before the approach is chosen, or after two failed attempts.
- **Pattern:**
  1. Keep it on-demand as your rule [advisor-ctx] says: handoff, `/clear`, then ask the advisor from the handoff.
  2. The `graph-hint.js` warning at 150k already enforces the nudge.
- **Fable vs Opus:** Fable is stronger (DOC: choosing-a-model), but it may bill credits and has its own weekly bar. Use Opus as the advisor for a Sonnet lead. For an Opus lead, Fable is the only stronger option; measure M3 before keeping it.

### Q6. Context management
- `/clear` is free. `/compact` reads the whole conversation, so it is a large request (DOC: costs).
- `autoCompactWindow` (settings, also per model and per agent) caps the effective window, so a 1M model compacts as if it had less. `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` lowers the trigger. `autoCompactEnabled` and `idleCompaction` can be set to false (DOC: settings-reference, env-vars).
- Prompt cache TTL is 1 hour for the lead on a subscription and **5 minutes for subagents** by default (`subagentPromptCacheTtl`). Editing CLAUDE.md mid-session does not break the cache; `/model`, fast-mode toggles, `/compact` and opusplan toggles do (DOC: prompt-caching).
- Subagents return only their final message. Anthropic's own subagents return about 1-2k tokens (DOC: effective-context-engineering). Your agents already cap output (Explore 1-3 sentences, researcher at most 8 lines).
- MCP tool search defers tool schemas by default; `alwaysLoad` is per server (DOC: mcp). Your roughly 600 TIA tools are already deferred, so no change is needed.
- Keep CLAUDE.md under 200 lines. Imports don't reduce cost; skills do (DOC: memory, costs). `user/CLAUDE.md` is 53 lines and 7.4 KB, which is fine.
- **Quantified:** none. Anthropic gives no degradation curve. The COMM issue #87646 suggests re-reading dominates spend in long sessions.

### Q7. Parallelism
- Anthropic's research system uses 3-5 parallel subagents. Multi-agent runs use about 15× the tokens of chat, and agents about 4× (DOC: https://www.anthropic.com/engineering/multi-agent-research-system). Agent teams use about 7× in plan mode (DOC: costs).
- The default concurrency cap is 20 running subagents per session (`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`) (DOC: sub-agents). No Max-specific ceiling is published: UNKNOWN.
- Background agents run by default and the parent keeps working (DOC). For wall-clock time, background always helps. For limits, the cost is the same.
- **Recommendation:**
  - up to about 4 parallel agents that write or do long work
  - up to about 6 short read-only Explore/researcher agents (they are cheap and their context is small)

  Measure with M6.

### Q8. Effort per role
- Levels run from `low` to `max`, with per-agent frontmatter `effort` and the `CLAUDE_CODE_SUBAGENT_EFFORT` fallback (DOC: model-config, sub-agents).
- Anthropic's guidance (DOC: model-config):
  - `low` for simple or mechanical work
  - `high` where verification or edge cases matter
  - `max` has diminishing returns
  - Sonnet at max caused out-of-scope edits
- **Per role:**

  | Role | Effort |
  |---|---|
  | Explore, researcher | low |
  | builder, tia-operator, lead | medium |
  | reviewer | high |
  | implementer-heavy (SequenceStudio) | high |
  | anything | never max |

### Q9. What you're missing
1. **No per-agent `effort` is set anywhere.** All your agents inherit medium.
2. **Subagent cache TTL is 5 minutes.** Builders waiting on long builds lose their cache. `subagentPromptCacheTtl: "1h"` is an option, but the cost of 1-hour cache writes against limits is UNKNOWN, so it goes to the measurement plan.
3. **`autoCompactWindow` is unset.**
4. **Fast mode spends credits** (DOC). Keep it off.
5. **`fallbackModel` won't save you at a rate limit** (DOC).
6. **`/usage` attribution and recommendations (`f`)** show which agents and plugins burn usage (DOC).
7. **Output-filtering hooks** can trim test logs before they enter context (DOC: costs).
8. **Model precedence for subagents:** frontmatter `model` beats `CLAUDE_CODE_SUBAGENT_MODEL`, unless `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` is set (DOC: sub-agents). Your Haiku and Opus agent pins are therefore effective; only general-purpose and Plan fall back to Sonnet.
9. **Repo vs your description:**
   - No hook blocks Grep/Glob for the lead or edits over 40 lines. Routing is text-only (`graph-hint.js`); `guard.js` blocks web access, builds and tests, flashing, and dangerous TIA calls.
   - The `researcher` agent exists in `user/agents/` but was not available in this session. Check that `Sync-ClaudeSetup` copies it.

## 3. Recommended setup

| Role | Model | Effort | Tools | When |
|---|---|---|---|---|
| Lead (`cc`, default) | Sonnet 5.5 | medium | all; guard blocks web, builds and tests | long autonomous implementation sessions |
| Lead (`cco`) | Opus 5.5 | medium | same | design, root cause, TIA planning |
| Advisor | Opus (for `cc`), Fable (for `cco`, pending M3) | n/a | n/a | on demand only at small context, after handoff and `/clear` |
| Explore | Haiku | low | Read, Grep, Glob, Bash | every lookup |
| researcher | Haiku | low | WebSearch, WebFetch, Read | every web question |
| builder | Sonnet | medium | all except Agent and TIA | implementation, builds and tests |
| reviewer | Opus | high | Read, Grep, Glob, Bash | diffs over ~50 lines or risky ones |
| tia-operator | Sonnet | medium | all except Agent | one live TIA change at a time |
| tester (optional, after M5) | Haiku | low | Bash, Read (no Edit/Write) | runs a deterministic checklist and quotes the evidence |
| implementer-heavy (SequenceStudio) | Opus | high | project-defined | escalation after one failed Sonnet attempt |

## 4. Concrete changes (not applied)

1. `user/agents/Explore.md` frontmatter: add `effort: low`.
2. `user/agents/researcher.md` frontmatter: add `effort: low`.
3. `user/agents/builder.md` frontmatter: add `effort: medium`. Body: add *"For every build/test: quote the exact command, its exit code and the last 20 output lines on FAIL. 'No tests collected' is FAIL."*
4. `user/agents/reviewer.md` frontmatter: add `effort: high`.
5. `user/agents/tia-operator.md` frontmatter: add `effort: medium`.
6. `user/settings.json`: add `"autoCompactWindow": 400000` as a safety net. Sessions currently reach 770k; this lowers it without making compaction constant.
7. `user/CLAUDE.md`, "Main session only": add two lines:
   - *"Parallel: at most 4 writing/long agents at once; read-only Explore/researcher up to 6."*
   - *"Never use /fast (bills usage credits)."*
8. `user/CLAUDE.md` line 31: change *"consult the advisor"* to *"consult the advisor (on demand only; at small context, see [advisor-ctx])"*. No hook change is needed; `graph-hint.js` CTX_LIMIT 150000 already nudges.
9. `install.ps1`: no change. `cc` stays Sonnet lead + Opus advisor (`user/cc-settings.json`), and `cco` stays Opus + Fable until M3 is done. If M3 shows Fable advisor calls billing credits, set `"advisorModel": "opus"` in `user/settings.json`.
10. Optional after M5: a new `user/agents/tester.md` with Haiku, `effort: low`, `tools: Bash, Read`, a body that only runs the given script and quotes command, exit code and tail, and a PONYTAIL matcher entry if needed.
11. Optional after M7: `"subagentPromptCacheTtl": "1h"` in `user/settings.json`.
12. Check `Sync-ClaudeSetup` / `install.ps1`: `researcher` was not available as an agent type in a Desktop session. Confirm it is deployed to `~/.claude/agents/`.

## 5. Measurement plan (one week)

Record each run as: start and end % for 5h, weekly-all and per-model (Agent Board LIMITS plus `/usage`), wall-clock time, number of fix iterations, and reviewer findings. Run comparisons at a similar time of day and with similar task sizes.

| # | Question | Steps |
|---|---|---|
| M1 | Sonnet vs Opus lead | Take 2 comparable tasks from your backlog, for example two similar SequenceStudio features. Run one with `cc` and one with `cco`, then swap roles on the next pair. Compare Δweekly% per task and iterations to green. Do 2 pairs (4 tasks) minimum. |
| M2 | Do cache reads count? | Session A: after `/clear` (~20k context), send 5× "reply ok" within 1 minute and note Δ5h%. Session B: same, at ~300k context. If B's Δ is much larger than A's, cache reads weigh materially, and the case for handoff plus `/clear` strengthens. |
| M3 | Advisor cost and billing | At about 50k context, force one advisor call ("consult the advisor now"). Note Δ on the Fable bar, the weekly-all bar and usage-credit balance. Repeat with `advisorModel: opus`. |
| M4 | Reviewer effort | Run the same diff through reviewer at `high` and at `medium` (per-invocation override). Compare real findings and Δ%. |
| M5 | Haiku tester reliability | Prepare a checklist with one test deliberately broken and one "0 tests collected" case. Run the Haiku tester 5× and the Sonnet builder 5×. Count false PASS results and missing evidence. Adopt the tester only if it has 0 false PASS. |
| M6 | Parallelism | Split the same research question into 1 agent and into 4 parallel agents. Compare Δ5h% and wall-clock time. |
| M7 | Subagent cache TTL | Run a builder with a build longer than 5 minutes using the default 5m TTL, then with `subagentPromptCacheTtl: "1h"`. Compare Δ%. |
| Daily | Attribution | At the end of each day, run `/usage` and note the attribution by subagent and plugin. Apply `f` recommendations only after reading them. |

## 6. Open questions / unknowns

- The weight of each model against the weekly-all limit. Not published.
- The weight of cache reads and cache writes (5m vs 1h) against Max limits (M2, M7).
- Whether advisor calls land on the advisor model's per-model bar or on usage credits (M3).
- The base 5-hour and weekly sizes for Max $200 (support article unavailable).
- Fable 5.2 agentic-coding benchmarks. Not found in primary sources.
- Haiku's false-PASS rate as a test runner (M5).
- Per-domain quality (WPF, ChibiOS, ESP-IDF, Svelte) by model. No data.
- The SequenceStudio agents (implementer, implementer-heavy, mechanic, test-author) live in that repo and were not reviewed here.
- `MAX_MCP_OUTPUT_TOKENS` default and the auto-compact default threshold were not read.

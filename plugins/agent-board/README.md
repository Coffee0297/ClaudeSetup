# Agent Board

A side pane for Claude Code that shows, live:

- **Lead**: the main session's model, the advisor model from settings, what the lead is doing now, a token sparkline, tokens in/out, turns and its estimated cost.
- **Agents**: every subagent this session (newest first): type, model, effort, status, elapsed time, estimated cost, the tool and file or command it is running now, and a token sparkline with its token count.
- **Cost share**: a bar graph of the session's estimated cost split between the lead and each agent type.
- **Log**: agent starts and ends, blocked tool calls (for example by a guard hook), and lead turns.

Open it with `/board`. It also opens by itself when a session starts. It refreshes every 2 seconds.

Costs are client-side estimates, not billing. The advisor shown is the `advisorModel` setting; a `--advisor` flag on the command line overrides it, and mods cannot read that flag.

Requires Claude Code 2.1.287 or later (mods).

// PreToolUse guard: blocks hardware writes, PR/release creation and dangerous
// generic TIA Openness calls. Exit 2 = block (works in every permission mode).
let raw = '';
process.stdin.on('data', (d) => (raw += d));
process.stdin.on('end', () => {
  let ev = {};
  try { ev = JSON.parse(raw); } catch { process.exit(0); }
  const tool = String(ev.tool_name || '');
  const input = ev.tool_input || {};
  const block = (why) => {
    process.stderr.write(`Blocked by guard hook: ${why}. Do not retry or work around this; tell the user the exact command/call so they can run it themselves.`);
    process.exit(2);
  };

  if (/^mcp__tia-portal.*__InvokeOpennessApi$/.test(tool)) {
    const s = JSON.stringify(input);
    if (/download|upload|ip.?address|ipv4|subnet|router|password|secret|firmware|go.?online|online|protect|knowhow|know.?how|factory.?reset|ram.?to.?rom|activation.?state|safety|alarm|runtime|commit.?session|delete.?(local)?session/i.test(s)) {
      block('InvokeOpennessApi call touches download/network/password/protection/safety/online/runtime');
    }
    process.exit(0);
  }

  if (tool === 'Bash' && /\b(powershell|pwsh)(\.exe)?\b[^\n]*\s-(c|command|enc|encodedcommand)\b/i.test(String(input.command || ''))) {
    process.stderr.write('Blocked: do not run PowerShell through Bash (Bash rewrites $_ and $variables). Use the PowerShell tool for this command instead.');
    process.exit(2);
  }

  // Web searches/fetches belong in the `researcher` (Haiku) subagent, not in the lead's context.
  if ((tool === 'WebSearch' || tool === 'WebFetch') && !ev.agent_id && process.env.CLAUDE_LEAD_WEB !== '1') {
    process.stderr.write('Blocked in the main session: web searches and page fetches go to the `researcher` subagent (Haiku). Brief it with the exact question; it returns a short answer with source URLs. (The user can allow lead web access by starting Claude with CLAUDE_LEAD_WEB=1.)');
    process.exit(2);
  }

  // Builds and test runs belong in a builder subagent, not in the lead's context.
  // agent_id is present only for subagent calls. Opt out per shell: CLAUDE_LEAD_BUILDS=1.
  if ((tool === 'Bash' || tool === 'PowerShell') && !ev.agent_id && process.env.CLAUDE_LEAD_BUILDS !== '1') {
    const heavy = /\b(dotnet\s+(build|test|publish|run|pack)|msbuild|npm\s+(run\s+)?(build|test)|pnpm\s+(run\s+)?(build|test)|yarn\s+(build|test)|npx\s+(vitest|jest|playwright|tsc)|pytest|idf\.py\s+build|cmake\s+--build|cargo\s+(build|test)|go\s+(build|test)|mvn|gradlew?|TiaMcpSetup\.exe)\b|(^|\s)--selftest\b|\bpython\S*\s+\S*(test|mksbx|drive|sandbox|build)\S*\.py/i
    if (heavy.test(String(input.command || ''))) {
      process.stderr.write('Blocked in the main session: builds and test runs go to a `builder` subagent (run it in the background). Brief it with the exact commands and ask for only pass/fail plus the first errors per target, then keep working. (The user can allow lead builds by starting Claude with CLAUDE_LEAD_BUILDS=1.)');
      process.exit(2);
    }
  }

  if (tool === 'Bash' || tool === 'PowerShell') {
    const c = String(input.command || '');
    const rules = [
      [/\besptool(\.py)?\b[^\n]*\b(write[_-]flash|erase[_-]flash|erase[_-]region|write[_-]mem|merge[_-]bin[^\n]*--flash)\b/i, 'esptool flash/erase'],
      [/\bespefuse(\.py)?\b[^\n]*\bburn/i, 'espefuse burn (irreversible)'],
      [/\bidf\.py\b[^\n]*\b(flash|app-flash|erase[_-]flash|dfu-flash|encrypted-flash)\b/i, 'idf.py flash'],
      [/\bdfu-util\b[^\n]*(\s-D\b|--download)/i, 'dfu-util download'],
      [/\bSTM32_Programmer_CLI\b[^\n]*(\s-w\b|\s-e\b|--write|--erase|\s-d\b|--download)/i, 'STM32 programmer write/erase'],
      [/\bBootCommander\b/i, 'OpenBLT BootCommander flash'],
      [/\b(curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr|irm)\b[^\n]*(flash|bootloader|dfu|firmware)/i, 'HTTP call to a flash/bootloader/firmware endpoint'],
      [/\bgh\s+pr\s+create\b/i, 'opening a pull request (user does this)'],
      [/\bgh\s+release\s+create\b/i, 'creating a release (user does this)'],
    ];
    for (const [re, why] of rules) if (re.test(c)) block(why);
  }
  process.exit(0);
});

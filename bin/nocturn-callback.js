#!/usr/bin/env node
/**
 * Nocturn agent callback shim — the executable the briefings tell agents to call.
 *
 * Usage (from inside an agent's bash tool):
 *   nocturn report  --task TASK-450 --agent pi-coder --state ready --risk low --summary "..." --pr 112
 *   nocturn dispatch --task TASK-450 --to pi-coder --order "..." --instructions "..."
 *   nocturn fanout  --parent TASK-450 --subtasks '[{"id":"TASK-450-1","title":"...","to":"pi-coder"}]'
 *   nocturn note    --task TASK-450 --to pi-coder --from dev-leader --text "..."
 *   nocturn recruit --id sec-auditor --name "安全审计员" --squad dev --skills "audit" --instructions "..."
 *   nocturn handback --task TASK-450 --trigger <triggerId> --reason "..."
 *   nocturn memory write  --agent pi-coder [--scope shared] [--kind lesson] --text "..." [--tags "a,b"]
 *   nocturn memory search --agent pi-coder --q "关键词" [--limit 5]
 *   nocturn memory list   [--scope shared]
 *
 * Forwards everything to the Nocturn server's POST /api/cli endpoint.
 * Env: NOCTURN_API (default http://127.0.0.1:${PORT:-4100})
 */

function parseArgv(argv) {
  const args = {};
  let key = null;
  for (const part of argv) {
    if (part.startsWith("--")) {
      const eq = part.indexOf("=");
      if (eq > 2) {
        args[part.slice(2, eq)] = part.slice(eq + 1);
        key = null;
      } else {
        key = part.slice(2);
        args[key] = true; // bare flag; overwritten when a value follows
      }
    } else if (key) {
      args[key] = part;
      key = null;
    } else {
      args._positional = part;
    }
  }
  return args;
}

async function main() {
  const argv = process.argv.slice(2);
  const [command, ...rest] = argv;
  if (!command || command === "-h" || command === "--help") {
    console.log(
      "Usage: nocturn <report|handback|dispatch|fanout|note|recruit|memory> [--key value ...]\n" +
        "memory: nocturn memory <write|search|list> [--agent id] [--scope shared] [--kind lesson] --text ... --q ... --tags a,b"
    );
    process.exit(command ? 0 : 1);
  }

  const args = parseArgv(rest);
  if (args._positional) {
    // `nocturn memory write --text ...` style: first positional is the action
    if (!args.action) args.action = args._positional;
  }

  const api = process.env.NOCTURN_API ?? `http://127.0.0.1:${process.env.PORT ?? 4100}`;
  let response;
  try {
    response = await fetch(`${api}/api/cli`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command, args }),
    });
  } catch (err) {
    console.error(`nocturn: cannot reach Nocturn server at ${api}: ${err.message}`);
    process.exit(2);
  }

  const body = await response.text();
  if (!response.ok) {
    console.error(`nocturn: ${command} failed (HTTP ${response.status}): ${body}`);
    process.exit(1);
  }
  console.log(body);
}

main().catch((err) => {
  console.error(`nocturn: ${err?.stack ?? err}`);
  process.exit(1);
});

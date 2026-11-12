#!/usr/bin/env bun
/**
 * Standalone entry for `bun build --compile` packaging.
 *
 * Differences from running src/server/index.ts directly:
 * - The web UI is embedded into the binary via a file import; NOCTURN_UI points the
 *   server at the embedded copy.
 * - The SQLite database defaults to ~/.nocturn/nocturn.sqlite because a single-file
 *   binary has no repo directory to hold .nocturn.sqlite. Override with NOCTURN_DB.
 * - The server module is imported dynamically AFTER the env vars above are set, so its
 *   direct-run autostart guard (which false-fires inside a compiled bundle) stays off
 *   and this file owns the startup instead.
 */
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import uiAsset from "../src/ui/index.html" with { type: "file" };

process.env.NOCTURN_UI = uiAsset;
process.env.NOCTURN_SKIP_AUTOSTART = "1";

const dbPath = process.env.NOCTURN_DB ?? join(homedir(), ".nocturn", "nocturn.sqlite");
mkdirSync(dirname(dbPath), { recursive: true });

const port = Number(process.env.PORT ?? 4100);
const { createNocturnServer } = await import("../src/server/index.ts");
const { server } = createNocturnServer(dbPath);
server.listen(port, "127.0.0.1", () => {
  console.log(`Nocturn Server running on http://127.0.0.1:${port}`);
});

#!/usr/bin/env node
import { normalizeRelayUrl } from "@spencer/protocol";
import { parseArgs } from "node:util";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { defaultDataDir, loadConfig, type SpencerConfig } from "./config.ts";
import { Daemon } from "./daemon.ts";
import { writeSecretFile } from "./store/files.ts";
import { spawn } from "node:child_process";
import { isBinary } from "./sea.ts";
import { serviceCommand } from "./service.ts";
import { spencerVersion } from "./version.ts";

const SELF = isBinary() ? "spencer" : "node packages/spencer/src/main.ts";
const USAGE = `usage: ${SELF} [--data-dir DIR] [--port N] [--name NAME] [--relay URL] [--no-open]
       ${SELF} service install|uninstall|status   (optional: start Spencer at login)

  --data-dir DIR  data directory (env SPENCER_DATA_DIR; default ~/.local/share/spencer)
  --port N        local UI/API port on 127.0.0.1 (env SPENCER_PORT; 0 = random)
  --name NAME     display name; saved to config.json on first run
  --relay URL     relay URL (env SPENCER_RELAY; saved on first run)
  --open          open the web UI in a browser once started (default when run from a terminal)
  --no-open       don't
  -v, --version   print the version
`;

/** Best-effort: open the UI in the default browser. */
function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    /* no browser: the URL is printed anyway */
  }
}

async function main(): Promise<void> {
  let args;
  try {
    args = parseArgs({
      options: {
        "data-dir": { type: "string" },
        port: { type: "string" },
        name: { type: "string" },
        relay: { type: "string" },
        open: { type: "boolean" },
        "no-open": { type: "boolean" },
        version: { type: "boolean", short: "v" },
        V: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
      allowPositionals: true,
    });
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n${USAGE}`);
    process.exit(2);
  }
  const { values: opts, positionals } = args;
  if (opts.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (opts.version || opts.V) {
    process.stdout.write(`spencer ${spencerVersion()} (node ${process.versions.node})\n`);
    return;
  }
  const dataDir = resolve(opts["data-dir"] ?? defaultDataDir());
  if (positionals[0] === "service") {
    process.exit(serviceCommand(positionals[1], dataDir, (m) => process.stdout.write(m)));
  }
  if (positionals.length) {
    process.stderr.write(`unknown command ${positionals[0]}\n${USAGE}`);
    process.exit(2);
  }
  if (opts.port !== undefined) {
    const p = Number(opts.port);
    if (!Number.isInteger(p) || p < 0 || p > 65535) {
      process.stderr.write(`invalid --port ${opts.port}\n`);
      process.exit(2);
    }
    process.env.SPENCER_PORT = String(p); // CLI wins over env and config.json
  }

  if (opts.relay !== undefined) {
    try { process.env.SPENCER_RELAY = normalizeRelayUrl(opts.relay); }
    catch { process.stderr.write(`invalid --relay ${opts.relay}\n`); process.exit(2); }
  }
  const firstRun = !existsSync(join(dataDir, "config.json"));
  if (firstRun && opts.relay !== undefined) {
    loadConfig(dataDir);
    const file = join(dataDir, "config.json");
    const raw = JSON.parse(readFileSync(file, "utf8"));
    raw.relay = process.env.SPENCER_RELAY;
    if (opts.name !== undefined) raw.name = opts.name;
    writeSecretFile(file, JSON.stringify(raw, null, 2) + "\n");
  }
  const override: Partial<SpencerConfig> = {};
  if (opts.name !== undefined) {
    const file = join(dataDir, "config.json");
    if (!existsSync(file)) {
      loadConfig(dataDir); // writes the default config
      const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      raw.name = opts.name;
      writeSecretFile(file, JSON.stringify(raw, null, 2) + "\n");
    } else {
      override.name = opts.name;
    }
  }

  const daemon = new Daemon({ dataDir, config: override });
  try {
    await daemon.start();
  } catch (e) {
    process.stderr.write(`spencer: ${(e as Error).message}\n`);
    process.exit(1);
  }
  const { name, fingerprint } = daemon.identity;
  const infoFile = join(dataDir, "daemon.json");
  writeSecretFile(infoFile, JSON.stringify({ pid: process.pid, port: daemon.port }) + "\n");
  const url = `http://127.0.0.1:${daemon.port}/`;
  process.stdout.write(`Spencer "${name}" ${fingerprint} — UI: ${url}\n`);
  // Open the UI when started by hand from a terminal; never under systemd/launchd or with --no-open.
  const interactive = process.stdout.isTTY && !process.env.INVOCATION_ID;
  if (!opts["no-open"] && (opts.open || interactive)) openBrowser(url);

  let stopping = false;
  const shutdown = (sig: string) => {
    if (stopping) {
      process.stderr.write(`spencer: ${sig} again, exiting now\n`);
      process.exit(130);
    }
    stopping = true;
    process.stderr.write(`spencer: ${sig}, stopping…\n`);
    const force = setTimeout(() => {
      process.stderr.write("spencer: graceful stop timed out\n");
      process.exit(1);
    }, 15_000);
    force.unref();
    daemon
      .stop()
      .catch((e: Error) => process.stderr.write(`spencer: stop failed: ${e.message}\n`))
      .finally(() => {
        try {
          const cur = JSON.parse(readFileSync(infoFile, "utf8")) as { pid?: number };
          if (cur.pid === process.pid) unlinkSync(infoFile);
        } catch {
          /* gone */
        }
        process.exit(0);
      });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

void main();

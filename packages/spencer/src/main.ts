#!/usr/bin/env node
import { parseArgs } from "node:util";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { defaultDataDir, loadConfig, type SpencerConfig } from "./config.ts";
import { Daemon } from "./daemon.ts";
import { writeSecretFile } from "./store/files.ts";

const USAGE = `usage: node packages/spencer/src/main.ts [--data-dir DIR] [--port N] [--name NAME]

  --data-dir DIR  data directory (env SPENCER_DATA_DIR; default ~/.local/share/spencer)
  --port N        local UI/API port on 127.0.0.1 (env SPENCER_PORT; 0 = random)
  --name NAME     display name; saved to config.json on first run
`;

async function main(): Promise<void> {
  let args;
  try {
    args = parseArgs({
      options: {
        "data-dir": { type: "string" },
        port: { type: "string" },
        name: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
    }).values;
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n${USAGE}`);
    process.exit(2);
  }
  if (args.help) {
    process.stdout.write(USAGE);
    return;
  }
  const dataDir = resolve(args["data-dir"] ?? defaultDataDir());
  if (args.port !== undefined) {
    const p = Number(args.port);
    if (!Number.isInteger(p) || p < 0 || p > 65535) {
      process.stderr.write(`invalid --port ${args.port}\n`);
      process.exit(2);
    }
    process.env.SPENCER_PORT = String(p); // CLI wins over env and config.json
  }

  const override: Partial<SpencerConfig> = {};
  if (args.name !== undefined) {
    const file = join(dataDir, "config.json");
    if (!existsSync(file)) {
      loadConfig(dataDir); // writes the default config
      const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      raw.name = args.name;
      writeSecretFile(file, JSON.stringify(raw, null, 2) + "\n");
    } else {
      override.name = args.name;
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
  process.stdout.write(`Spencer "${name}" ${fingerprint} — UI: http://127.0.0.1:${daemon.port}/\n`);

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

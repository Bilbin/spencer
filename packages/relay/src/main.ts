import { join } from "node:path";
import { startRelay } from "./server.ts";

// Config from env (PROTOCOL §4.5).
const env = process.env;
const host = env.SPENCER_RELAY_HOST || "127.0.0.1";
const port = Number(env.SPENCER_RELAY_PORT || 8820);
const dbPath = env.SPENCER_RELAY_DB || join(env.STATE_DIRECTORY || ".", "relay.sqlite");
const ttlDays = Number(env.SPENCER_RELAY_TTL_DAYS || 14);
// SPENCER_CROC_RELAY="" (set but empty) turns croc info off.
const crocRelay = env.SPENCER_CROC_RELAY ?? "spencer.pjalv.com:9009";
const crocPass = env.SPENCER_CROC_PASS || "";

const log = (msg: string) => console.log(msg);

if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`invalid SPENCER_RELAY_PORT: ${env.SPENCER_RELAY_PORT}`);
  process.exit(1);
}
if (!(ttlDays > 0)) {
  console.error(`invalid SPENCER_RELAY_TTL_DAYS: ${env.SPENCER_RELAY_TTL_DAYS}`);
  process.exit(1);
}
const crocOn = crocRelay !== "" && crocPass !== "";
if (crocRelay !== "" && !crocOn) log("warning: SPENCER_CROC_PASS is not set; croc relay info will not be sent to clients");

const relay = await startRelay({
  host,
  port,
  dbPath,
  ttlDays,
  ...(crocOn ? { crocRelay, crocPass } : {}),
  log,
});
log(`spencer-relay listening on ${relay.httpUrl} (db ${dbPath}, ttl ${ttlDays}d, croc ${crocOn ? crocRelay : "off"})`);

let stopping = false;
const stop = (sig: string) => {
  if (stopping) return;
  stopping = true;
  log(`${sig}: shutting down`);
  const force = setTimeout(() => process.exit(1), 5000);
  force.unref();
  relay.close().then(
    () => process.exit(0),
    (e) => {
      console.error(e);
      process.exit(1);
    },
  );
};
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));

/**
 * Read GitHub Copilot CLI OAuth tokens from the OS keyring when `~/.copilot/config.json` stores only
 * `loggedInUsers` (the default on desktop Linux and macOS) rather than plaintext `authTokens`.
 *
 * Copilot CLI stores each GitHub account token under service `"copilot-cli"` and account/username
 * `"https://github.com:<login>"` (using keyring-rs):
 *  - Linux: Freedesktop Secret Service (`org.freedesktop.secrets`, e.g. KDE ksecretd/KWallet6,
 *    GNOME Keyring, KeePassXC, oo7) over the user's D-Bus session socket (zero external dependencies),
 *    with a `secret-tool` fallback.
 *  - macOS: Keychain via `/usr/bin/security find-generic-password`.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { connect, type Socket } from "node:net";

const SERVICE = "copilot-cli";
const KEYRING_TIMEOUT_MS = 3_000;

export type KeyringLookupResult =
  | { status: "ok"; token: string }
  | { status: "locked" }
  | { status: "not_found" }
  | { status: "unavailable" };

export interface CopilotKeyring {
  available(): boolean;
  read(login: string, signal?: AbortSignal): Promise<KeyringLookupResult>;
}

/** Extracts the first Unix socket target (`unix:path=...` or `unix:abstract=...`) from a D-Bus address string. */
export function parseDbusUnixAddress(address: string | undefined): string | undefined {
  if (!address) return undefined;
  for (const part of address.split(";")) {
    const trimmed = part.trim();
    if (!trimmed.startsWith("unix:")) continue;
    for (const kv of trimmed.slice(5).split(",")) {
      const eq = kv.indexOf("=");
      if (eq === -1) continue;
      const key = kv.slice(0, eq);
      const rawVal = kv.slice(eq + 1);
      if (!rawVal) continue;
      let val: string;
      try {
        val = decodeURIComponent(rawVal);
      } catch {
        continue;
      }
      if (key === "path") return val;
      if (key === "abstract") return `\0${val}`;
    }
  }
  return undefined;
}

/** Session D-Bus address on Linux: `$DBUS_SESSION_BUS_ADDRESS`, else `/run/user/<uid>/bus` if present. */
export function defaultDbusSessionAddress(): string | undefined {
  if (process.platform !== "linux") return undefined;
  if (process.env.DBUS_SESSION_BUS_ADDRESS) return process.env.DBUS_SESSION_BUS_ADDRESS;
  if (typeof process.getuid === "function") {
    const fallback = `/run/user/${process.getuid()}/bus`;
    if (existsSync(fallback)) return `unix:path=${fallback}`;
  }
  return undefined;
}

// ------------------------------------------------------------------ Minimal Freedesktop D-Bus wire client

function splitDbusSignature(sig: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < sig.length) {
    const start = i;
    const ch = sig[i++];
    if (ch === "a") {
      if (sig[i] === "{") {
        while (i < sig.length && sig[i] !== "}") i++;
        if (i < sig.length) i++;
      } else if (sig[i] === "(") {
        let depth = 1;
        i++;
        while (i < sig.length && depth > 0) {
          if (sig[i] === "(") depth++;
          else if (sig[i] === ")") depth--;
          i++;
        }
      } else {
        const inner = splitDbusSignature(sig.slice(i));
        if (!inner.length) break;
        i += inner[0]!.length;
      }
    } else if (ch === "(") {
      let depth = 1;
      while (i < sig.length && depth > 0) {
        if (sig[i] === "(") depth++;
        else if (sig[i] === ")") depth--;
        i++;
      }
    }
    out.push(sig.slice(start, i));
  }
  return out;
}

function dbusAlignment(type: string): number {
  const ch = type[0];
  if (ch === "(" || ch === "{" || ch === "x" || ch === "t" || ch === "d") return 8;
  if (ch === "s" || ch === "o" || ch === "u" || ch === "i" || ch === "b" || ch === "a") return 4;
  if (ch === "n" || ch === "q") return 2;
  return 1;
}

class DbusWriter {
  private chunks: Buffer[] = [];
  private len = 0;

  align(n: number): void {
    const pad = (n - (this.len % n)) % n;
    if (pad) {
      this.chunks.push(Buffer.alloc(pad));
      this.len += pad;
    }
  }
  raw(b: Buffer): void {
    this.chunks.push(b);
    this.len += b.length;
  }
  u8(v: number): void {
    this.raw(Buffer.from([v & 0xff]));
  }
  u32(v: number): void {
    this.align(4);
    const b = Buffer.alloc(4);
    b.writeUInt32LE(v >>> 0, 0);
    this.raw(b);
  }
  str(s: string): void {
    const b = Buffer.from(s, "utf8");
    this.u32(b.length);
    this.raw(b);
    this.u8(0);
  }
  sig(s: string): void {
    const b = Buffer.from(s, "ascii");
    this.u8(b.length);
    this.raw(b);
    this.u8(0);
  }
  val(t: string, v: unknown): void {
    if (t === "s" || t === "o") this.str(String(v));
    else if (t === "g") this.sig(String(v));
    else if (t === "y") this.u8(Number(v));
    else if (t === "u") this.u32(Number(v));
    else if (t === "v") {
      const vr = v as { sig: string; val: unknown };
      this.sig(vr.sig);
      this.val(vr.sig, vr.val);
    } else if (t === "a{ss}") {
      const sub = new DbusWriter();
      for (const [k, vv] of Object.entries(v as Record<string, string>)) {
        sub.align(8);
        sub.str(k);
        sub.str(vv);
      }
      const b = sub.finish();
      this.u32(b.length);
      this.align(8);
      this.raw(b);
    } else {
      throw new Error(`Unsupported D-Bus write signature: ${t}`);
    }
  }
  writeSigList(sig: string, args: unknown[]): void {
    const types = splitDbusSignature(sig);
    for (let i = 0; i < types.length; i++) this.val(types[i]!, args[i]);
  }
  finish(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

class DbusReader {
  private buf: Buffer;
  private le: boolean;
  pos: number;

  constructor(buf: Buffer, le: boolean, pos: number) {
    this.buf = buf;
    this.le = le;
    this.pos = pos;
  }
  align(n: number): void {
    this.pos = (this.pos + n - 1) & ~(n - 1);
  }
  u8(): number {
    return this.buf[this.pos++]!;
  }
  u16(): number {
    this.align(2);
    const v = this.le ? this.buf.readUInt16LE(this.pos) : this.buf.readUInt16BE(this.pos);
    this.pos += 2;
    return v;
  }
  u32(): number {
    this.align(4);
    const v = this.le ? this.buf.readUInt32LE(this.pos) : this.buf.readUInt32BE(this.pos);
    this.pos += 4;
    return v;
  }
  i32(): number {
    this.align(4);
    const v = this.le ? this.buf.readInt32LE(this.pos) : this.buf.readInt32BE(this.pos);
    this.pos += 4;
    return v;
  }
  u64(): bigint {
    this.align(8);
    const v = this.le ? this.buf.readBigUInt64LE(this.pos) : this.buf.readBigUInt64BE(this.pos);
    this.pos += 8;
    return v;
  }
  str(): string {
    const len = this.u32();
    const s = this.buf.subarray(this.pos, this.pos + len).toString("utf8");
    this.pos += len + 1;
    return s;
  }
  sig(): string {
    const len = this.u8();
    const s = this.buf.subarray(this.pos, this.pos + len).toString("ascii");
    this.pos += len + 1;
    return s;
  }
  val(t: string): unknown {
    if (t === "s" || t === "o") return this.str();
    if (t === "g") return this.sig();
    if (t === "y") return this.u8();
    if (t === "n" || t === "q") return this.u16();
    if (t === "u") return this.u32();
    if (t === "i") return this.i32();
    if (t === "b") return this.u32() !== 0;
    if (t === "x" || t === "t" || t === "d") return this.u64();
    if (t === "v") {
      const s = this.sig();
      return this.val(s);
    }
    if (t === "ay") {
      const len = this.u32();
      const b = Buffer.from(this.buf.subarray(this.pos, this.pos + len));
      this.pos += len;
      return b;
    }
    if (t.startsWith("a{")) {
      const len = this.u32();
      this.align(8);
      const end = this.pos + len;
      const [kt, vt] = splitDbusSignature(t.slice(2, -1));
      const obj: Record<string, unknown> = {};
      while (this.pos < end) {
        this.align(8);
        const k = String(this.val(kt!));
        obj[k] = this.val(vt!);
      }
      return obj;
    }
    if (t.startsWith("a")) {
      const et = t.slice(1);
      const len = this.u32();
      this.align(dbusAlignment(et));
      const end = this.pos + len;
      const arr: unknown[] = [];
      while (this.pos < end) arr.push(this.val(et));
      return arr;
    }
    if (t.startsWith("(")) {
      this.align(8);
      return this.readSigList(t.slice(1, -1));
    }
    throw new Error(`Unsupported D-Bus read signature: ${t}`);
  }
  readSigList(sig: string): unknown[] {
    return splitDbusSignature(sig).map((t) => this.val(t));
  }
}

class DbusClient {
  private sock: Socket;
  private serial = 1;
  private pending = new Map<number, { resolve: (v: unknown[]) => void; reject: (e: Error) => void }>();
  private buf: Buffer = Buffer.alloc(0);
  private authenticated = false;
  private closed = false;

  constructor(sockPath: string) {
    this.sock = connect(sockPath);
  }

  private failAll(err: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  async connect(signal: AbortSignal): Promise<void> {
    if (typeof process.getuid !== "function") throw new Error("getuid unavailable");
    const uidHex = Buffer.from(String(process.getuid()), "ascii").toString("hex");
    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(new Error("aborted"));
      let authBuf: Buffer = Buffer.alloc(0);
      const onAbort = () => {
        this.destroy();
        reject(new Error("aborted"));
      };
      signal.addEventListener("abort", onAbort, { once: true });

      const onError = (err: Error) => {
        signal.removeEventListener("abort", onAbort);
        this.failAll(err);
        reject(err);
      };
      const onClose = () => {
        const err = new Error("D-Bus socket closed");
        this.failAll(err);
        if (!this.authenticated) {
          signal.removeEventListener("abort", onAbort);
          reject(err);
        }
      };

      this.sock.on("error", onError);
      this.sock.on("close", onClose);
      this.sock.on("data", (chunk: Buffer) => {
        if (!this.authenticated) {
          authBuf = Buffer.concat([authBuf, chunk]);
          const crlf = authBuf.indexOf("\r\n");
          if (crlf === -1) return;
          const line = authBuf.subarray(0, crlf).toString("latin1");
          const rest = authBuf.subarray(crlf + 2);
          signal.removeEventListener("abort", onAbort);
          if (!line.startsWith("OK ")) {
            this.destroy();
            return reject(new Error(`D-Bus auth failed: ${line}`));
          }
          this.authenticated = true;
          this.sock.write("BEGIN\r\n");
          if (rest.length) this.onMessageData(rest);
          resolve();
        } else {
          this.onMessageData(chunk);
        }
      });

      this.sock.write(`\0AUTH EXTERNAL ${uidHex}\r\n`);
    });
    await this.call("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "Hello", "", [], signal);
  }

  private onMessageData(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (this.buf.length >= 16) {
      const endian = this.buf[0];
      const le = endian === 0x6c;
      if (!le && endian !== 0x42) {
        this.failAll(new Error("Invalid D-Bus message framing"));
        this.destroy();
        return;
      }
      const bodyLen = le ? this.buf.readUInt32LE(4) : this.buf.readUInt32BE(4);
      const fieldsLen = le ? this.buf.readUInt32LE(12) : this.buf.readUInt32BE(12);
      const hdrEnd = 16 + fieldsLen;
      const bodyStart = (hdrEnd + 7) & ~7;
      const total = bodyStart + bodyLen;
      if (this.buf.length < total) break;
      const msg = this.buf.subarray(0, total);
      this.buf = this.buf.subarray(total);
      this.handleMessage(msg, le, hdrEnd, bodyStart);
    }
  }

  private handleMessage(msg: Buffer, le: boolean, hdrEnd: number, bodyStart: number): void {
    const type = msg[1];
    if (type !== 2 && type !== 3) return;
    const r = new DbusReader(msg, le, 16);
    let replySerial = 0;
    let sig = "";
    let errName = "";
    while (r.pos < hdrEnd) {
      r.align(8);
      if (r.pos >= hdrEnd) break;
      const code = r.u8();
      const vsig = r.sig();
      const val = r.val(vsig);
      if (code === 5) replySerial = Number(val);
      else if (code === 8) sig = String(val);
      else if (code === 4) errName = String(val);
    }
    const pending = this.pending.get(replySerial);
    if (!pending) return;
    this.pending.delete(replySerial);
    try {
      const vals = sig ? new DbusReader(msg, le, bodyStart).readSigList(sig) : [];
      if (type === 3) pending.reject(new Error(`${errName}: ${String(vals[0] ?? "")}`));
      else pending.resolve(vals);
    } catch (e) {
      pending.reject(e instanceof Error ? e : new Error(String(e)));
    }
  }

  call(dest: string, path: string, iface: string, member: string, sig: string, args: unknown[], signal: AbortSignal): Promise<unknown[]> {
    if (this.closed || signal.aborted) return Promise.reject(new Error("D-Bus client closed"));
    const serial = this.serial++;
    const bodyW = new DbusWriter();
    if (sig) bodyW.writeSigList(sig, args);
    const body = bodyW.finish();

    const hdrW = new DbusWriter();
    hdrW.u8(0x6c); // little-endian
    hdrW.u8(1); // METHOD_CALL
    hdrW.u8(0); // flags
    hdrW.u8(1); // protocol version
    hdrW.u32(body.length);
    hdrW.u32(serial);

    const fieldsW = new DbusWriter();
    const field = (code: number, vsig: string, val: unknown) => {
      fieldsW.align(8);
      fieldsW.u8(code);
      fieldsW.sig(vsig);
      fieldsW.val(vsig, val);
    };
    field(1, "o", path);
    field(2, "s", iface);
    field(3, "s", member);
    field(6, "s", dest);
    if (sig) field(8, "g", sig);
    const fields = fieldsW.finish();

    hdrW.u32(fields.length);
    hdrW.raw(fields);
    hdrW.align(8);
    hdrW.raw(body);
    const packet = hdrW.finish();

    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.pending.delete(serial);
        reject(new Error("aborted"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.pending.set(serial, {
        resolve: (v) => {
          signal.removeEventListener("abort", onAbort);
          resolve(v);
        },
        reject: (e) => {
          signal.removeEventListener("abort", onAbort);
          reject(e);
        },
      });
      this.sock.write(packet);
    });
  }

  destroy(): void {
    this.closed = true;
    this.sock.destroy();
  }
}

async function readFreedesktopSecret(service: string, username: string, sockPath: string, signal: AbortSignal): Promise<KeyringLookupResult> {
  const dbus = new DbusClient(sockPath);
  let sessionPath: string | undefined;
  try {
    await dbus.connect(signal);
    const [, sp] = await dbus.call(
      "org.freedesktop.secrets",
      "/org/freedesktop/secrets",
      "org.freedesktop.Secret.Service",
      "OpenSession",
      "sv",
      ["plain", { sig: "s", val: "" }],
      signal,
    );
    sessionPath = typeof sp === "string" ? sp : undefined;
    if (!sessionPath) return { status: "unavailable" };

    const [unlockedRaw, lockedRaw] = await dbus.call(
      "org.freedesktop.secrets",
      "/org/freedesktop/secrets",
      "org.freedesktop.Secret.Service",
      "SearchItems",
      "a{ss}",
      [{ service, username }],
      signal,
    );
    const unlocked = Array.isArray(unlockedRaw) ? (unlockedRaw as string[]) : [];
    const locked = Array.isArray(lockedRaw) ? (lockedRaw as string[]) : [];
    if (!unlocked.length) return locked.length ? { status: "locked" } : { status: "not_found" };

    const [secretStruct] = await dbus.call("org.freedesktop.secrets", unlocked[0]!, "org.freedesktop.Secret.Item", "GetSecret", "o", [sessionPath], signal);
    const value = Array.isArray(secretStruct) ? secretStruct[2] : undefined;
    const token = Buffer.isBuffer(value) ? value.toString("utf8").trim() : "";
    return token ? { status: "ok", token } : { status: "not_found" };
  } catch {
    return { status: "unavailable" };
  } finally {
    if (sessionPath && !signal.aborted) {
      await dbus.call("org.freedesktop.secrets", sessionPath, "org.freedesktop.Secret.Session", "Close", "", [], signal).catch(() => {});
    }
    dbus.destroy();
  }
}

function execText(cmd: string, args: string[], signal: AbortSignal): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: KEYRING_TIMEOUT_MS, maxBuffer: 64 * 1024, signal }, (err, stdout, stderr) => {
      if (!err) return resolve({ code: 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      const code = typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : -1;
      resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}

async function readSecretTool(service: string, username: string, signal: AbortSignal): Promise<KeyringLookupResult> {
  const r = await execText("secret-tool", ["lookup", "service", service, "username", username], signal);
  if (r.code === 0) {
    const token = r.stdout.trim();
    return token ? { status: "ok", token } : { status: "not_found" };
  }
  if (r.code === 1) return { status: "not_found" };
  return { status: "unavailable" };
}

async function readMacosKeychain(service: string, account: string, signal: AbortSignal): Promise<KeyringLookupResult> {
  const r = await execText("/usr/bin/security", ["find-generic-password", "-s", service, "-a", account, "-w"], signal);
  if (r.code === 0) {
    const token = r.stdout.trim();
    return token ? { status: "ok", token } : { status: "not_found" };
  }
  if (r.code === 44) return { status: "not_found" };
  if (r.code === 36 || /interaction is not allowed/i.test(r.stderr)) return { status: "locked" };
  return { status: "unavailable" };
}

export function osCopilotKeyring(): CopilotKeyring {
  return {
    available(): boolean {
      if (process.platform === "linux") return !!parseDbusUnixAddress(defaultDbusSessionAddress());
      if (process.platform === "darwin") return existsSync("/usr/bin/security");
      return false;
    },
    async read(login: string, signal?: AbortSignal): Promise<KeyringLookupResult> {
      const account = `https://github.com:${login}`;
      const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(KEYRING_TIMEOUT_MS)]) : AbortSignal.timeout(KEYRING_TIMEOUT_MS);
      if (process.platform === "linux") {
        const sockPath = parseDbusUnixAddress(defaultDbusSessionAddress());
        if (sockPath) {
          const r = await readFreedesktopSecret(SERVICE, account, sockPath, combined);
          if (r.status !== "unavailable") return r;
        }
        return readSecretTool(SERVICE, account, combined);
      }
      if (process.platform === "darwin") {
        return readMacosKeychain(SERVICE, account, combined);
      }
      return { status: "unavailable" };
    },
  };
}

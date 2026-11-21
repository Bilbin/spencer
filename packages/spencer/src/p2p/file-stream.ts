import * as fs from "node:fs";
import * as path from "node:path";

export const FILE_CHUNK_BYTES = 64 * 1024;
export const FILE_HIGH_WATER = 4 * 1024 * 1024;
export const FILE_LOW_WATER = 1024 * 1024;
export const FILE_STALL_TIMEOUT_MS = 30_000;
export const formatFileChannelLabel = (tid: string, attempt: number): string => `f:${tid}:${attempt}`;
export function parseFileChannelLabel(label: string): { tid: string; attempt: number } | null {
  const match = /^f:([A-Za-z0-9_-]{22}):([1-9]\d*)$/.exec(label);
  if (!match) return null;
  const attempt = Number(match[2]);
  return Number.isSafeInteger(attempt) && attempt >= 1 ? { tid: match[1]!, attempt } : null;
}
export interface FileDataChannel {
  isOpen(): boolean; bufferedAmount(): number; setBufferedAmountLowThreshold(size: number): void;
  sendMessage(msg: string): boolean; sendMessageBinary(buf: Buffer | Uint8Array): boolean;
  onOpen(cb: () => void): void; onClosed(cb: () => void): void; onError(cb: (err: string) => void): void;
  onBufferedAmountLow(cb: () => void): void; onMessage(cb: (msg: string | Buffer | ArrayBuffer) => void): void; close(): void;
}
type SendResult = { ok: boolean; killed?: boolean; error?: string };
type ReceiveResult = SendResult & { resumedFrom: number; oversize?: boolean };
const message = (e: unknown) => e instanceof Error ? e.message : String(e);

export function sendFileOverChannel(dc: FileDataChannel, opts: { filePath: string; size: number; onProgress?: (fraction: number) => void; stallTimeoutMs?: number }): { kill(): void; done: Promise<SendResult> } {
  let finish!: (result: SendResult) => void;
  let settled = false, ended = false, started = false;
  let timer: ReturnType<typeof setTimeout> | undefined, poll: ReturnType<typeof setInterval> | undefined;
  let fd: number | undefined;
  let wake: (() => void) | undefined;
  const done = new Promise<SendResult>(resolve => { finish = result => {
    if (settled) return; settled = true; clearTimeout(timer); clearInterval(poll);
    if (fd !== undefined) { fs.closeSync(fd); fd = undefined; }
    wake?.(); if (!result.ok) dc.close(); resolve(result);
  }; });
  const arm = () => { clearTimeout(timer); timer = setTimeout(() => finish({ ok: false, error: "file channel stalled" }), opts.stallTimeoutMs ?? FILE_STALL_TIMEOUT_MS); };
  dc.onClosed(() => finish(ended ? { ok: true } : { ok: false, error: "file channel closed" }));
  dc.onError(error => finish({ ok: false, error }));
  dc.onBufferedAmountLow(() => wake?.());
  dc.onMessage(msg => {
    if (started) { finish({ ok: false, error: "unexpected message on file channel" }); return; }
    started = true;
    let offset: unknown;
    try { if (typeof msg !== "string" || msg.length > 256) throw new Error(); const parsed: unknown = JSON.parse(msg); if (typeof parsed !== "object" || parsed === null || !("offset" in parsed)) throw new Error(); offset = parsed.offset; } catch { finish({ ok: false, error: "invalid offset" }); return; }
    if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0 || offset > opts.size) { finish({ ok: false, error: "invalid offset" }); return; }
    const start = offset;
    void (async () => {
      try {
        dc.setBufferedAmountLowThreshold(FILE_LOW_WATER);
        let sent = start;
        if (sent < opts.size) fd = fs.openSync(opts.filePath, "r");
        while (sent < opts.size && !settled) {
          if (dc.bufferedAmount() >= FILE_HIGH_WATER) {
            await new Promise<void>(resolve => { wake = resolve; if (dc.bufferedAmount() < FILE_HIGH_WATER || settled) resolve(); }); wake = undefined;
            if (settled) return;
          }
          const buf = Buffer.allocUnsafe(Math.min(FILE_CHUNK_BYTES, opts.size - sent));
          const n = fs.readSync(fd!, buf, 0, buf.length, sent);
          if (!n) throw new Error("source file truncated");
          dc.sendMessageBinary(buf.subarray(0, n));
          sent += n; opts.onProgress?.(sent / opts.size); arm();
        }
        if (settled) return;
        if (opts.size === start) opts.onProgress?.(1);
        ended = true;
        dc.sendMessage("end");
        if (settled) return;
        if (dc.bufferedAmount() === 0) finish({ ok: true });
        else { arm(); poll = setInterval(() => { if (dc.bufferedAmount() === 0) finish({ ok: true }); }, 10); }
      } catch (e) { finish({ ok: false, error: message(e) }); }
    })();
  });
  arm();
  return { kill: () => finish({ ok: false, killed: true }), done };
}

export function receiveFileOverChannel(dc: FileDataChannel, opts: { partPath: string; finalPath: string; expectedSize: number; onProgress?: (fraction: number) => void; stallTimeoutMs?: number }): { kill(): void; done: Promise<ReceiveResult> } {
  let offset = 0, received = 0, fd: number | undefined, settled = false, sentOffset = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let finish!: (result: ReceiveResult) => void;
  const done = new Promise<ReceiveResult>(resolve => { finish = result => {
    if (settled) return; settled = true; clearTimeout(timer);
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} fd = undefined; }
    dc.close(); resolve(result);
  }; });
  const fail = (error: string) => finish({ ok: false, resumedFrom: offset, error });
  const arm = () => { clearTimeout(timer); timer = setTimeout(() => fail("file channel stalled"), opts.stallTimeoutMs ?? FILE_STALL_TIMEOUT_MS); };
  const sendOffset = () => { if (settled || sentOffset) return; sentOffset = true; try { dc.sendMessage(JSON.stringify({ offset })); } catch (e) { fail(message(e)); } };
  try {
    fs.mkdirSync(path.dirname(opts.partPath), { recursive: true });
    try { const st = fs.statSync(opts.partPath); if (st.isFile() && st.size > opts.expectedSize) fs.unlinkSync(opts.partPath); else if (st.isFile() && st.size > 0) offset = st.size; } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    fd = fs.openSync(opts.partPath, offset ? "a" : "w", 0o600);
    dc.onClosed(() => fail("file channel closed")); dc.onError(fail); dc.onOpen(sendOffset);
    dc.onMessage(msg => {
      if (settled) return; arm();
      try {
        if (typeof msg === "string") {
          if (msg !== "end") { fail("unexpected text message on file channel"); return; }
          if (offset + received !== opts.expectedSize) { fail("truncated stream"); return; }
          fs.closeSync(fd!); fd = undefined; fs.renameSync(opts.partPath, opts.finalPath); fs.chmodSync(opts.finalPath, 0o600); opts.onProgress?.(1); finish({ ok: true, resumedFrom: offset }); return;
        }
        const chunk = msg instanceof ArrayBuffer ? Buffer.from(msg) : Buffer.from(msg);
        if (offset + received + chunk.length > opts.expectedSize) { fs.closeSync(fd!); fd = undefined; fs.unlinkSync(opts.partPath); finish({ ok: false, resumedFrom: offset, oversize: true, error: "sender sent more data than offered" }); return; }
        let written = 0; while (written < chunk.length) written += fs.writeSync(fd!, chunk, written, chunk.length - written);
        received += chunk.length; opts.onProgress?.((offset + received) / opts.expectedSize);
      } catch (e) { fail(message(e)); }
    });
    arm(); if (dc.isOpen()) sendOffset();
  } catch (e) { fail(message(e)); }
  return { kill: () => finish({ ok: false, killed: true, resumedFrom: offset }), done };
}

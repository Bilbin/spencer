import { sealEnvelope, type Body, type Envelope, type Identity } from "@spencer/protocol";
import type { Sql } from "../store/db.ts";
import type { MessageOrigin } from "../contracts.ts";
import { PERMANENT_SEND_ERRORS, RelayError, type RelayConnection } from "./relay-client.ts";

export interface ChannelKeyInfo {
  encKey: Uint8Array;
  relayUrl: string;
}

export interface OutboxDeps {
  sql: Sql;
  me: Identity;
  log: (m: string) => void;
  /** Key and relay of a locally known channel. */
  channelInfo(ch: string): ChannelKeyInfo | undefined;
  /** The (possibly not ready) connection for a relay, without starting one. */
  connection(relayUrl: string): RelayConnection | undefined;
  /** A chat row of ours changed (enqueued / sent / failed): emit it to the UI. */
  messageChanged(id: string): void;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  now?: () => number;
}

interface OutboxRow {
  id: string;
  ch: string;
  env: string;
  type: string;
  attempts: number;
  next_attempt_at: number;
}

export interface EnqueueOptions {
  idempotencyKey?: string;
  origin?: MessageOrigin;
}

/**
 * Durable send queue (PROTOCOL §5.1). Envelopes are sealed and signed at enqueue time and resent
 * byte-identical; the relay dedupes on env.id.
 */
export class Outbox {
  private d: OutboxDeps;
  private stopped = false;
  private running = new Map<string, Promise<void>>();
  private rerun = new Set<string>();
  private timers = new Map<string, NodeJS.Timeout>();
  private kickSet = new Set<string>();
  private kickScheduled: NodeJS.Immediate | undefined;
  private emitQueue: string[] = [];
  private minBackoff: number;
  private maxBackoff: number;
  private now: () => number;

  constructor(deps: OutboxDeps) {
    this.d = deps;
    this.minBackoff = deps.minBackoffMs ?? 1000;
    this.maxBackoff = deps.maxBackoffMs ?? 60_000;
    this.now = deps.now ?? Date.now;
  }

  /**
   * Synchronous: seals the envelope and inserts the outbox row (and, for chat, our `messages` row) in
   * one savepoint, so it can run inside the caller's transaction. With an idempotency key that was
   * used before, returns the earlier id and enqueues nothing.
   */
  enqueue(ch: string, body: Body, opts: EnqueueOptions = {}): { id: string; created: boolean } {
    const { sql } = this.d;
    const res = sql.tx(() => {
      if (opts.idempotencyKey !== undefined) {
        const ex = sql.get<{ id: string }>("SELECT id FROM outbox WHERE idempotency_key = ?", opts.idempotencyKey);
        if (ex) return { id: ex.id, created: false };
      }
      const info = this.d.channelInfo(ch);
      if (!info) throw new Error(`unknown channel ${ch}`);
      const now = this.now();
      const env = sealEnvelope(this.d.me, ch, info.encKey, body, { ts: now });
      sql.run(
        "INSERT INTO outbox (id, ch, env, type, idempotency_key, state, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)",
        env.id,
        ch,
        JSON.stringify(env),
        body.type,
        opts.idempotencyKey ?? null,
        now,
      );
      if (body.type === "chat") {
        sql.run(
          `INSERT INTO messages (id, ch, seq, from_id, ts, type, body, mine, status, origin, note, routed, created_at)
           VALUES (?, ?, NULL, ?, ?, 'chat', ?, 1, 'pending', ?, NULL, 1, ?)`,
          env.id,
          ch,
          this.d.me.id,
          env.ts,
          JSON.stringify(body),
          opts.origin ?? null,
          now,
        );
      }
      return { id: env.id, created: true };
    });
    if (res.created) {
      if (body.type === "chat") this.emitQueue.push(res.id);
      this.kick(ch);
    }
    return res;
  }

  /** Schedule a send pass for a channel (or every channel with pending rows) on the next tick. */
  kick(ch?: string): void {
    if (this.stopped) return;
    if (ch === undefined) {
      for (const r of this.d.sql.all<{ ch: string }>("SELECT DISTINCT ch FROM outbox WHERE state = 'pending'")) this.kickSet.add(r.ch);
    } else {
      this.kickSet.add(ch);
    }
    if (!this.kickScheduled) {
      this.kickScheduled = setImmediate(() => {
        this.kickScheduled = undefined;
        this.flushEmits();
        const chs = [...this.kickSet];
        this.kickSet.clear();
        for (const c of chs) this.startPump(c);
      });
    }
  }

  private flushEmits(): void {
    const ids = this.emitQueue;
    this.emitQueue = [];
    for (const id of ids) {
      // The caller's transaction may have rolled back; only emit rows that exist.
      if (this.d.sql.get("SELECT 1 FROM messages WHERE id = ?", id)) this.d.messageChanged(id);
    }
  }

  private startPump(ch: string): void {
    if (this.stopped) return;
    if (this.running.has(ch)) {
      this.rerun.add(ch);
      return;
    }
    const t = this.timers.get(ch);
    if (t) {
      clearTimeout(t);
      this.timers.delete(ch);
    }
    const p = this.pump(ch)
      .catch((e: Error) => this.d.log(`outbox ${ch}: ${e.message}`))
      .finally(() => {
        this.running.delete(ch);
        if (this.rerun.delete(ch)) this.startPump(ch);
      });
    this.running.set(ch, p);
  }

  private schedule(ch: string, at: number): void {
    if (this.stopped) return;
    const prev = this.timers.get(ch);
    if (prev) clearTimeout(prev);
    const t = setTimeout(
      () => {
        this.timers.delete(ch);
        this.startPump(ch);
      },
      Math.max(0, at - this.now()),
    );
    this.timers.set(ch, t);
  }

  private async pump(ch: string): Promise<void> {
    const { sql } = this.d;
    while (!this.stopped) {
      const row = sql.get<OutboxRow>(
        "SELECT id, ch, env, type, attempts, next_attempt_at FROM outbox WHERE ch = ? AND state = 'pending' ORDER BY rowid LIMIT 1",
        ch,
      );
      if (!row) return;
      if (row.next_attempt_at > this.now()) {
        this.schedule(ch, row.next_attempt_at);
        return;
      }
      const info = this.d.channelInfo(ch);
      if (!info) {
        this.fail(row, "channel no longer exists");
        continue;
      }
      const conn = this.d.connection(info.relayUrl);
      if (!conn?.ready) return; // kicked again when the relay connects
      const env = JSON.parse(row.env) as Envelope;
      let seq: number;
      try {
        const ok = await conn.request({ t: "send", env });
        seq = Number(ok.seq);
        if (!Number.isSafeInteger(seq)) throw new RelayError("bad_reply", "send reply without seq");
      } catch (e) {
        if (this.stopped) return;
        const code = e instanceof RelayError ? e.code : "error";
        if (PERMANENT_SEND_ERRORS.has(code)) {
          this.d.log(`outbox ${ch}: dropping ${row.type} ${row.id}: ${(e as Error).message}`);
          this.fail(row, (e as Error).message);
          continue;
        }
        if (code === "disconnected" || code === "closed") return; // re-kicked on reconnect
        const attempts = row.attempts + 1;
        const delay = Math.min(this.maxBackoff, this.minBackoff * 2 ** (attempts - 1));
        const at = this.now() + Math.round(delay * (0.75 + Math.random() * 0.5));
        sql.run("UPDATE outbox SET attempts = ?, next_attempt_at = ?, error = ? WHERE id = ?", attempts, at, (e as Error).message, row.id);
        this.d.log(`outbox ${ch}: send failed (${(e as Error).message}), retry in ${at - this.now()} ms`);
        this.schedule(ch, at);
        return;
      }
      const now = this.now();
      sql.tx(() => {
        sql.run("UPDATE outbox SET state = 'sent', seq = ?, sent_at = ?, error = NULL WHERE id = ?", seq, now, row.id);
        if (row.type === "chat") sql.run("UPDATE messages SET status = 'sent', seq = ? WHERE id = ? AND mine = 1", seq, row.id);
      });
      if (row.type === "chat") this.d.messageChanged(row.id);
    }
  }

  private fail(row: OutboxRow, error: string): void {
    const { sql } = this.d;
    sql.tx(() => {
      sql.run("UPDATE outbox SET state = 'failed', error = ? WHERE id = ?", error, row.id);
      if (row.type === "chat") sql.run("UPDATE messages SET status = 'failed', note = ? WHERE id = ? AND mine = 1", error, row.id);
    });
    if (row.type === "chat") this.d.messageChanged(row.id);
  }

  pendingCount(ch?: string): number {
    const r =
      ch === undefined
        ? this.d.sql.get<{ n: number }>("SELECT count(*) AS n FROM outbox WHERE state = 'pending'")
        : this.d.sql.get<{ n: number }>("SELECT count(*) AS n FROM outbox WHERE state = 'pending' AND ch = ?", ch);
    return r?.n ?? 0;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.kickScheduled) clearImmediate(this.kickScheduled);
    this.kickScheduled = undefined;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    await Promise.allSettled([...this.running.values()]);
  }
}

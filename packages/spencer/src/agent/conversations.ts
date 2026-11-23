/**
 * Conversations channels (PROTOCOL.md §7.5): my side of each one, persisted in core.db (`agent_conversations_state`).
 *
 *  - timer: when it goes off and no conversation is going on, my agent opens one (a random topic or the news). It is
 *    a random number of minutes in [min, max], and every Spencer re-draws it whenever a conversation starts, so they
 *    take turns opening instead of all speaking at once.
 *  - the conversation going on: its id (from the opening message's `chat.convo`), when it started, when its last
 *    message arrived, and how many messages I sent in it. Each agent may send at most `max`; nobody has to use them
 *    all. It is over when someone ends it (`[END]`, a `final` message) or nobody wrote for `IDLE_MS`.
 *  - an opening I am writing now (`opener`), so a restart finishes it and a conversation someone else opened in the
 *    meantime cancels it.
 *
 * Timers only go off within the configured hours (`hours`, e.g. 8:00–18:00 in America/Los_Angeles): a time drawn
 * outside them moves to the next start of the window (plus a random spread, so the agents still take turns).
 *
 * Timer: wall-clock based like follow-ups (see followups.ts): it wakes at most every `maxSleepMs` and compares with
 * `now()`, so a laptop that slept still opens the conversation when it wakes.
 */
import type { DatabaseSync } from "node:sqlite";

/** A conversation with no message for this long is over. */
export const IDLE_MS = 15 * 60_000;
/** Two conversations opened this close together (timers that went off at once) settle on the one with the smaller id. */
export const START_RACE_MS = 2 * 60_000;

export interface ConvoRow {
  ch: string;
  next_at: number;
  convo_id: string | null;
  started_at: number | null;
  last_at: number | null;
  used: number;
  opener: string | null;
  opener_sid: string | null;
  ended: number;
  /** The conversation going on is in heated mode. */
  heated: number;
  /** I opened it in heated mode, so I run its moderator. */
  moderating: number;
}

export interface ConversationHours {
  start: number;
  end: number;
  timeZone: string;
}

export interface ConversationStoreOptions {
  now?: () => number;
  /** Random number in [0, 1) (tests make it fixed). */
  random?: () => number;
  /** Timer bounds and message budget, read at each use (they come from the config). */
  limits: () => { minMinutes: number; maxMinutes: number; messages: number; hours?: ConversationHours };
  /** Called with the channels whose timer went off (not concurrently). */
  onDue: (rows: ConvoRow[]) => Promise<void>;
  log?: (m: string) => void;
  maxSleepMs?: number;
}

export class ConversationStore {
  private db: DatabaseSync;
  private o: ConversationStoreOptions;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private again = false;
  private stopped = true;

  constructor(db: DatabaseSync, opts: ConversationStoreOptions) {
    this.db = db;
    this.o = opts;
  }

  init(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS agent_conversations_state (
      ch TEXT PRIMARY KEY,
      next_at INTEGER NOT NULL,
      convo_id TEXT,
      started_at INTEGER,
      last_at INTEGER,
      used INTEGER NOT NULL DEFAULT 0,
      opener TEXT,
      opener_sid TEXT,
      ended INTEGER NOT NULL DEFAULT 0,
      heated INTEGER NOT NULL DEFAULT 0,
      moderating INTEGER NOT NULL DEFAULT 0
    )`);
    const cols = new Set((this.db.prepare("PRAGMA table_info(agent_conversations_state)").all() as { name: string }[]).map((c) => c.name));
    for (const c of ["ended", "heated", "moderating"]) {
      if (!cols.has(c)) this.db.exec(`ALTER TABLE agent_conversations_state ADD COLUMN ${c} INTEGER NOT NULL DEFAULT 0`);
    }
  }

  now(): number {
    return (this.o.now ?? Date.now)();
  }

  max(): number {
    return this.o.limits().messages;
  }

  /**
   * A fresh timer: now + a random number of minutes in [min, max]. Outside the hours, it moves to the next start of
   * the window plus a random number of minutes in [0, max].
   */
  draw(): number {
    const { minMinutes, maxMinutes, hours } = this.o.limits();
    const random = this.o.random ?? Math.random;
    const at = this.now() + Math.round((minMinutes + random() * Math.max(0, maxMinutes - minMinutes)) * 60_000);
    if (!hours || inHours(at, hours)) return at;
    return nextWindowStart(at, hours) + Math.round(random() * maxMinutes * 60_000);
  }

  /** Whether timers may open conversations now. */
  inHours(): boolean {
    const hours = this.o.limits().hours;
    return !hours || inHours(this.now(), hours);
  }

  get(ch: string): ConvoRow | undefined {
    return this.db.prepare("SELECT * FROM agent_conversations_state WHERE ch = ?").get(ch) as ConvoRow | undefined;
  }

  /** The channel's row, created with a fresh timer if it has none. */
  ensure(ch: string): ConvoRow {
    const row = this.get(ch);
    if (row) return row;
    this.db.prepare("INSERT OR IGNORE INTO agent_conversations_state (ch, next_at) VALUES (?, ?)").run(ch, this.draw());
    this.arm();
    return this.get(ch)!;
  }

  remove(ch: string): void {
    this.db.prepare("DELETE FROM agent_conversations_state WHERE ch = ?").run(ch);
  }

  channels(): string[] {
    return (this.db.prepare("SELECT ch FROM agent_conversations_state").all() as { ch: string }[]).map((r) => r.ch);
  }

  /** The conversation going on in `ch` (none when it was ended or nobody wrote for `IDLE_MS`). */
  active(ch: string): (ConvoRow & { convo_id: string; started_at: number; last_at: number }) | undefined {
    const row = this.get(ch);
    if (!row?.convo_id || row.ended || row.last_at === null || row.started_at === null) return undefined;
    if (this.now() - row.last_at >= IDLE_MS) return undefined;
    return row as ConvoRow & { convo_id: string; started_at: number; last_at: number };
  }

  /**
   * Whether a conversation `id` opened by someone now becomes the current one: yes when none is going on; when one
   * is, only if both started within `START_RACE_MS` (timers that went off at once) and `id` sorts first, so every
   * member settles on the same one. Otherwise it is ignored (a peer cannot reset my count by opening new ones).
   */
  accepts(ch: string, id: string): boolean {
    const cur = this.active(ch);
    if (!cur || cur.convo_id === id) return true;
    return this.now() - cur.started_at < START_RACE_MS && id < cur.convo_id;
  }

  /** Conversation `id` starts in `ch`: my count starts over, my timer is re-drawn and any opening I was writing is dropped. */
  begin(ch: string, id: string, opts: { used?: number; heated?: boolean; moderating?: boolean } = {}): void {
    this.ensure(ch);
    const t = this.now();
    this.db
      .prepare(
        `UPDATE agent_conversations_state SET convo_id = ?, started_at = ?, last_at = ?, used = ?, next_at = ?, opener = NULL, opener_sid = NULL,
         ended = 0, heated = ?, moderating = ? WHERE ch = ?`,
      )
      .run(id, t, t, opts.used ?? 0, this.draw(), opts.heated ? 1 : 0, opts.heated && opts.moderating ? 1 : 0, ch);
    this.arm();
  }

  /** A message of conversation `id` arrived or was sent: it is still going on. */
  touch(ch: string, id: string): void {
    this.db.prepare("UPDATE agent_conversations_state SET last_at = ? WHERE ch = ? AND convo_id = ?").run(this.now(), ch, id);
  }

  /** Conversation `id` was ended (a `final` message): it is no longer going on. */
  end(ch: string, id: string): void {
    this.db.prepare("UPDATE agent_conversations_state SET ended = 1, last_at = ? WHERE ch = ? AND convo_id = ?").run(this.now(), ch, id);
  }

  /** Whether `id` is the conversation that was just ended in `ch` (its late messages are ignored). */
  isEnded(ch: string, id: string): boolean {
    const row = this.get(ch);
    return !!row?.ended && row.convo_id === id;
  }

  /** I send one more message in conversation `id`. False when it is not the current one, it ended or my messages are used up. */
  spend(ch: string, id: string): boolean {
    const r = this.db
      .prepare("UPDATE agent_conversations_state SET used = used + 1, last_at = ? WHERE ch = ? AND convo_id = ? AND ended = 0 AND used < ?")
      .run(this.now(), ch, id, this.max());
    return Number(r.changes) > 0;
  }

  /** Messages I have left in the current conversation (0 when none is going on). */
  left(ch: string): number {
    const a = this.active(ch);
    return a ? Math.max(0, this.max() - a.used) : 0;
  }

  /** Re-draw the timer (it went off while a conversation was going on, or it could not open one). */
  rearm(ch: string): void {
    this.db.prepare("UPDATE agent_conversations_state SET next_at = ? WHERE ch = ?").run(this.draw(), ch);
    this.arm();
  }

  /** Make the timer go off now (the owner pressed "Start now"). */
  dueNow(ch: string): void {
    this.ensure(ch);
    this.db.prepare("UPDATE agent_conversations_state SET next_at = ? WHERE ch = ?").run(this.now(), ch);
  }

  /** I start writing the opening message of conversation `id`, in heated mode or not (false if I already am). */
  startOpener(ch: string, id: string, heated = false): boolean {
    const r = this.db
      .prepare("UPDATE agent_conversations_state SET opener = ?, opener_sid = NULL, heated = ? WHERE ch = ? AND opener IS NULL")
      .run(id, heated ? 1 : 0, ch);
    return Number(r.changes) > 0;
  }

  setOpenerSubmission(ch: string, id: string, sid: string): void {
    this.db.prepare("UPDATE agent_conversations_state SET opener_sid = ? WHERE ch = ? AND opener = ?").run(sid, ch, id);
  }

  /** The opening `id` is finished, or dropped. */
  endOpener(ch: string, id: string): void {
    this.db.prepare("UPDATE agent_conversations_state SET opener = NULL, opener_sid = NULL WHERE ch = ? AND opener = ?").run(ch, id);
  }

  /** Openings a previous process left unfinished. */
  openers(): ConvoRow[] {
    return this.db.prepare("SELECT * FROM agent_conversations_state WHERE opener IS NOT NULL").all() as unknown as ConvoRow[];
  }

  // ---------------------------------------------------------------- timer

  start(): void {
    this.stopped = false;
    this.arm();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    await this.running?.catch(() => {});
  }

  arm(): void {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    const next = this.db.prepare("SELECT min(next_at) AS at FROM agent_conversations_state").get() as { at: number | null };
    if (next.at === null) return;
    const delay = Math.max(0, Math.min(next.at - this.now(), this.o.maxSleepMs ?? 15_000));
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.tick();
    }, delay);
    this.timer.unref?.();
  }

  /** Handle every timer that went off (also called by tests). */
  tick(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.again = false;
        const due = this.db
          .prepare("SELECT * FROM agent_conversations_state WHERE next_at <= ? ORDER BY next_at")
          .all(this.now()) as unknown as ConvoRow[];
        if (due.length && !this.stopped) {
          // Re-drawn first: whatever the handler does, a timer goes off once.
          for (const row of due) this.db.prepare("UPDATE agent_conversations_state SET next_at = ? WHERE ch = ?").run(this.draw(), row.ch);
          try {
            await this.o.onDue(due);
          } catch (e) {
            this.o.log?.(`conversations: ${(e as Error).message}`);
          }
        }
      } while (this.again && !this.stopped);
    })().finally(() => {
      this.running = undefined;
      this.arm();
    });
    return this.running;
  }
}

// ---------------------------------------------------------------- hours

/** Minutes since local midnight at `t` in `timeZone`. */
function localMinutes(t: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "numeric", hourCycle: "h23" }).formatToParts(t);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return (get("hour") % 24) * 60 + get("minute");
}

export function inHours(t: number, h: ConversationHours): boolean {
  const m = localMinutes(t, h.timeZone);
  return m >= h.start * 60 && m < h.end * 60;
}

/** The next time after `t` the window opens (`start`:00 local time). */
export function nextWindowStart(t: number, h: ConversationHours): number {
  const base = Math.floor(t / 60_000) * 60_000;
  let at = base + (((h.start * 60 - localMinutes(base, h.timeZone)) % 1440) + 1440) % 1440 * 60_000;
  if (at <= t) at += 1440 * 60_000;
  // Across a DST change the local clock moved an hour: correct by the difference.
  let diff = h.start * 60 - localMinutes(at, h.timeZone);
  if (diff > 720) diff -= 1440;
  if (diff < -720) diff += 1440;
  return at + diff * 60_000;
}

/**
 * The per-channel turn budget of the loop guard (PROTOCOL.md §7.2), persisted in core.db so a restart does not refill
 * it. Two parts, both counted by this Spencer alone (peers cannot spend or refill them):
 *
 *  - streak: automatic turns my agent took in the channel since a person last wrote there. It resets when my owner
 *    types in the channel, or when a peer's message is marked `by: "human"`. Messages my owner's Spencer sends
 *    (`send_message`) do NOT reset it: they are agent turns too, and resetting on them would let an owner agent that
 *    wakes on replies loop forever.
 *  - rate: automatic turns per minute, hour and day (sliding windows). Only my owner refills it: by typing in the
 *    channel, or by approving a "continue?" card.
 *
 * `check` says what happens to the next automatic turn: go ahead, skip it (per-minute burst), or pause the channel
 * and ask the owner (streak, hourly or daily budget used up).
 */
import type { DatabaseSync } from "node:sqlite";

export interface BudgetLimits {
  /** Max automatic turns since a person wrote; 0 = no limit. */
  maxTurns: number;
  perMinute: number;
  perHour: number;
  perDay: number;
}

export type BudgetVerdict = { ok: true } | { ok: false; why: "rate limited" | "budget exhausted"; detail: string };

export interface BudgetUsage {
  streak: number;
  lastMinute: number;
  lastHour: number;
  lastDay: number;
}

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

export class TurnBudget {
  private db: DatabaseSync;
  private now: () => number;
  private lastPrune = 0;

  constructor(db: DatabaseSync, now: () => number = Date.now) {
    this.db = db;
    this.now = now;
  }

  init(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS agent_turns (ch TEXT NOT NULL, at INTEGER NOT NULL)`);
    this.db.exec("CREATE INDEX IF NOT EXISTS agent_turns_ch_at ON agent_turns (ch, at)");
    this.db.exec(`CREATE TABLE IF NOT EXISTS agent_channel_budget (
      ch TEXT PRIMARY KEY,
      streak INTEGER NOT NULL DEFAULT 0,
      rate_reset_at INTEGER NOT NULL DEFAULT 0,
      human_at INTEGER
    )`);
  }

  private row(ch: string): { streak: number; rate_reset_at: number } {
    return (
      (this.db.prepare("SELECT streak, rate_reset_at FROM agent_channel_budget WHERE ch = ?").get(ch) as
        | { streak: number; rate_reset_at: number }
        | undefined) ?? { streak: 0, rate_reset_at: 0 }
    );
  }

  usage(ch: string): BudgetUsage {
    const t = this.now();
    const r = this.row(ch);
    const since = (window: number) =>
      (
        this.db.prepare("SELECT count(*) AS n FROM agent_turns WHERE ch = ? AND at > ? AND at > ?").get(ch, t - window, r.rate_reset_at) as {
          n: number;
        }
      ).n;
    return { streak: r.streak, lastMinute: since(MINUTE), lastHour: since(HOUR), lastDay: since(DAY) };
  }

  check(ch: string, limits: BudgetLimits): BudgetVerdict {
    const u = this.usage(ch);
    if (limits.maxTurns > 0 && u.streak >= limits.maxTurns) {
      return { ok: false, why: "budget exhausted", detail: `${u.streak} automatic replies in a row without a person writing` };
    }
    if (u.lastDay >= limits.perDay) return { ok: false, why: "budget exhausted", detail: `${u.lastDay} automatic replies today` };
    if (u.lastHour >= limits.perHour) return { ok: false, why: "budget exhausted", detail: `${u.lastHour} automatic replies in the last hour` };
    if (u.lastMinute >= limits.perMinute) return { ok: false, why: "rate limited", detail: `${u.lastMinute} automatic replies in the last minute` };
    return { ok: true };
  }

  /**
   * Spend one automatic turn in `ch`. `streak: false` counts it in the rate windows only (Conversations: those turns
   * have their own per-conversation message cap, so they do not pause the channel for "no person wrote").
   */
  record(ch: string, opts: { streak?: boolean } = {}): void {
    const t = this.now();
    this.db.prepare("INSERT INTO agent_turns (ch, at) VALUES (?, ?)").run(ch, t);
    if (opts.streak !== false) {
      this.db
        .prepare("INSERT INTO agent_channel_budget (ch, streak) VALUES (?, 1) ON CONFLICT (ch) DO UPDATE SET streak = streak + 1")
        .run(ch);
    }
    if (t - this.lastPrune > HOUR) {
      this.lastPrune = t;
      this.db.prepare("DELETE FROM agent_turns WHERE at < ?").run(t - DAY);
    }
  }

  /** A person wrote in `ch` (a peer message marked human): the streak starts over. */
  humanSpoke(ch: string): void {
    this.db
      .prepare("INSERT INTO agent_channel_budget (ch, streak, human_at) VALUES (?, 0, ?) ON CONFLICT (ch) DO UPDATE SET streak = 0, human_at = excluded.human_at")
      .run(ch, this.now());
  }

  /** My owner wrote in `ch`, or let the conversation continue: streak and rate windows start over. */
  ownerReset(ch: string): void {
    const t = this.now();
    this.db
      .prepare(
        `INSERT INTO agent_channel_budget (ch, streak, rate_reset_at, human_at) VALUES (?, 0, ?, ?)
         ON CONFLICT (ch) DO UPDATE SET streak = 0, rate_reset_at = excluded.rate_reset_at, human_at = excluded.human_at`,
      )
      .run(ch, t, t);
  }
}

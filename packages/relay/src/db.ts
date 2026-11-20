import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { ChannelKind, MemberInfo } from "@spencer/protocol";

export interface ChannelRow {
  ch: string;
  kind: ChannelKind;
  maxMembers: number;
  capPub: string;
  meta: string;
  createdAt: number;
  head: number;
  /** Highest seq ever deleted by TTL expiry (0 = none). */
  expiredThrough: number;
}

export interface MemberRow {
  id: string;
  joinedAt: number;
  /** Channel head when this member joined; older messages are not delivered to it. */
  joinSeq: number;
  cursor: number;
}

export interface StoredMessage {
  seq: number;
  env: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS channels (
  ch TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  max_members INTEGER NOT NULL,
  cap_pub TEXT NOT NULL,
  meta TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  head INTEGER NOT NULL DEFAULT 0,
  expired_through INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS members (
  ch TEXT NOT NULL,
  id TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  join_seq INTEGER NOT NULL,
  cursor INTEGER NOT NULL,
  PRIMARY KEY (ch, id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS members_by_id ON members(id);
CREATE TABLE IF NOT EXISTS messages (
  ch TEXT NOT NULL,
  seq INTEGER NOT NULL,
  sender TEXT NOT NULL,
  at INTEGER NOT NULL,
  env TEXT NOT NULL,
  PRIMARY KEY (ch, seq)
);
CREATE INDEX IF NOT EXISTS messages_at ON messages(at);
CREATE TABLE IF NOT EXISTS seen (
  ch TEXT NOT NULL,
  id TEXT NOT NULL,
  sender TEXT NOT NULL,
  seq INTEGER NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (ch, id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS seen_at ON seen(at);
CREATE TABLE IF NOT EXISTS presence (
  id TEXT PRIMARY KEY,
  last_seen INTEGER NOT NULL
) WITHOUT ROWID;
`;

type Row = Record<string, unknown>;

/** Thin synchronous storage layer for the relay. All methods are synchronous (node:sqlite). */
export class RelayDb {
  readonly db: DatabaseSync;
  private s: Record<string, StatementSync>;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec("PRAGMA busy_timeout = 2000");
    this.db.exec("PRAGMA cache_size = -8000"); // ~8 MB page cache, keep it lean
    this.db.exec(SCHEMA);
    const p = (sql: string) => this.db.prepare(sql);
    this.s = {
      getChannel: p(
        "SELECT ch, kind, max_members AS maxMembers, cap_pub AS capPub, meta, created_at AS createdAt, head, expired_through AS expiredThrough FROM channels WHERE ch = ?",
      ),
      insertChannel: p(
        "INSERT INTO channels (ch, kind, max_members, cap_pub, meta, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ),
      deleteChannel: p("DELETE FROM channels WHERE ch = ?"),
      bumpHead: p("UPDATE channels SET head = head + 1 WHERE ch = ? RETURNING head"),
      getMember: p("SELECT id, joined_at AS joinedAt, join_seq AS joinSeq, cursor FROM members WHERE ch = ? AND id = ?"),
      listMembers: p("SELECT id, joined_at AS joinedAt FROM members WHERE ch = ? ORDER BY joined_at, id"),
      countMembers: p("SELECT COUNT(*) AS n FROM members WHERE ch = ?"),
      countMemberships: p("SELECT COUNT(*) AS n FROM members WHERE id = ?"),
      anyMembership: p("SELECT 1 AS x FROM members WHERE id = ? LIMIT 1"),
      insertMember: p("INSERT INTO members (ch, id, joined_at, join_seq, cursor) VALUES (?, ?, ?, ?, ?)"),
      deleteMember: p("DELETE FROM members WHERE ch = ? AND id = ?"),
      deleteMembersOf: p("DELETE FROM members WHERE ch = ?"),
      ack: p(
        "UPDATE members SET cursor = min(?, (SELECT head FROM channels WHERE ch = members.ch)) WHERE ch = ? AND id = ? AND cursor < min(?, (SELECT head FROM channels WHERE ch = members.ch))",
      ),
      lowestCursors: p("SELECT id, cursor FROM members WHERE ch = ? ORDER BY cursor ASC LIMIT 2"),
      gcUpTo: p("DELETE FROM messages WHERE ch = ? AND seq <= ?"),
      gcSenderUpTo: p("DELETE FROM messages WHERE ch = ? AND seq <= ? AND sender = ?"),
      gcSender: p("DELETE FROM messages WHERE ch = ? AND sender = ?"),
      getSeen: p("SELECT sender, seq FROM seen WHERE ch = ? AND id = ?"),
      insertSeen: p("INSERT INTO seen (ch, id, sender, seq, at) VALUES (?, ?, ?, ?, ?)"),
      deleteSeenOf: p("DELETE FROM seen WHERE ch = ?"),
      pruneSeen: p("DELETE FROM seen WHERE at < ?"),
      countMessages: p("SELECT COUNT(*) AS n FROM messages WHERE ch = ?"),
      insertMessage: p("INSERT INTO messages (ch, seq, sender, at, env) VALUES (?, ?, ?, ?, ?)"),
      deleteMessagesOf: p("DELETE FROM messages WHERE ch = ?"),
      backlog: p("SELECT seq, env FROM messages WHERE ch = ? AND seq > ? AND sender <> ? ORDER BY seq LIMIT ?"),
      anyExpired: p("SELECT 1 AS x FROM messages WHERE at < ? LIMIT 1"),
      markExpired: p(
        "UPDATE channels SET expired_through = max(expired_through, (SELECT max(seq) FROM messages m WHERE m.ch = channels.ch AND m.at < ?1)) WHERE ch IN (SELECT DISTINCT ch FROM messages WHERE at < ?1)",
      ),
      deleteExpired: p("DELETE FROM messages WHERE at < ?"),
      channelsOf: p("SELECT ch FROM members WHERE id = ?"),
      getLastSeen: p("SELECT last_seen AS lastSeen FROM presence WHERE id = ?"),
      setLastSeen: p("INSERT INTO presence (id, last_seen) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET last_seen = excluded.last_seen"),
    };
  }

  tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  getChannel(ch: string): ChannelRow | undefined {
    return this.s.getChannel.get(ch) as unknown as ChannelRow | undefined;
  }

  /** Creates the channel and adds the creator as its first member. */
  createChannel(c: Omit<ChannelRow, "head" | "expiredThrough">, creator: string): void {
    this.tx(() => {
      this.s.insertChannel.run(c.ch, c.kind, c.maxMembers, c.capPub, c.meta, c.createdAt);
      this.s.insertMember.run(c.ch, creator, c.createdAt, 0, 0);
    });
  }

  getMember(ch: string, id: string): MemberRow | undefined {
    return this.s.getMember.get(ch, id) as unknown as MemberRow | undefined;
  }

  members(ch: string): MemberInfo[] {
    return this.s.listMembers.all(ch) as unknown as MemberInfo[];
  }

  memberCount(ch: string): number {
    return (this.s.countMembers.get(ch) as Row).n as number;
  }

  membershipCount(id: string): number {
    return (this.s.countMemberships.get(id) as Row).n as number;
  }

  hasAnyMembership(id: string): boolean {
    return this.s.anyMembership.get(id) !== undefined;
  }

  /** Adds a member whose cursor (and history start) is the current head. */
  addMember(ch: string, id: string, now: number, head: number): void {
    this.s.insertMember.run(ch, id, now, head, head);
  }

  /** Removes a member. Deletes the channel and all its data when the last member leaves. */
  removeMember(ch: string, id: string): { remaining: number } {
    return this.tx(() => {
      this.s.deleteMember.run(ch, id);
      const remaining = this.memberCount(ch);
      if (remaining === 0) {
        this.s.deleteMessagesOf.run(ch);
        this.s.deleteSeenOf.run(ch);
        this.s.deleteChannel.run(ch);
      } else {
        this.gcChannel(ch);
      }
      return { remaining };
    });
  }

  getSeen(ch: string, id: string): { sender: string; seq: number } | undefined {
    return this.s.getSeen.get(ch, id) as unknown as { sender: string; seq: number } | undefined;
  }

  messageCount(ch: string): number {
    return (this.s.countMessages.get(ch) as Row).n as number;
  }

  /** Assigns the next seq and stores the message plus its dedupe record, atomically. */
  appendMessage(ch: string, id: string, sender: string, at: number, env: string): number {
    return this.tx(() => {
      const seq = (this.s.bumpHead.get(ch) as Row).head as number;
      this.s.insertMessage.run(ch, seq, sender, at, env);
      this.s.insertSeen.run(ch, id, sender, seq, at);
      return seq;
    });
  }

  backlog(ch: string, afterSeq: number, exclude: string, limit: number): StoredMessage[] {
    return this.s.backlog.all(ch, afterSeq, exclude, limit) as unknown as StoredMessage[];
  }

  /** Cumulative ack, clamped to the channel head. Returns true if the cursor advanced. */
  ack(ch: string, id: string, seq: number): boolean {
    return Number(this.s.ack.run(seq, ch, id, seq).changes) > 0;
  }

  /**
   * Deletes messages every current member has acked. The sender of a message counts as having
   * acked it. With cursors sorted c1 <= c2 <= ...: seq <= c1 is acked by everyone; a message in
   * (c1, c2] is deletable only if its sender is the single member sitting at c1; anything above c2
   * is still missing for at least one non-sender.
   */
  gcChannel(ch: string): number {
    const rows = this.s.lowestCursors.all(ch) as unknown as { id: string; cursor: number }[];
    if (rows.length === 0) return 0;
    let n = Number(this.s.gcUpTo.run(ch, rows[0].cursor).changes);
    if (rows.length === 1) n += Number(this.s.gcSender.run(ch, rows[0].id).changes);
    else if (rows[1].cursor > rows[0].cursor) n += Number(this.s.gcSenderUpTo.run(ch, rows[1].cursor, rows[0].id).changes);
    return n;
  }

  /** Deletes messages stored before `cutoff` and records the expiry per channel. Cheap when nothing expired. */
  expire(cutoff: number): number {
    if (this.s.anyExpired.get(cutoff) === undefined) return 0;
    return this.tx(() => {
      this.s.markExpired.run(cutoff);
      return Number(this.s.deleteExpired.run(cutoff).changes);
    });
  }

  /** Channels `id` is a member of. */
  channelsOf(id: string): string[] {
    return (this.s.channelsOf.all(id) as unknown as { ch: string }[]).map((r) => r.ch);
  }

  /** When the relay last saw `id` connected (updated on connect and on disconnect). */
  lastSeen(id: string): number | undefined {
    return (this.s.getLastSeen.get(id) as { lastSeen: number } | undefined)?.lastSeen;
  }

  setLastSeen(id: string, at: number): void {
    this.s.setLastSeen.run(id, at);
  }

  pruneSeen(cutoff: number): number {
    return Number(this.s.pruneSeen.run(cutoff).changes);
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }
}

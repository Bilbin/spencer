/**
 * Reply policy for incoming peer chats (PROTOCOL.md §7.2). Pure: no I/O, injectable clock.
 *
 * Addressing rule in groups (documented contract):
 *   A group message addresses me when
 *     1. its `mentions` list contains my identity id, or
 *     2. its text contains `@<handle>` for one of my handles, case-insensitively, where the handles are
 *          - my full name                    ("Alice's Spencer")
 *          - my name without "'s Spencer"    ("Alice")   / without a trailing "Spencer"
 *          - the first word of my name       ("Alice")
 *        Matching ignores case and treats spaces, apostrophes, dots, dashes and underscores inside the
 *        name as optional, so `@Alice's Spencer`, `@alices-spencer`, `@AlicesSpencer` and `@alice` all
 *        match "Alice's Spencer". The handle must end at a word boundary (`@alicex` does not match).
 *   Exception (loop damping): an agent-written message (`by: "agent"`) that carries an explicit,
 *   non-empty `mentions` list is addressed only through that list. Automatic replies always mention
 *   the asker explicitly, so a reply to someone else that merely quotes my name does not wake me.
 */

export type ReplyNote = "auto-reply off" | "hop cap" | "not addressed" | "rate limited";

export interface ReplyInput {
  channelKind: "direct" | "group";
  autoReply: boolean;
  hop: number;
  maxHops: number;
  mentions?: string[];
  text: string;
  myId: string;
  myName: string;
  /** Who wrote the message; see the loop-damping exception above. */
  by?: "human" | "agent";
}

export type ReplyDecision = { reply: true } | { reply: false; note: Exclude<ReplyNote, "rate limited"> };

export function decideReply(input: ReplyInput): ReplyDecision {
  if (!input.autoReply) return { reply: false, note: "auto-reply off" };
  if (!(input.hop < input.maxHops)) return { reply: false, note: "hop cap" };
  if (input.channelKind === "group" && !isAddressed(input)) return { reply: false, note: "not addressed" };
  return { reply: true };
}

export function isAddressed(input: Pick<ReplyInput, "mentions" | "text" | "myId" | "myName" | "by">): boolean {
  const mentions = input.mentions ?? [];
  if (mentions.includes(input.myId)) return true;
  if (input.by === "agent" && mentions.length > 0) return false;
  return textMentions(input.text, input.myName);
}

const ALNUM = /[\p{L}\p{N}]/u;
const NAME_SEPARATOR = /[\s'’._-]/u;

/** Normalized handles (lowercase letters/digits only) that address `name`. */
export function nameHandles(name: string): string[] {
  const norm = (s: string) => [...s.toLowerCase()].filter((c) => ALNUM.test(c)).join("");
  const handles = new Set<string>();
  const add = (s: string) => {
    const n = norm(s);
    if (n.length >= 2) handles.add(n);
  };
  const trimmed = name.trim();
  add(trimmed);
  const owner = trimmed.replace(/(?:['’]s)?\s*spencer\s*$/iu, "").trim();
  if (owner) add(owner);
  const first = trimmed.split(/\s+/u)[0] ?? "";
  add(first.replace(/['’]s$/iu, ""));
  return [...handles];
}

/** Whether `text` contains `@<handle>` for one of the handles of `name` (see the rule above). */
export function textMentions(text: string, name: string): boolean {
  const handles = nameHandles(name);
  if (handles.length === 0) return false;
  for (let i = text.indexOf("@"); i !== -1; i = text.indexOf("@", i + 1)) {
    for (const h of handles) if (matchesAt(text, i + 1, h)) return true;
  }
  return false;
}

function matchesAt(text: string, start: number, handle: string): boolean {
  const chars = [...text.slice(start, start + handle.length * 3 + 8)];
  let j = 0;
  let k = 0;
  while (j < handle.length && k < chars.length) {
    const c = chars[k]!.toLowerCase();
    if (ALNUM.test(c)) {
      if (c !== handle[j]) return false;
      j++;
      k++;
    } else if (j > 0 && NAME_SEPARATOR.test(c)) {
      k++;
    } else {
      return false;
    }
  }
  if (j < handle.length) return false;
  // Word boundary: the handle must not continue with another letter or digit.
  const next = chars[k];
  return next === undefined || !ALNUM.test(next);
}

// ------------------------------------------------------------------ rate limiting

export interface RateLimits {
  perMinute: number;
  perHour: number;
}

/**
 * Per-channel sliding windows (one minute, one hour). `tryAcquire` records a hit only when both windows
 * have room. In memory: a restart starts with empty windows.
 */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  private limits: () => RateLimits;
  private now: () => number;

  constructor(limits: RateLimits | (() => RateLimits), now: () => number = Date.now) {
    this.limits = typeof limits === "function" ? limits : () => limits;
    this.now = now;
  }

  /** Whether a reply in `ch` is allowed now (does not record). */
  check(ch: string): boolean {
    const { perMinute, perHour } = this.limits();
    const t = this.now();
    const list = this.prune(ch, t);
    const lastMinute = list.filter((x) => x > t - 60_000).length;
    return lastMinute < perMinute && list.length < perHour;
  }

  /** Record a reply in `ch` unconditionally. */
  record(ch: string): void {
    const t = this.now();
    const list = this.prune(ch, t);
    list.push(t);
    this.hits.set(ch, list);
  }

  /** Check and, when allowed, record. */
  tryAcquire(ch: string): boolean {
    if (!this.check(ch)) return false;
    this.record(ch);
    return true;
  }

  private prune(ch: string, t: number): number[] {
    const list = (this.hits.get(ch) ?? []).filter((x) => x > t - 3_600_000);
    if (list.length) this.hits.set(ch, list);
    else this.hits.delete(ch);
    return list;
  }
}

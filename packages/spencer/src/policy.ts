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

export type ReplyNote =
  | "auto-reply off"
  | "conversation ended"
  | "hop cap"
  | "not addressed"
  | "rate limited"
  | "budget exhausted"
  | "repeated"
  | "handled by owner"
  | "out of messages"
  | "not in this conversation";

export interface ReplyInput {
  channelKind: "direct" | "group";
  autoReply: boolean;
  hop: number;
  /** Hop cap for this channel's trust level (see `loopLimits`); 0 = no cap. */
  maxHops: number;
  /** The sender marked its message as the end of the exchange (`chat.final`). Ignored on human messages. */
  final?: boolean;
  mentions?: string[];
  text: string;
  myId: string;
  myName: string;
  /** Who wrote the message; see the loop-damping exception above. */
  by?: "human" | "agent";
}

export type ReplyDecision = { reply: true } | { reply: false; note: "auto-reply off" | "conversation ended" | "hop cap" | "not addressed" };

export function decideReply(input: ReplyInput): ReplyDecision {
  if (!input.autoReply) return { reply: false, note: "auto-reply off" };
  if (input.final && input.by === "agent") return { reply: false, note: "conversation ended" };
  if (input.maxHops > 0 && !(input.hop < input.maxHops)) return { reply: false, note: "hop cap" };
  if (input.channelKind === "group" && !isAddressed(input)) return { reply: false, note: "not addressed" };
  return { reply: true };
}

/**
 * Conversations channels (PROTOCOL.md §7.5): an agent message of the running conversation (`chat.convo.id`) gets an
 * answer from every member that still has messages left, without a mention and without the hop cap (the message
 * count is the cap). `final` (`[END]`) from an agent ends it. Other messages follow `decideReply`.
 */
export function decideConversationReply(input: {
  autoReply: boolean;
  by?: "human" | "agent";
  final?: boolean;
  /** The message's conversation id, and the one this Spencer is in (if any). */
  convoId: string;
  activeId: string | undefined;
  /** My messages left in the active conversation. */
  left: number;
}): { reply: true } | { reply: false; note: "auto-reply off" | "conversation ended" | "out of messages" | "not in this conversation" } {
  if (!input.autoReply) return { reply: false, note: "auto-reply off" };
  if (input.final && input.by === "agent") return { reply: false, note: "conversation ended" };
  if (input.activeId === undefined || input.convoId !== input.activeId) return { reply: false, note: "not in this conversation" };
  if (input.left <= 0) return { reply: false, note: "out of messages" };
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

// ------------------------------------------------------------------ loop guard

/**
 * The loop guard for automatic replies in a channel (PROTOCOL.md §7.2), by trust level:
 *
 *  1. End signal: an agent message with `final: true` ("[END]" from the model) gets no automatic answer, and
 *     NO_REPLY sends nothing at all. Well-behaved agents stop on their own instead of trading acknowledgements.
 *     Agent turns that repeat one of the last few (`isRepeat`) are dropped on both sides: a near-duplicate agent message
 *     from a peer gets no answer, and an answer of mine to an agent message that repeats what I just said is not sent.
 *  2. Turn budget (local and persistent, see agent/budget.ts): automatic replies since a person last wrote in the
 *     channel, plus per-minute / hour / day windows. When it runs out the channel pauses and the owner is asked
 *     whether to continue, instead of the conversation silently stopping.
 *  3. Hop cap (cooperative backstop): every automatic reply carries `incoming.hop + 1`, and a human message starts
 *     again at 0. Peers report the hop themselves, so it only stops honest Spencers (old ones stop at 4).
 */
export interface LoopLimits {
  maxHops: number;
  maxTurns: number;
  perMinute: number;
  perHour: number;
  perDay: number;
}

export interface LoopPolicy {
  maxHops: number;
  maxHopsFullTrust: number;
  maxAgentTurns: number;
  maxAgentTurnsFullTrust: number;
  repliesPerMinute: number;
  repliesPerHour: number;
  repliesPerDay: number;
  repliesPerMinuteFullTrust: number;
  repliesPerHourFullTrust: number;
  repliesPerDayFullTrust: number;
}

export function loopLimits(policy: LoopPolicy, trust: "standard" | "full" | undefined): LoopLimits {
  return trust === "full"
    ? {
        maxHops: policy.maxHopsFullTrust,
        maxTurns: policy.maxAgentTurnsFullTrust,
        perMinute: policy.repliesPerMinuteFullTrust,
        perHour: policy.repliesPerHourFullTrust,
        perDay: policy.repliesPerDayFullTrust,
      }
    : {
        maxHops: policy.maxHops,
        maxTurns: policy.maxAgentTurns,
        perMinute: policy.repliesPerMinute,
        perHour: policy.repliesPerHour,
        perDay: policy.repliesPerDay,
      };
}

/** The marker a channel model appends to say "this ends the exchange, no answer needed". */
export const END_MARKER = "[END]";
const END_RE = /\s*\[END\]\s*$/i;

/**
 * What to send for a model answer: nothing for an empty answer or `NO_REPLY`; otherwise the text, with a trailing
 * `[END]` (on its own line or at the end of the last line) removed and turned into `final: true`.
 */
export function parseAgentAnswer(raw: string): { send: false } | { send: true; text: string; final: boolean } {
  let text = raw.trim();
  if (!text || text === "NO_REPLY") return { send: false };
  let final = false;
  if (END_RE.test(text)) {
    final = true;
    text = text.replace(END_RE, "").trim();
  }
  if (!text || text === "NO_REPLY") return { send: false };
  return { send: true, text, final };
}

// ------------------------------------------------------------------ repeated turns

/** How many recent agent messages of the same sender a new one is compared with. */
export const REPEAT_WINDOW = 3;

function normalize(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Word k-grams with their counts (a multiset, so text that repeats a phrase is not mistaken for its shorter self). */
function shingles(words: string[], k: number): Map<string, number> {
  const out = new Map<string, number>();
  const add = (g: string) => out.set(g, (out.get(g) ?? 0) + 1);
  if (words.length < k) add(words.join(" "));
  else for (let i = 0; i + k <= words.length; i++) add(words.slice(i, i + k).join(" "));
  return out;
}

/**
 * Whether `text` repeats one of `previous` (the same sender's last few agent messages): the same words once case,
 * punctuation and spacing are ignored, or, for texts of 8+ words, word-trigram overlap of at least 0.85 (Jaccard over
 * trigram counts).
 * Short different acknowledgements ("Thanks!" / "Thank you!") are not repeats; the end signal handles those.
 */
export function isRepeat(text: string, previous: string[]): boolean {
  const a = normalize(text);
  if (!a) return false;
  const aw = a.split(" ");
  for (const p of previous) {
    const b = normalize(p);
    if (a === b) return true;
    const bw = b.split(" ");
    if (aw.length < 8 || bw.length < 8) continue;
    const x = shingles(aw, 3);
    const y = shingles(bw, 3);
    let inter = 0;
    for (const [g, n] of x) inter += Math.min(n, y.get(g) ?? 0);
    const union = aw.length - 2 + (bw.length - 2) - inter;
    if (inter / union >= 0.85) return true;
  }
  return false;
}

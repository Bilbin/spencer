/**
 * A deterministic fake LLM for tests and offline demos: a pi-ai faux response factory that looks at the
 * request context (tools offered, last message) and answers by fixed rules.
 *
 * Channel conversations (recognized by the `notify_owner` tool being offered):
 *   - `Echo from <myName>: <last peer message text>`
 *   - text containing `NO_REPLY_TEST` → `NO_REPLY`
 *   - `please send file <path>` → tool call `propose_file_send`, then `Asked my owner to approve sending <path>`
 * Owner conversation:
 *   /send <channel> <text>   /file <channel> <path> [to]   /peers   /transfers   /read <channel>
 *   /invite direct|group <name>   /tool <toolName> <json args>   anything else → `ok: <text>`
 *   after a tool result → `done: <first 200 chars of the result>`
 * Channel names with spaces can be quoted: /send "Bob chat" hi
 */
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  getCurrentSystemPrompt,
  getCurrentTools,
  type AssistantMessage,
  type FauxResponseFactory,
  type Message,
} from "@earendil-works/pi-ai";

export interface FakeRequestInfo {
  /** "owner" or "channel". */
  conversation: "owner" | "channel";
  /** Tool names offered to the model in this request. */
  tools: string[];
  systemPrompt: string;
  /** The text the brain is answering (peer text, owner command, or tool result). */
  text: string;
}

export interface FakeBrainHooks {
  /** Called for every request, before answering. */
  onRequest?(info: FakeRequestInfo): void;
  /**
   * Awaited before answering, e.g. to hold a run open in a crash test. It receives the request's abort signal;
   * a gate that never resolves must reject when it aborts, or closing the harness waits for it.
   */
  gate?(info: FakeRequestInfo, signal: AbortSignal | undefined): Promise<void>;
}

const NOTE_PREFIX = /^\[(note|you sent|reply from|owner note|you\/owner sent)/i;

export function createFakeBrain(opts: { name: () => string; hooks?: FakeBrainHooks }): FauxResponseFactory {
  return async (context, options) => {
    const messages = context.messages as readonly Message[];
    const tools = getCurrentTools(messages).map((t) => t.name);
    const systemPrompt = getCurrentSystemPrompt(messages);
    const channel = tools.includes("notify_owner");
    const target = lastRelevant(messages, channel);
    const info: FakeRequestInfo = {
      conversation: channel ? "channel" : "owner",
      tools,
      systemPrompt,
      text: target ? describe(target) : "",
    };
    opts.hooks?.onRequest?.(info);
    if (opts.hooks?.gate) await opts.hooks.gate(info, options?.signal);
    if (!target) return text("NO_REPLY");
    if (target.role === "toolResult") return afterTool(target, messages, channel);
    const userText = contentText(target.content);
    return channel ? channelAnswer(userText, opts.name()) : ownerAnswer(userText);
  };
}

function text(s: string): AssistantMessage {
  return fauxAssistantMessage(fauxText(s));
}

function call(name: string, args: Record<string, any>): AssistantMessage {
  return fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
}

/** The newest tool result, peer message (channel) or owner input (owner), skipping our own notes. */
function lastRelevant(messages: readonly Message[], channel: boolean): Message | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === "toolResult") return m;
    if (m.role === "assistant") return undefined;
    if (m.role !== "user") continue;
    const t = contentText(m.content);
    if (channel ? t.includes("<peer_message") : !NOTE_PREFIX.test(t.trim())) return m;
  }
  return undefined;
}

function describe(m: Message): string {
  if (m.role === "toolResult") return contentText(m.content);
  if (m.role === "user") return contentText(m.content);
  return "";
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((b) => (b?.type === "text" ? String(b.text) : "")).join("");
  return "";
}

/** Text inside the last <peer_message …>…</peer_message> block. */
export function peerText(s: string): string {
  const open = s.lastIndexOf("<peer_message");
  if (open === -1) return s.trim();
  const start = s.indexOf(">", open);
  const end = s.indexOf("</peer_message>", start);
  return s.slice(start + 1, end === -1 ? undefined : end).trim();
}

function channelAnswer(raw: string, myName: string): AssistantMessage {
  const t = peerText(raw);
  if (t.includes("NO_REPLY_TEST")) return text("NO_REPLY");
  const file = /please send file (\S+)/i.exec(t);
  if (file) return call("propose_file_send", { path: file[1], reason: "The peer asked for it." });
  return text(`Echo from ${myName}: ${t}`);
}

function afterTool(result: Message & { role: "toolResult" }, messages: readonly Message[], channel: boolean): AssistantMessage {
  const out = contentText(result.content);
  if (channel && result.toolName === "propose_file_send") {
    const args = findCallArgs(messages, result.toolCallId);
    return text(`Asked my owner to approve sending ${String(args?.path ?? "the file")}`);
  }
  if (channel) return text("NO_REPLY");
  return text(`done: ${out.slice(0, 200)}`);
}

function findCallArgs(messages: readonly Message[], callId: string): Record<string, unknown> | undefined {
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    for (const b of m.content) if (b.type === "toolCall" && b.id === callId) return b.arguments as Record<string, unknown>;
  }
  return undefined;
}

/** Split into tokens, honoring "double quotes". */
function tokenize(s: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  for (let m = re.exec(s); m; m = re.exec(s)) out.push(m[1] ?? m[2]!);
  return out;
}

/** First token (quoted or not) and the raw rest of the line. */
function head(s: string): [string, string] {
  const t = s.trimStart();
  const m = /^"([^"]*)"\s*|^(\S+)\s*/.exec(t);
  if (!m) return ["", ""];
  return [m[1] ?? m[2]!, t.slice(m[0].length)];
}

function ownerAnswer(input: string): AssistantMessage {
  const t = input.trim();
  const [cmd, rest] = head(t);
  switch (cmd) {
    case "/send": {
      const [channel, msg] = head(rest);
      if (channel && msg) return call("send_message", { channel, text: msg });
      break;
    }
    case "/file": {
      const [channel, path, to] = tokenize(rest);
      if (channel && path) return call("send_file", to ? { channel, path, to } : { channel, path });
      break;
    }
    case "/peers":
      return call("list_peers", {});
    case "/transfers":
      return call("list_transfers", {});
    case "/read": {
      const [channel] = tokenize(rest);
      if (channel) return call("read_channel", { channel });
      break;
    }
    case "/invite": {
      const [kind, name] = head(rest);
      if ((kind === "direct" || kind === "group") && name) return call("create_invite", { kind, name: name.trim() });
      break;
    }
    case "/tool": {
      const [name, json] = head(rest);
      if (name) {
        let args: Record<string, any> = {};
        try {
          args = json.trim() ? JSON.parse(json) : {};
        } catch {
          return text(`bad JSON for /tool: ${json}`);
        }
        return call(name, args);
      }
      break;
    }
  }
  return text(`ok: ${t}`);
}

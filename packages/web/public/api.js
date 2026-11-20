// Local daemon API client (docs/PROTOCOL.md §8) and the events WebSocket.
import { h } from "./dom.js";

const token = document.querySelector('meta[name="spencer-token"]')?.getAttribute("content") ?? "";

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function request(method, path, body) {
  const headers = { "X-Spencer-Token": token, Accept: "application/json" };
  const init = { method, headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError("Can't reach Spencer. Is the daemon running?", 0);
  }
  let data = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    const msg = data && typeof data.error === "string" ? data.error : `${res.status} ${res.statusText}`;
    throw new ApiError(msg, res.status);
  }
  return data ?? {};
}

const enc = encodeURIComponent;

export const api = {
  state: () => request("GET", "/api/state"),
  ownerMessages: (limit = 200) => request("GET", `/api/owner/messages?limit=${limit}`),
  ownerSend: (text) => request("POST", "/api/owner/messages", { text }),
  channelMessages: (ch, limit = 100, before) =>
    request("GET", `/api/channels/${enc(ch)}/messages?limit=${limit}${before !== undefined ? `&before=${enc(before)}` : ""}`),
  channelSend: (ch, text, mentions) => request("POST", `/api/channels/${enc(ch)}/messages`, mentions?.length ? { text, mentions } : { text }),
  patchChannel: (ch, patch) => request("PATCH", `/api/channels/${enc(ch)}`, patch),
  leaveChannel: (ch) => request("DELETE", `/api/channels/${enc(ch)}`),
  createInvite: (kind, name) => request("POST", "/api/invites", { kind, name }),
  acceptInvite: (link) => request("POST", "/api/invites/accept", { link }),
  transfers: () => request("GET", "/api/transfers"),
  sendFile: (ch, path, to) => request("POST", "/api/transfers", to ? { ch, path, to } : { ch, path }),
  transferAction: (tid, action) => request("POST", `/api/transfers/${enc(tid)}/${action}`),
  mcp: () => request("GET", "/api/mcp"),
};

// ---------------------------------------------------------------- toasts

export function toast(message, kind = "error") {
  const root = document.getElementById("toasts");
  if (!root) return;
  const el = h(`div.toast.${kind}`, { role: kind === "error" ? "alert" : "status" }, String(message));
  root.append(el);
  setTimeout(() => el.classList.add("leaving"), 4200);
  setTimeout(() => el.remove(), 4600);
}

/** Run an API call; on failure show a toast and return undefined. */
export async function attempt(fn) {
  try {
    return await fn();
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err));
    return undefined;
  }
}

// ---------------------------------------------------------------- events

/**
 * Connect the events WebSocket with exponential backoff.
 * onOpen(isReconnect) runs after every successful connect; onEvent(event) for each event.
 */
export function connectEvents({ onEvent, onOpen, onStatus }) {
  let delay = 1000;
  let connectedOnce = false;
  let ws;
  const connect = () => {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${proto}//${location.host}/api/events?token=${enc(token)}`);
    ws.addEventListener("open", () => {
      delay = 1000;
      onStatus?.(true);
      onOpen?.(connectedOnce);
      connectedOnce = true;
    });
    ws.addEventListener("message", (e) => {
      let ev;
      try {
        ev = JSON.parse(e.data);
      } catch {
        return;
      }
      if (ev && typeof ev.type === "string") onEvent(ev);
    });
    ws.addEventListener("close", () => {
      onStatus?.(false);
      setTimeout(connect, delay + Math.random() * 300);
      delay = Math.min(delay * 2, 15000);
    });
    ws.addEventListener("error", () => {
      try {
        ws.close();
      } catch {
        /* closing anyway */
      }
    });
  };
  connect();
}

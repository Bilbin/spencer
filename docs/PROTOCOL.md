# Spencer protocol v1

This is the contract between the relay, the Spencer daemon, and the web UI.
Code in `packages/protocol` implements the wire types and the crypto, and it is the
single source of truth for byte-level details. If this document and that code
disagree, fix one of them. Don't work around the difference.

## 0. Conventions

- **b64u** means base64url (RFC 4648 §5) without padding. All binary values in JSON use b64u.
- **Identity id**: the b64u Ed25519 public key (32 bytes, 43 chars). The human-facing
  **fingerprint** is the first 10 bytes of `sha256(pub)` as lowercase hex in groups of 4
  (`a1b2-c3d4-e5f6-a7b8-c9d0`).
- **Channel id**: 16 random bytes, b64u (22 chars).
- **Invite secret**: 32 random bytes, b64u (43 chars). It never leaves the two endpoints.
  It sits only in the URL fragment, which browsers and HTTP clients never send to the server.
- **Message id**: 16 random bytes, b64u. Globally unique. Used as the dedupe key everywhere:
  the relay dedupes on it, the daemon dedupes on it, and pi-durable gets `requestId = id`.
- Time is unix milliseconds (`number`).
- Crypto libraries: `@noble/curves` (ed25519, x25519), `@noble/hashes` (sha256, hkdf),
  `@noble/ciphers` (xchacha20poly1305). No custom primitives.

## 1. Keys

| Key | Derivation | Purpose |
|---|---|---|
| Identity `I` | random Ed25519 keypair, stored in `<dataDir>/identity.json` (mode 0600) | Signs envelopes and relay auth |
| Channel encryption key `K_enc` | `HKDF-SHA256(ikm=S, salt="spencer/v1", info="enc:"+ch, 32)` | XChaCha20-Poly1305 key for envelope bodies |
| Channel capability key `K_cap` | Ed25519 keypair from seed `HKDF-SHA256(S, "spencer/v1", "cap:"+ch, 32)` | Proves to the relay that the holder has the invite. The relay stores only `capPub` |
| Pair key `K_pair(A,B,ch)` | `HKDF-SHA256(X25519(mont(a), mont(B)), "spencer/v1", "pair:"+ch+":"+min(A,B)+":"+max(A,B), 32)` | Seals data meant for one member of a group, such as the croc code |

`S` is the invite secret and `ch` is the channel id. `mont()` is the birational map from
Ed25519 to X25519 (`ed25519.utils.toMontgomery` / `toMontgomerySecret`).

## 2. Invites

```
https://spencer.pjalv.com/i/<channelId>#<secret>
```

- The relay WebSocket URL comes from the invite origin: `https://H/i/...` → `wss://H/ws`, and
  `http://H/i/...` → `ws://H/ws` (used by local tests).
- `GET /i/<channelId>` on the relay serves a small static HTML page telling a human to paste
  the link into their Spencer UI. The fragment never reaches the server.
- **Direct channel**: `maxMembers = 2`. Once the second member joins, the relay refuses
  further joins, so a link that leaks later is useless.
- **Group channel**: `maxMembers = 32` by default. The same link can be shared with several people.
- Channel metadata (`{name, kind, createdBy}`) is sealed with `K_enc` (see `sealMeta`), stored by the relay
  as an opaque blob at create time, and returned to joiners.

## 3. Envelope (what the relay sees)

```ts
interface Envelope {
  v: 1;
  id: string;    // message id
  ch: string;    // channel id
  from: string;  // sender identity id
  ts: number;    // sender clock, ms
  n: string;     // 24-byte random nonce, b64u
  ct: string;    // XChaCha20-Poly1305(K_enc, n, utf8(JSON(body)), aad), b64u
  sig: string;   // Ed25519(I_sender, sigInput), b64u
}
aad      = utf8("spencer/v1/env\n" + v + "\n" + id + "\n" + ch + "\n" + from + "\n" + ts)
sigInput = utf8("spencer/v1/env\n" + v + "\n" + id + "\n" + ch + "\n" + from + "\n" + ts + "\n" + n + "\n" + ct)
```

- The relay checks `sig` against `from` (cheap) and that `from` is the authenticated
  connection identity and a member of `ch`. It can never decrypt `ct`.
- Recipients check `sig`, then decrypt. A failure in either means the message is dropped and logged.
  They ignore their own messages and dedupe by `id`.
- Max envelope size: 64 KiB serialized. Max `chat.text`: 16,000 chars.

### 3.1 Bodies (plaintext, inside `ct`)

The body schema is validated after decryption (`parseBody`). Unknown `type`s are ignored.

```ts
type Body =
  | { type: "hello"; name: string; about?: string; agent: string }       // e.g. agent "spencer/0.1"
  | { type: "chat"; text: string; hop: number; by: "human" | "agent";
      replyTo?: string; mentions?: string[] }                           // mentions = identity ids
  | { type: "file_offer";  tid: string; to: string; name: string; size: number; sha256: string; expiresAt: number }
  | { type: "file_accept"; tid: string; to: string; sealed: string }    // sealed croc code, see §6
  | { type: "file_decline"; tid: string; to: string; reason?: string }
  | { type: "file_ready";  tid: string; to: string; attempt: number }
  | { type: "file_retry";  tid: string; to: string; attempt: number }
  | { type: "file_ack";    tid: string; to: string; ok: boolean; sha256?: string; reason?: string }
  | { type: "file_cancel"; tid: string; to: string; reason: string };
```

- `hop`: 0 for a message the owner (human) typed or told their Spencer to send. An automatic
  reply carries `incoming.hop + 1`.
- `by`: `"human"` means the owner typed it in the UI. `"agent"` means Spencer's model wrote it.
- `to` on `file_*`: the single recipient identity. Other members ignore the message.
- `tid`: transfer id, 16 random bytes b64u, chosen by the sender.
- `hello`: sent when a client sees a channel member id that it hasn't greeted yet. Each client
  keeps `lastHelloMembers`, and sends a new hello whenever the member list (from the relay)
  contains an id not in that set. Display names are self-asserted. The UI always shows the
  fingerprint as well.

## 4. Relay WebSocket API (`/ws`)

All frames are JSON text. Requests carry `rid` (a client-chosen string). Replies are
`{t:"ok", rid, ...}` or `{t:"err", rid, code, msg}`.

### 4.1 Handshake
1. Relay → `{t:"challenge", nonce, server:"spencer-relay/1"}` (nonce: 32 random bytes b64u)
2. Client → `{t:"auth", id, sig}`, where `sig = Ed25519(I, utf8("spencer/v1/relay-auth:" + nonce))`
3. Relay → `{t:"welcome", id, croc?: {relay:"host:port", pass}}`. `croc` is present only if
   `id` is a member of at least one channel. This keeps the croc relay password away from
   people without an invite.

Before `welcome`, every other frame gets `err code:"unauthenticated"`. A connection that hasn't
authenticated within 10 s is closed.

### 4.2 Requests

| Frame | Effect / reply |
|---|---|
| `{t:"create", rid, ch, kind:"direct"\|"group", maxMembers, capPub, meta, proof}` | Creates the channel and adds the caller as a member. `proof = Ed25519(K_cap, utf8("spencer/v1/join:" + ch + ":" + id + ":" + nonce))`, where `nonce` is the connection's challenge nonce. Idempotent if the channel exists with the same `capPub` and the caller is already a member. Reply `ok {head, members, croc}`. |
| `{t:"join", rid, ch, proof}` | Verifies `proof` against the stored `capPub`. Adds the caller unless the channel is full (`err code:"full"`). If the caller is already a member, it just replies. Reply `ok {kind, maxMembers, meta, head, members, croc}`. A new member's ack cursor starts at `head`. Online members get `{t:"member", ch, id, event:"joined"}`. |
| `{t:"leave", rid, ch}` | Removes membership. Members get `{t:"member", ch, id, event:"left"}`. |
| `{t:"members", rid, ch}` | `ok {members:[{id, joinedAt}]}` (members only). |
| `{t:"send", rid, env}` | Member only, and `env.from` must equal the connection id. Verifies the signature and size. Assigns the next `seq`. **Idempotent on `env.id`**: a duplicate returns the original seq. Reply `ok {id, seq}`. This is the "relay ack" the outbox waits for. Pushes `{t:"msg", seq, env}` to every *other* subscribed member connection. |
| `{t:"sub", rid, ch, since}` | Member only. First streams `{t:"msg", seq, env}` for every stored message with `seq > since` that the caller didn't send, in order. Then replies `ok {head, first, members}` and the subscription goes live. `first` is the lowest stored seq. If `first > since + 1`, messages were lost to expiry and the client records a gap. |
| `{t:"ack", ch, seq}` | Cumulative ack (no reply). Sets the member cursor to `max(cursor, seq)`. |
| `{t:"ping", rid}` | `ok {}` |

Error codes: `unauthenticated`, `bad_request`, `not_member`, `no_channel`, `full`,
`bad_proof`, `bad_sig`, `too_large`, `rate_limited`, `limit`.

### 4.3 Retention
- A message is deleted once every current member's cursor is `>= seq`. The sender counts as having acked its own messages.
- Messages older than `TTL` (default 14 days) are deleted regardless.
- Limits: 64 KiB per frame, 10,000 stored messages per channel (`limit`), 200 channel memberships
  per identity, and a token bucket of 30 sends/s burst, 10/s sustained per connection.
- The relay pings every 30 s and drops connections that don't answer.

### 4.4 Relay HTTP
- `GET /healthz` → `ok`
- `GET /i/<ch>` → static invite landing page (no secrets involved)
- `GET /ws` → WebSocket upgrade

### 4.5 Relay config (env)
`SPENCER_RELAY_HOST` (127.0.0.1), `SPENCER_RELAY_PORT` (8820), `SPENCER_RELAY_DB`,
`SPENCER_RELAY_TTL_DAYS` (14), `SPENCER_CROC_RELAY` (`spencer.pjalv.com:9009`), `SPENCER_CROC_PASS`.

## 5. Daemon message flow

### 5.1 Outbox (durable send)
- `enqueue(ch, body)` builds and signs the envelope immediately, with a fresh id, and stores it in
  `outbox` within the same SQLite transaction as whatever caused it. Retries resend the **identical** envelope.
- One sender loop per channel, FIFO: send the oldest pending envelope, wait for `ok {seq}`, mark it
  `sent`, then move to the next. On disconnect or error, back off exponentially (1 s → 60 s cap) and retry.
  Rows survive restarts.
- A reply whose `ok` was lost causes a resend. The relay dedupes on `env.id`, so this is safe.

### 5.2 Inbox (durable receive)
1. `msg {seq, env}` arrives. Verify and decrypt. In **one** transaction, insert into `messages`
   (`INSERT OR IGNORE` on id, with `routed = 0`) and set `channels.last_seq = max(last_seq, seq)`.
2. Route it: chat goes to the agent (§7), `file_*` goes to transfers (§6), `hello` updates members. Then set `routed = 1`.
3. Send `{t:"ack", ch, seq}`.
- On startup, rows with `routed = 0` are routed again. Routing is idempotent: pi-durable dedupes on
  `requestId = msg.id`, and the transfer state machine ignores stale events.
- On (re)connect: `sub {ch, since: last_seq}` for every channel.

## 6. File transfers (croc)

Files never go through the message relay. The croc relay address and password come from the relay's
`welcome`/`join` frames (`croc`), and local config can override them. Pinned croc: **v10.3.1**.

### 6.1 Sender states
`awaiting_approval → offered → sending → completed`
Terminal: `completed | denied | declined | failed | expired | cancelled`

1. **Request** (owner UI, the owner agent's `send_file`, or a peer agent's `propose_file_send`): the file
   is copied into `<data>/outgoing/<tid>/<basename>`, its sha256 and size are recorded, and the state
   becomes `awaiting_approval`. With `policy.requireApprovalForOutgoingFiles = false`, only owner-initiated
   sends skip straight to `offered`. Peer-initiated sends **always** need approval.
2. **Approve**: enqueue `file_offer` (expires in 24 h by default) → `offered`. **Deny** → `denied` and delete the staged copy.
3. On `file_accept`: unseal the code → `sending`, with `attempt = 1`. Spawn
   `croc --yes --overwrite --disable-clipboard --relay R --pass P send --no-local --code CODE <staged file>`.
   When croc reports it is waiting (prints the code, or about 1 s after spawn), enqueue `file_ready {attempt}`.
4. On `file_retry {attempt}` matching the current attempt, or croc exiting with an error before the ack:
   kill croc, `attempt++`, back off, and spawn again with `file_ready {attempt}`. At most 5 attempts → `failed` (+ `file_cancel`).
5. On `file_ack ok:true` → `completed`, delete the staged copy. On `ok:false` → `failed`.

### 6.2 Recipient states
`offered → accepted → receiving → completed`
Terminal: `completed | declined | failed | expired | cancelled`

1. On `file_offer` addressed to me: record it (`offered`). If `policy.autoAcceptIncomingFiles` and
   `size <= maxIncomingFileBytes`, accept right away. Otherwise wait for the owner in the UI.
2. **Accept**: generate `CODE = dddd-<32 hex>` (4 random digits, a dash, 16 random bytes in hex).
   Enqueue `file_accept {sealed: seal(K_pair, tid, {code})}` → `accepted`. **Decline** → `file_decline`.
3. On `file_ready {attempt}` with `attempt >= current`: kill any running receive and spawn
   `croc --yes --overwrite --disable-clipboard --relay R --pass P --out <data>/incoming/<tid>/`
   with env `CROC_SECRET=CODE` → `receiving`.
4. When croc exits 0: hash the received file. If it matches the offer, move it to
   `<data>/quarantine/<tid>/<sanitized name>` (mode 0600) → `completed`, then enqueue `file_ack ok:true`.
   If it doesn't match, delete it, `file_ack ok:false reason:"sha256 mismatch"` → `failed`.
   If croc exits non-zero, enqueue `file_retry {attempt}` and wait.

### 6.3 Crash recovery and expiry
- On startup, the sender in `sending` re-spawns croc with `attempt+1` and enqueues `file_ready`.
  The recipient in `receiving` first checks for a completed file with the right hash
  (→ verify → ack). Otherwise it enqueues `file_retry`.
- A sweeper runs every 30 s. Any non-terminal transfer past `expiresAt` → `expired`: kill croc, delete
  staged and partial files, and enqueue `file_cancel` if the peer already knows about the transfer.
- `file_cancel` from the peer → `cancelled`, with the same cleanup.
- Transfer events are idempotent: each handler checks the current state and ignores events that don't apply.

### 6.4 Sealing
`seal(key, tid, obj) = b64u(n24 || xchacha20poly1305(key, n24, utf8(JSON(obj)), aad=utf8("spencer/v1/seal:"+tid)))`

## 7. Agent, trust boundary, loop control

### 7.1 Conversations (pi-durable 1.5.2, behind `AgentRuntime`)
- **Owner conversation**: the pi-durable root conversation. The owner's tools: `list_peers`, `send_message`,
  `send_file`, `list_transfers`, `read_channel`, `create_invite`, MCP tools, and optionally CodingTools (`policy.ownerCodingTools`).
- **Channel conversation**: one ownerless conversation per channel. It sees peer messages as
  *untrusted data*. Its tools are limited to `notify_owner` and `propose_file_send`, plus the MCP tools
  the owner allowed for that channel. No shell, no file reads, no MCP by default.

### 7.2 Routing an incoming chat (`decideReply`)
The message is always written to the channel conversation as context (a `write` entry with model text).
It triggers a model run (`submit input`, `requestId = msg.id`) only if **all** of these hold:
1. `channel.autoReply` is on (default on).
2. `hop < policy.maxHops` (default 4).
3. Direct channel, **or** a group where `mentions` contains my id or the text contains `@<my name>` (case-insensitive).
4. The per-channel rate limit allows it: `policy.repliesPerMinute` (6) and `policy.repliesPerHour` (60).

The answer becomes `chat {hop: in.hop+1, by:"agent", replyTo: in.id, mentions:[in.from]}`, unless the
trimmed answer is `NO_REPLY`. A crash between the answer and the enqueue is covered by the
`pending_replies` table plus a deterministic reply key, so the reply is enqueued exactly once.

### 7.3 Owner notification
When a peer message replies to a message the owner conversation sent, it is appended to the owner
conversation as a **write** (it never starts a run), clearly marked as untrusted. The owner sees the answer
there, and the owner's model has it as context the next time the owner speaks.

## 8. Local daemon API (127.0.0.1 only)

- It binds to `127.0.0.1` only. Requests must have `Host: 127.0.0.1:<port>` or `localhost:<port>`
  (DNS-rebinding guard). Every `/api` call needs the header `X-Spencer-Token: <token>`. The token is
  injected into `index.html` as `<meta name="spencer-token">`. Cross-origin pages can't read that file,
  and the custom header forces a CORS preflight that the daemon never approves.
- JSON in and out. Errors: `{error: string}` with a 4xx/5xx status.

| Method | Path | Body → Response |
|---|---|---|
| GET | `/api/state` | → `{me:{id, name, fingerprint}, relay:{url, connected}, channels: Channel[], transfers: Transfer[], mcp: McpServer[], policy}` |
| GET | `/api/owner/messages?limit=` | → `{items: OwnerItem[]}` (owner conversation transcript, oldest first) |
| POST | `/api/owner/messages` | `{text}` → `{submissionId}` |
| GET | `/api/channels/:ch/messages?limit=&before=` | → `{items: ChannelMessage[]}` |
| POST | `/api/channels/:ch/messages` | `{text, mentions?}` → `{id}` (owner speaks as a human in the channel; hop 0, by "human") |
| PATCH | `/api/channels/:ch` | `{name?, autoReply?, allowedMcpTools?: string[]}` → `Channel` |
| DELETE | `/api/channels/:ch` | leave the channel → `{}` |
| POST | `/api/invites` | `{kind:"direct"\|"group", name}` → `{link, channel: Channel}` |
| POST | `/api/invites/accept` | `{link}` → `{channel: Channel}` |
| GET | `/api/transfers` | → `{items: Transfer[]}` |
| POST | `/api/transfers` | `{ch, path, to?}` → `Transfer` (owner-initiated; `to` is required in groups) |
| POST | `/api/transfers/:tid/approve` · `/deny` · `/accept` · `/decline` · `/cancel` | → `Transfer` |
| GET | `/api/mcp` | → `{servers: McpServer[]}` |
| WS | `/api/events?token=` | server → client events: `{type:"channel", channel}`, `{type:"message", ch, message}`, `{type:"transfer", transfer}`, `{type:"owner", item}`, `{type:"relay", connected}`, `{type:"owner_busy", busy}` |

```ts
interface Channel { id: string; kind: "direct"|"group"; name: string; relayUrl: string;
  members: { id: string; name?: string; fingerprint: string; me: boolean }[];
  autoReply: boolean; allowedMcpTools: string[]; unread: number; lastSeq: number; createdAt: number }
interface ChannelMessage { id: string; ch: string; from: string; fromName?: string; mine: boolean;
  ts: number; seq?: number; type: string; text?: string; hop?: number; by?: "human"|"agent";
  replyTo?: string; status: "pending"|"sent"|"received"; note?: string }   // note: e.g. "not addressed", "hop cap", "rate limited"
interface Transfer { tid: string; ch: string; direction: "out"|"in"; peer: string; peerName?: string;
  name: string; size: number; sha256: string; state: string; attempt: number; initiatedBy: "owner"|"peer-agent"|"owner-agent"|"peer";
  progress?: number; error?: string; path?: string; createdAt: number; updatedAt: number; expiresAt: number }
interface OwnerItem { id: string; role: "user"|"assistant"|"tool"|"note"; text: string; ts: number;
  toolName?: string; isError?: boolean }
interface McpServer { name: string; transport: "stdio"|"http"; status: "connected"|"error"|"disabled"; error?: string;
  tools: { name: string; description?: string }[] }   // tool name as exposed: mcp__<server>__<tool>
```

## 9. Daemon config (`<dataDir>/config.json`)

```jsonc
{
  "name": "Alice's Spencer",
  "relay": "wss://spencer.pjalv.com/ws",     // default relay for new invites
  "http": { "port": 7420 },
  "model": { "provider": "anthropic", "modelId": "claude-sonnet-5-5", "apiKeyEnv": "ANTHROPIC_API_KEY" },
  // or: { "provider": "openai-compatible", "baseUrl": "http://localhost:11434/v1", "modelId": "llama3.1", "apiKeyEnv": "OLLAMA_KEY" }
  // or: { "provider": "fake" }   (deterministic, tests)
  "croc": { "path": "croc", "relay": null, "pass": null },
  "mcpServers": {
    "fs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] },
    "remote": { "url": "https://example.com/mcp", "headers": {} }
  },
  "policy": { "maxHops": 4, "repliesPerMinute": 6, "repliesPerHour": 60,
    "autoAcceptIncomingFiles": true, "maxIncomingFileBytes": 536870912,
    "requireApprovalForOutgoingFiles": true, "ownerCodingTools": true, "transferTtlHours": 24 }
}
```
Environment variable overrides: `SPENCER_DATA_DIR`, `SPENCER_PORT`.

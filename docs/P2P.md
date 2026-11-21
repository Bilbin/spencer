# Direct links between Spencers (design v3, updated for groups & pluggable hubs)

Status: approved for implementation, 2026-11-21. v1 was reviewed by Fable (verdict: go with
changes); v2 took all of its required changes (§15). v3 adds pairwise P2P files inside group
channels, first-class pluggable chat hubs (`--relay` / per-invite hub URL, chat-only hubs
without croc), and locks in the §13 defaults.

"Peer to peer" here means **two Spencers moving data over a direct, encrypted network connection** instead of
through the VPS. The relay ("hub") stays the mailbox, the presence service, the invite service and the signaling channel —
and any channel can point at any self-hosted hub. A direct link is an extra path, opened **when there is a file to move**
and closed when idle. Everything falls back to croc when the hub provides one.

## TL;DR

- **Hub for chat, P2P for files.** Chat messages stay on the hub (a small ~220 KiB ciphertext-only relay that handles
  ordering, fan-out for groups, presence and offline delivery). Any Spencer can pass a custom hub via `--relay` or when
  creating an invite, and hubs no longer need a `croc-relay` to move files between online peers.
- **Files first — in both direct and group channels.** File bytes are what the VPS actually carries. Phase 1 moves
  1-to-1 file transfers over direct links in both direct and group channels (signaling is already pairwise-sealed with
  `K_pair`, so other group members never see the SDP or IP addresses). The outbox and inbox (the durable, exactly-once
  message paths) **do not change**.
- **On-demand links.** A link is dialed when a transfer above `minFileBytes` (default 4 MiB) — or any size when the hub
  has no croc relay — is about to send, and closed after 60 s idle. No always-on links: less code, and the peer learns
  your IP only when you exchange a file.
- **WebRTC data channels via `node-datachannel`** (libdatachannel: ICE + DTLS + SCTP, prebuilt per platform, only
  glibc needed). Measured: 300 MiB/s on loopback, laptop→VPS connected in 1.9 s over the internet.
- **Signaling over the relay**, sealed per pair and ephemeral. The SDP, including the DTLS fingerprint, is signed by
  the Spencer identity, so the DTLS session is authenticated end to end. **STUN on the relay; no TURN**: if hole
  punching fails, the transfer falls back to croc when configured.
- **Phase 0 comes first** (§14): a packaging and network spike (cross-target `.node` in the SEA binary, Nix, macOS signing, two
  real NATs) before phase 1 is wired up.

## 1. What happens today

| Traffic | Path | Notes |
|---|---|---|
| Chat, hello, file control | Spencer → relay (WSS) → Spencer | E2E-encrypted envelopes, stored until acked (PROTOCOL.md §3–5) |
| Live status | relay `eph` frames | not stored (§4.7) |
| File bytes | croc → croc relay on the VPS → croc | the sender runs `croc send --no-local`, so **every byte crosses the VPS**, even on one LAN |

So a 2 GB file is 2 GB in and 2 GB out of a 4 vCPU VPS, at the slowest of three uplinks. That is the cost worth
removing. Messages are small, their latency is acceptable, and their path is the most safety-critical code.

## 2. Goals and non-goals

Goals:
1. Files between two online Spencers go directly when the network allows it, with no setup, and faster.
2. Nothing gets less reliable. The transfer state machine, crash recovery and hash check stay; croc is the guarantee.
3. No new trust. The link is authenticated by the identity keys; the peer stays exactly as untrusted.
4. The peer learns your IP only when that buys something (a file transfer), and you can turn it off.
5. It ships in the single binary and the Nix package, and a broken native addon only disables links.

Non-goals: chat over links (deferred, §11), 1-to-many group file swarming (pairwise transfers in groups ARE supported),
TURN, a DHT or discovery without the relay, UPnP/NAT-PMP, own-device links, media. **No Tailscale.** Honest limit: links
cannot be set up without the relay, and the relay can always drop signaling and force the fallback. Links remove bandwidth
and per-byte visibility from the VPS; they do not remove the VPS from the trust picture for metadata.

## 3. What was measured (spike, 2026-11-20)

| Test | Result |
|---|---|
| `node-datachannel` 0.33.6, loopback, 500 MiB, 64 KiB chunks | **298 MiB/s**, connected in 2 ms |
| `werift` 0.28 (pure TypeScript WebRTC), loopback, 50 MiB | 26 MiB/s, 3.5 s to connect |
| `node-datachannel`, laptop (home NAT) → VPS (public IP), Google STUN, SDP over SSH | connected in **1.9 s**, 40 MiB at 2.7 MiB/s (the home uplink) |
| Inbound UDP to the VPS (port 34780) | open, so a STUN server there will work |
| Native addon linkage | glibc only (OpenSSL, libjuice and usrsctp built in); prebuilt `.node` per platform via npm optionalDependencies |
| API | `PeerConnection.remoteFingerprint()`, `cleanup()`, `portRangeBegin/End`, `iceTransportPolicy`, `maxMessageSize` exist |

Gotcha: **a data channel that JavaScript no longer references is garbage-collected and closed**, mid-transfer.
Every channel is held in a registry until it is closed on purpose.

Not yet tested (phase 0): two home NATs, CGNAT and mobile (expect failure, then croc), IPv6, macOS, and the
packaging items in §10.

## 4. Choice of stack

| Option | Verdict |
|---|---|
| **node-datachannel** (MPL-2.0, unmodified) | **Chosen.** Mature ICE/DTLS/SCTP, fast, maintained (Oct 2026), prebuilt binaries as npm packages (no install-time download). |
| werift (pure TS) | 10× slower, seconds to connect. Not a fallback in phase 1: if the addon cannot load, links are off. |
| Hyperswarm / hyperdht | A second identity system, DHT and set of native addons. No. |
| js-libp2p | Large; hole punching needs circuit relays plus DCUtR. No. |
| iroh | Good design, but no maintained Node bindings. |
| `node:quic` plus our own hole punching | Experimental; we would write ICE ourselves. No. |
| croc without `--no-local` | LAN only, and it broadcasts on the LAN. A separate privacy decision; not part of this design. |

## 5. When a link is dialed

Only for files, only when all of these hold:
- a transfer in a **direct or group** channel reaches the point where the sender would spawn croc
  (`file_accept` received, or a retry), and either its size is ≥ `p2p.minFileBytes` (default 4 MiB) **or** the
  channel's hub provides no croc relay (chat-only hub);
- `p2p.mode` is `"files"` on **both** sides (each side advertises `p2p-files/1`, §8) and the channel's `directLink` is not `"off"`;
- the addon loaded, the crash breaker (§9.3) is not tripped for this channel, and the relay has `ephemeral`.

Links are keyed by `(ch, peerId)` so multiple members in a group channel can have independent pairwise links without
interfering with each other or exposing SDPs/IPs to other group members (`K_pair(A,B,ch)`).

The **sender dials**; the receiver answers. Roles follow the transfer, so there is no glare rule. If a link to that
peer is already up (another transfer), it is reused. Dial timeout: 10 s from offer to verified link; then this
attempt falls back to croc (if configured).

A link closes after 60 s with no open file channel, on `bye`, when the peer connection goes `failed`/`closed`, on a
detected suspend/resume, on leaving the channel, and on daemon stop. Losing **our** relay connection does not close
a link (presence `unknown` is not `offline`).

## 6. Signaling

New bodies, sent **ephemeral** (§4.7), never through the outbox, and **only to peers that advertised p2p**
(so old Spencers never see them):

```ts
| { type: "link_offer";  to: string; sid: string; sealed: string }   // ≤ 16 KiB; sealed {sdp}
| { type: "link_answer"; to: string; sid: string; sealed: string }   // ≤ 16 KiB; sealed {sdp}
| { type: "link_close";  to: string; sid: string; reason?: string }
```

- `sid`: 16 random bytes b64u per dial.
- **Sealing**: `K_pair(A,B,ch)` with its own AAD label: `spencer/v1/link:offer:<sid>` or `…:answer:<sid>`
  (never the croc-code label `spencer/v1/seal:<tid>`). That keeps IP addresses from anyone else holding the channel
  key, e.g. a leaked invite secret.
- **Non-trickle ICE**: gather (at most 3 s), then one offer and one answer.
- **Replay and freshness without trusting clocks:**
  - the dialer accepts an answer only for the `sid` it is currently waiting on;
  - the answerer keeps a set of seen `sid`s (bounded, 1 h) and answers each `sid` once;
  - an offer never tears down a working link: replacement is **make-before-break** (the old link closes only after
    the new one verifies). A replayed offer therefore costs one useless answer and nothing else. No `exp`.
- **Rate limit**: at most 1 offer per 10 s per channel accepted; excess is dropped.
- The daemon's ephemeral handler (`daemon.ts`, now `status` only) also accepts `link_*` bodies, with the same relay,
  envelope, signature and membership checks, plus `to` = me.

## 7. Authentication and candidate hygiene

1. The offer and answer carry each side's DTLS fingerprint inside a signed, encrypted envelope. libdatachannel
   rejects a DTLS peer whose certificate doesn't match the remote description, so a connected link is the identity
   that signed the SDP. DTLS certificates are per process, never persisted.
2. **Binding check (conditional):** after the link connects, both sides send `link_hello {sid, sig}` on `ctl`, with
   `sig = Ed25519(I, "spencer/v1/link-hello\n" + ch + "\n" + sid + "\n" + localFp + "\n" + remoteFp)`, where
   `remoteFp` is `remoteFingerprint()`. This is kept **only if phase 0 proves that `remoteFingerprint()` reports the
   certificate seen in the live DTLS handshake**. If it merely echoes the SDP, it adds nothing and is cut.
3. **Outgoing candidates** (ours, in our SDP): drop host candidates for private IPv4, link-local, ULA **and global
   IPv6 host addresses** when local addresses are hidden (`p2p.hideLocalAddresses` is true and the channel's
   `allowLocalAddresses` is false); zero `raddr`/`rport` on srflx lines.
4. **Incoming candidates** (the peer's, attacker-controlled): at most 8; drop loopback, unspecified, link-local,
   multicast and broadcast. Private ranges are allowed only when local addresses are allowed on our side (same-LAN
   mode: `!p2p.hideLocalAddresses || channel.allowLocalAddresses`).
5. `p2p.portRange` is not offered (cut, see §14).

## 8. Protocol changes (all backward compatible)

| Change | Notes |
|---|---|
| `hello.features?: string[]`, e.g. `["p2p-files/1"]` | `parseBody` keeps it (validated: ≤ 8 strings ≤ 32 chars). Stored per member in a new `members.features` column. |
| Re-advertising | `channels.last_hello_features` is persisted; a hello is sent when the member set **or** our features change. Feature-only hellos are not shown in the channel timeline. |
| `link_offer` / `link_answer` / `link_close` | ephemeral only, to p2p peers only |
| `file_ready.via?: "link"` | sent only to `p2p-files/1` peers; `parseBody` keeps it |
| Relay: feature `"stun"`, `welcome.stun: "host:port"` | old Spencers ignore it; without it, Spencer uses `config.p2p.stun`, or no links |

## 9. Files over the link

The transfer state machine (PROTOCOL.md §6) stays. Per attempt, the sender picks the transport.

### 9.1 Choosing and switching

- If a link to the peer is ready (or can be dialed and verified within 10 s): enqueue
  `file_ready {attempt, via:"link"}`; otherwise croc as today.
- If a link attempt fails (link drop, 30 s with no bytes, oversize, hash mismatch after resume), the **next attempt
  uses croc**. One link attempt per transfer at most, plus the one-shot retry-from-zero in §9.2.
- **Before any croc attempt**, the receiver deletes `incoming/<tid>/*.part`. Otherwise `findReceived` sees two
  entries ("unexpected content", `files.ts`) and the watchdog's `dirBytes > size` check fails the transfer.

### 9.2 Stream (receiver-initiated)

1. On `file_ready {via:"link", attempt}` (attempt strictly greater than the current one, as today), the **receiver**
   opens data channel `f:<tid>:<attempt>` on the link to that peer and sends `{offset}`: the size of its `.part`
   for this tid, else 0.
2. The sender accepts the channel only if the label parses, `tid` is a transfer of ours in `sending` to **this**
   peer, `attempt` equals its current attempt, and `offset` is an integer in `0..size`. Anything else is closed at
   once. At most 4 peer-opened channels per link; unknown labels are closed immediately.
3. Sender → binary chunks of 64 KiB from `offset`, with backpressure (`bufferedAmount` ≤ 4 MiB, resume on
   `onBufferedAmountLow`), then the string `"end"`.
4. The receiver **counts bytes in the stream handler** and aborts the channel and the attempt the moment
   `offset + received > size`, or on any non-binary message other than `"end"`. It writes `<name>.part`, renames it on
   `"end"`, then follows the existing path: sha256 check → quarantine → `file_ack`.
5. **Resumed attempt with a mismatch:** a torn `.part` after a crash would otherwise make the transfer terminally
   `failed`. So if the attempt started at `offset > 0` and the hash mismatches, the receiver deletes the file and
   sends `file_retry` once, and the next link attempt starts from 0. A mismatch from offset 0 is terminal, as today.
6. `sctp maxMessageSize` is set explicitly (256 KiB); phase 0 verifies that larger incoming messages are refused.

### 9.3 Crash-loop breaker

The native code (libjuice, usrsctp, OpenSSL) is reachable by an untrusted peer. Before dialing or answering for a
channel, write `<data>/p2p-attempt` with the channel id; remove it when the link closes or fails cleanly. If it is
present at startup, the previous process died during a link: disable links for that channel for 24 h and tell the
owner. Process isolation is possible later.

### 9.4 Shutdown

`Daemon.stop` closes links (`bye`), then calls node-datachannel `cleanup()` so the process exits.

## 10. Packaging (phase 0 proves each item)

- **Dev / npm:** `node-datachannel@0.33.6`, exact pin; npm installs the host's `@node-datachannel/<platform>` package.
- **Loading:** one path everywhere: `p2p/addon.ts` finds the `.node` by explicit path and loads it with
  `process.dlopen` (no bundler-resolved `require` of a `.node`; `import.meta.url` is redefined in the bundle).
  Failure → p2p off, reported once in the UI with the reason (e.g. a `noexec` cache dir).
- **SEA binary:** `build-binary.mjs` cross-builds four targets from one host, but npm only installs the host's
  optional package. It fetches the pinned per-target npm tarballs with sha256, the way croc is fetched. The manifest
  gets `addons: {"node-datachannel": "<asset key>"}` and `sea.ts` unpacks it next to croc.
- **Nix:** check that the lockfile pins every platform package, that `buildNpmPackage` installs the right one, and that
  `npmDepsHash` is updated. The package uses `nodejs_22` (N-API 8 works there), and a build check loads the addon.
  Darwin is in `platforms`.
- **macOS:** the unpacked `.node` must keep a valid signature on arm64 (re-sign ad hoc after unpacking if needed);
  expect the firewall prompt per ad-hoc build; test under a LaunchAgent.
- **Relay STUN:** the relay is behind nginx on 127.0.0.1, and STUN needs its own public UDP bind. Add
  `SPENCER_RELAY_STUN_BIND` (e.g. `0.0.0.0:3478`) and `SPENCER_RELAY_STUN_PUBLIC` (`spencer.pjalv.com:3478`), plus a
  UDP firewall opening in `nix/modules/relay.nix`. The VPS deploy only opens UDP 3478 for the relay; no existing
  service or vhost is touched. STUN answers Binding requests only, rate limited per source IP.

## 11. Later: chat over links (not in phase 1 or 2)

Only if live latency matters later (streaming replies, status). The review found three problems that must be solved
first:
- **Ordering across routes**: a relay `ok` means stored, not delivered. Each link frame must carry the sender's last
  relay-sent seq, and the receiver processes it only once its `last_seq` reaches that. On an ack timeout, tear down
  the link, not just reroute one row.
- **Checks only the relay does today**: envelope size ≤ 64 KiB, a token bucket matching the relay's, a member-presence
  check, and caps on `eph` and ping frames.
- **Ack latency**: insert and ack on arrival, then route on the existing per-channel chain, so an id arriving on both
  routes is never routed twice.
- **Wiring**: a pump kick on link up and down, a path for when the relay is down but the link is up, and
  `rerouteUnrouted` ordering for NULL seq (it sorts them first today).

## 12. Config, API, Hub Passing and UI

```jsonc
"p2p": {
  "mode": "files",               // "files" | "off"   (default: "files")
  "hideLocalAddresses": true,
  "minFileBytes": 4194304,
  "stun": []                     // extra "host:port"; the relay's comes first
}
```

- **Pluggable hub ergonomics:**
  - CLI: `--relay URL` (and `SPENCER_RELAY` env var) sets the default hub URL (saved to `config.json` on first run, like `--name`). Accepts `ws://`, `wss://`, `http://`, or `https://` (normalized to `ws(s)://host/ws`).
  - `POST /api/invites`: accepts optional `relay?: string` so any direct or group channel can be created on any hub. Exposed in the `+ Invite` modal and the agent `create_invite` tool.
  - Chat-only hubs (no `croc` relay configured): P2P file transfers are attempted for all file sizes (ignoring `minFileBytes`). If a direct link cannot be established and no croc relay is available, the transfer retries/fails with a clear error rather than assuming croc exists.
- `PATCH /api/channels/:ch`: `directLink?: "auto" | "off"`, `allowLocalAddresses?: boolean`.
- `Transfer` gains `via?: "link" | "croc"`. `/api/state` includes `p2p: { mode, available, error? }`. The event `transfer` covers `via`; no new link API.
- UI: a transfer row shows "Direct" or "Through the server". Channel settings show the channel's hub URL, the "Direct file transfers" toggle ("Send files directly when you're both online. Faster, and the bytes don't go through the server, but peers see your IP address while a file is moving."), and an "Allow local network addresses" per-channel toggle for fast same-LAN transfers. A "not available" note appears if the addon could not load.

## 13. Decisions (locked in)

1. **IP exposure default**: `p2p.mode: "files"` is **on by default**, since exposure only happens during transfers, with the channel-settings notice and a first-transfer "Sent directly" toast.
2. **Same-LAN transfers**: `hideLocalAddresses: true` globally, with a per-channel `allowLocalAddresses` toggle (default `false`) for fast transfers on a shared LAN.
3. **Size threshold**: `minFileBytes` defaults to 4 MiB when a croc relay is available, and 0 (always try P2P) on chat-only hubs without a croc relay.

## 14. Plan

| Phase | Scope | Estimate |
|---|---|---|
| 0 | Spike: cross-target `.node` fetch and SEA load, Nix build plus addon load, macOS arm64 signing, a two-NAT test (home ↔ phone hotspot), `remoteFingerprint()` semantics, incoming message-size limit, `cleanup()` on exit | 1–1.5 days |
| 1 | Relay STUN (+ deploy), addon loading, `LinkManager` (on-demand dial, sealed signaling, candidate filters, crash breaker), hello features, files over the link with croc fallback, transfer UI | 4–5 days |
| 2 (maybe) | Chat and status over links, with §11 solved | 3–4 days |

Tests for phase 1. Unit:
- signaling: wrong `sid`, replayed offer, make-before-break, rate limit;
- candidate filters, both directions;
- stream validation: label, peer, attempt, offset range, oversize, non-binary;
- `.part` cleanup before croc;
- resume mismatch: one retry from zero.

Integration (two daemons, real addon on loopback, a local relay with STUN):
- a file over the link;
- the link killed mid-stream: resume, or croc fallback with the right hash;
- the relay restarting mid-transfer;
- an old peer without the feature: croc only;
- `p2p.mode: off` on either side;
- a peer opening unknown channels;
- crash breaker on restart.

## 15. Changes from v1 (review by Fable)

| v1 | v2 | Why |
|---|---|---|
| Chat first, always-on links | Files first, on-demand links | The VPS cost is file bytes. Chat over links had a real cross-route ordering bug and needed relay-only checks moved into the inbox. On-demand removes backoff ladders, LRU caps and most ping logic, and limits IP exposure. |
| Dialer = smaller id | Dialer = file sender | Roles follow the transfer; no glare |
| `exp` (sender clock), "fresh sid" replacement | Seen-sid set, pending-sid match, make-before-break, no `exp` | Clock skew broke v1; a replayed offer could keep a link down |
| Sealed with the croc label | Own AAD label per role | Domain separation |
| `sealed` reuse | ≤ 16 KiB field on the new bodies | The existing parser caps `sealed` at 1000 chars; an SDP is bigger |
| Sender-initiated file channel | Receiver-initiated, sender validates | The channel could beat `file_ready`; a malicious receiver's offset is now validated |
| (missing) | `.part` cleanup before croc, retry-from-zero on resumed mismatch, in-stream byte count, channel cap | These would have failed transfers in the existing code paths |
| Host candidates hidden for private ranges | Also global IPv6 and srflx `raddr`; incoming candidates filtered and capped | IPv6 leaks; attacker-controlled candidates probe loopback and the LAN |
| `link_hello` always | Only if `remoteFingerprint()` is the live DTLS cert | Otherwise it is circular |
| (missing) | Crash breaker, `cleanup()` on stop, cross-target addon fetch, explicit-path dlopen, relay UDP bind and firewall | Implementation would have hit each of these |
| Hello resent "when features change" | Persisted `last_hello_features`, hidden from timeline | `maybeHello` only fires for newcomers today |
| `portRange`, `rttMs`, `path`, link events | Cut | Not needed for files-first |

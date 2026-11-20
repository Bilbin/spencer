# Spencer — feasibility assessment (2026-11-19)

**Verdict: feasible.** All components exist and the VPS has enough headroom. The main risk is that Pi Durable is experimental software.

## What Spencer is
Spencer is an agent that runs all the time on someone's machine. It does three things:
- talks to other Spencers on other people's machines
- sends and receives files with them
- uses tools from MCP servers

You control it from a simple local web UI.

## Checked facts

| Area | Finding | Impact |
|---|---|---|
| VPS `ubuntu@pjalv.com` (51.81.187.72) | Ubuntu 24.10 x86_64, 4 vCPU, 3.7 GiB RAM (~1.7 GiB available), 29 GB disk free | A relay with WebSocket + SQLite needs ~50–100 MB. Fine. Keep it lean; no Docker. |
| Runtimes on VPS | Node v22.22.0, npm 10.9.4. No bun, docker, sqlite3 CLI, croc | Use Node 22 (`node:sqlite` built-in, or better-sqlite3). The croc binary must be installed. |
| Web / TLS on VPS | nginx on 80/443, certbot present, passwordless sudo works, existing vhosts (t3, git, vnc, posters, …) | Add **one new** vhost `spencer.pjalv.com` → 127.0.0.1:<port> with WebSocket upgrade. Don't touch other vhosts. Run `nginx -t` before reload. |
| Firewall | iptables INPUT policy ACCEPT (tailscale chain only). Port 9009 was tested reachable from the internet (HTTP 200) | A self-hosted croc relay on TCP 9009–9013 works. |
| DNS | `spencer.pjalv.com` does **not** resolve yet. pjalv.com points straight at the origin | User is creating an A record → 51.81.187.72. It must be DNS-only (not CDN-proxied), so WebSockets and large streams aren't capped. |
| Existing services on VPS | Many: cliproxyapi :8316/8317, redis, slapd, icecast, cloudflared, … | Pick a free localhost port for the relay (e.g. 8820). Check with `ss -tlnp` first. |
| Local machine | NixOS, Node v24.12.0, 16 cores / 30 GiB RAM, docker present, no croc | croc comes via nix or a downloaded release binary. |
| `@earendil-works/pi-durable` | npm 1.5.2 (latest), **experimental, API changes between minor versions** | Pin the exact version. Wrap it behind our own small `AgentRuntime` interface so an API change touches one file. |
| `@earendil-works/pi-ai` | 1.5.2 | Multi-provider LLM access. |
| `@modelcontextprotocol/sdk` | 1.32.2 | MCP client (stdio + streamable HTTP). Expose MCP tools as Pi tools. |

## Architecture decisions (from the design discussion)
- **No Tailscale.** The user ruled it out.
- **Messages go through a small relay on the VPS** (`wss://spencer.pjalv.com`). Each Spencer connects out to it, so this works behind any home router. The relay is a mailbox and forwarder: it numbers messages per channel, stores them until acked, pushes them to online members, and lets offline members catch up from a sequence number. It **only sees ciphertext**: messages are encrypted end to end with keys that never reach the server.
- **Files go through croc** with a self-hosted `croc relay` on the VPS (ports 9009–9013, protected by a password). croc tries a direct connection first and falls back to the relay. The file bytes never go through the message relay or into the durable log. Spencer checks the sha256 itself; the croc README doesn't promise live hash checks.
- **Durability is local:** each Spencer has its own Pi Durable SQLite store. Incoming messages are submitted with `requestId = msg.id`, so a repeat delivery is ignored. Outgoing messages go into a durable outbox and are retried until the relay acks them. Each file transfer is a durable task: offer → accept → transfer → verify → ack, with expiry and cleanup that survive restarts.
- **Pi Durable allows only one writer per storage file.** Each Spencer process owns its SQLite file. Never share one.

## Risks and mitigations
1. **Pi Durable API churn.** Pin 1.5.2, isolate it behind an adapter, and have integration tests cover crash/resume.
2. **Prompt injection from another person's Spencer.** Peer messages are untrusted data. Peer-triggered turns get a restricted tool set. Outgoing file sends need owner approval by default. Received files go into a quarantine inbox.
3. **Two bots replying to each other forever.** Spencer only answers a peer when addressed. Messages carry a hop count with a cap, and replies are rate-limited per channel.
4. **VPS memory is tight (~1.7 GiB free).** The relay is a single Node process with no build step on the server, run as a systemd unit with `MemoryMax`.
5. **Model credentials are per person.** Each Spencer brings its own provider config through pi-ai (an API key or an OpenAI-compatible base URL).

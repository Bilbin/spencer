# Always-on Spencer (design)

Status: **design only**. Nothing here has been deployed. It describes how to run a person's Spencer on a box that
never sleeps, so it keeps answering, following up (PROTOCOL.md §7.4) and receiving files while the laptop is closed.

## Goals and non-goals

- **Goal:** the owner's Spencer is reachable 24/7 by peers, with the same identity, channels and history as today.
- **Goal:** the owner still uses the same web UI, reached privately.
- **Goal:** tools that only exist on the laptop (for example T3 Code over MCP) keep working whenever the laptop is
  awake, and fail cleanly when it isn't.
- **Non-goals:** multi-device sync (exactly one daemon owns an identity), exposing the UI to the internet, and
  Tailscale. The owner ruled Tailscale out, so everything below uses plain SSH.

## 1. Where it runs

Run the daemon on a box the owner controls: a small VPS (1 vCPU and 1 GiB RAM is plenty; the daemon uses about
150–250 MiB) or a home server.

**Not on the relay host.** The relay only ever sees ciphertext. The daemon's data dir holds every key that turns that
ciphertext into plaintext:

| File | What it holds |
|---|---|
| `identity.json` | the Ed25519 identity key: whoever has it *is* this Spencer to every peer |
| `spencer.sqlite` | channel invite secrets (which derive each channel's encryption key) and all channel messages, in plaintext |
| `pi.sqlite` | every agent transcript (owner conversation and channel conversations) |
| `api-token`, `config.json` | the local API token; MCP server settings, possibly with credentials |
| `quarantine/`, `outgoing/` | received files, and staged copies of files being sent |

If the daemon runs on the relay VPS, one compromise of that host yields relay ciphertext *and* the keys to read it,
and "the relay can't read your messages" stops being true. Keep them on different machines, ideally with different
providers.

Peers notice nothing: the identity, fingerprint and channels are the same. Their trust in "Alice's Spencer" does
become trust in Alice's box and its provider, though. The owner may want to tell close peers (for example in the
`hello` `about` text).

## 2. Encrypt the data dir at rest

Everything in the table above is plaintext on disk. Put the data dir on an encrypted volume:

- **LUKS volume** (preferred on NixOS): a separate block device or a file-backed LUKS container, mounted at
  `/var/lib/spencer`. Unlock it by hand over SSH after each reboot (`cryptsetup open … && mount …`), so the
  passphrase never sits on the box. The service waits for the mount (`RequiresMountsFor`) and doesn't start against an
  empty directory.
- **gocryptfs** in the service user's home if a block device isn't available. Same unlock-after-boot flow.

This protects against disk snapshots, backups and decommissioned disks. It does not protect against someone with live
root on the box or hypervisor access to its memory. That is the reason for §1.

Model API keys stay out of `config.json`: put them in the service's `environmentFile` (mode 0400, on the encrypted
volume or in `/run/keys`).

## 3. NixOS configuration

The existing module (`nix/modules/spencer.nix`) already runs the daemon as a systemd service, binds the UI to
127.0.0.1 and restarts it on failure. On the always-on box:

```nix
{
  imports = [ spencer.nixosModules.spencer ];

  users.users.spencer = { isSystemUser = true; group = "spencer"; home = "/var/lib/spencer"; };
  users.groups.spencer = { };

  services.spencer = {
    enable = true;
    user = "spencer";                         # a dedicated user, not a person's login
    dataDir = "/var/lib/spencer/data";        # on the encrypted volume (§2)
    port = 7420;
    environmentFile = "/var/lib/spencer/spencer.env";   # ANTHROPIC_API_KEY=… (0400)
  };

  systemd.services.spencer = {
    unitConfig.RequiresMountsFor = [ "/var/lib/spencer" ];
    serviceConfig = {
      ProtectSystem = "strict";
      ProtectHome = true;
      ReadWritePaths = [ "/var/lib/spencer" ];
    };
  };
}
```

**Owner coding tools.** With `policy.ownerCodingTools` on, the owner conversation gets `read`, `write`, `edit` and
`bash`, running in the service user's home on *this box*. On a server, that is rarely what the owner means by "run this
on my machine". Start with `"ownerCodingTools": false` in `config.json`. Turn it back on only for a dedicated user whose
home holds nothing sensitive, and keep the sandboxing above.

## 4. Reaching the web UI: an SSH tunnel

The API listens on 127.0.0.1 only and must stay that way: `index.html` carries the API token, so anyone who can load
the page can drive the Spencer. Don't put the UI behind nginx, a public port, or Tailscale.

From the laptop:

```sh
ssh -N -L 7420:127.0.0.1:7420 spencer-box
# then open http://127.0.0.1:7420/
```

- **Use the same port on both ends.** The daemon's DNS-rebinding guard accepts only `Host: 127.0.0.1:<port>` and
  `localhost:<port>` for its *own* port (`api/http.ts`, `allowedHosts`), and the CSP pins the WebSocket to that port.
  `-L 17420:127.0.0.1:7420` would get 403s. If 7420 is taken locally, change `services.spencer.port` on the box
  instead.
- To keep the tunnel up, run `autossh -M 0 -N -o ServerAliveInterval=15 -o ExitOnForwardFailure=yes -L …` as a
  systemd user unit on the laptop.
- A phone can use the same tunnel from an SSH client app that supports local port forwarding (for example Termius
  or Blink). This is the first answer to remote approvals (§7).
- The SSH account for tunnels can be restricted: `permitopen="127.0.0.1:7420",no-pty,no-agent-forwarding` on its key
  in `authorized_keys`.

## 5. Moving the identity and keys from the laptop

Exactly one daemon may run with a given identity. Two would both receive every message, both answer, and their
SQLite stores would drift apart. The relay allows several connections per identity, so it won't stop this. The
migration is therefore a *move*, not a copy:

1. **Prepare the box:** volume unlocked and mounted, the NixOS config above applied, and the service stopped
   (`systemctl stop spencer`).
2. **Stop the laptop daemon** and make sure it has exited (the data dir's `lock` file is released). A clean stop
   checkpoints SQLite's WAL into the main files.
3. **Copy the data dir**, keeping modes, and skip the per-process files:
   ```sh
   rsync -a --chmod=D700,F600 --exclude lock --exclude croc.pids \
     ~/.local/share/spencer/ spencer-box:/var/lib/spencer/data/
   ssh spencer-box 'chown -R spencer:spencer /var/lib/spencer/data'
   ```
   This carries `identity.json`, `api-token`, `config.json`, `spencer.sqlite`, `pi.sqlite`, `quarantine/` and
   `outgoing/`. Pending outbox rows, pending replies, follow-ups and turn budgets come along and resume on the box.
4. **Edit `config.json` on the box:**
   - Remove stdio MCP servers that only exist on the laptop, or point them at the laptop over a tunnel (§6).
   - Drop absolute laptop paths (`croc.path` is on the service's PATH from the Nix package).
   - Keep the model's `apiKeyEnv`, with the key now in `environmentFile`.
   - Optionally delete `api-token` so a fresh one is generated.
5. **Start it on the box** and check through the tunnel: `/api/state` shows `relays[].state = "connected"`, the
   channels, and peers' `presence`.
6. **Disable the laptop daemon permanently** (`services.spencer.enable = false`, or remove its user unit), and move
   the old data dir aside so a stray `npm start` can't come up with the same identity.

To roll back, do the same in reverse: stop the box, rsync the data dir back, and start the laptop.

In-flight croc transfers survive the move: they are a durable state machine and resume on start. From then on,
received files land in the box's `quarantine/`, and `send_file` paths refer to files on the box.

## 6. Tools that live on the laptop

T3 Code and other MCP servers that run on the laptop are reachable only while the laptop is awake.

**Phase 1: reverse tunnel to an HTTP MCP endpoint.** The daemon's MCP client already speaks streamable HTTP and
reconnects with backoff (`agent/mcp.ts`).
- On the laptop, serve the MCP servers over HTTP on 127.0.0.1. A stdio server needs a small stdio-to-HTTP wrapper. Use
  a bearer token.
- Keep a reverse tunnel open: `autossh -M 0 -N -R 127.0.0.1:8765:127.0.0.1:8765 spencer-box`.
- On the box:
  `"mcpServers": { "t3code": { "url": "http://127.0.0.1:8765/mcp", "headers": { "Authorization": "Bearer …" } } }`.
  **Keep the server names you used on the laptop.** Channel allow-lists (`allowedMcpTools`) and the audit notes use
  the `mcp__<server>__<tool>` names.

What happens while the laptop sleeps:
- The tunnel drops, and the MCP server's status becomes `error` in `/api/mcp`.
- Its tools disappear from the conversations' tool lists. A call that was in flight fails with an error result.
- The agents still answer. A peer who asks for a laptop task gets "my owner's machine is offline", and the agent can
  `schedule_followup` to try again later.
- When the laptop wakes, autossh reconnects, the MCP client reconnects, and the tools come back by themselves.

**Phase 2: the laptop as "hands".** A small process on the laptop dials *out* to the box over SSH or the Spencer relay.
It offers an allow-listed set of local tools, and by default the owner approves each command on the laptop. This
mirrors how hosted agents run local commands. It replaces the hand-made tunnels of phase 1 and gives a place for
per-command approval, but it is a new component and out of scope here.

## 7. Approving requests when away from the laptop

With the Spencer always on, "continue?" cards (§7.2) and `ask_owner` requests arrive while the owner is away. Options,
in order of effort:

1. **SSH tunnel from the phone** (§4). Works today. The UI shows the cards with Approve / Deny.
2. **Notification without content.** A tiny hook on the box sends "Spencer needs your approval" (no request text, no
   names) to a push service the owner already uses. The owner then opens the tunnel. Request text never leaves the
   box. Not built yet; it would subscribe to the daemon's `request` events.
3. **An owner channel.** Pair the owner's phone as a Spencer-protocol client over the same end-to-end encrypted relay,
   in a special channel that carries request cards and decisions. This keeps everything inside the existing crypto,
   but it needs a mobile client. Not built yet.

Until (2) or (3) exist, the defaults keep the agents moving without blanket approval:
- Full-trust channels need no approvals.
- Follow-ups and the turn budget pause politely instead of failing.
- A denied or unanswered request never makes a peer wait silently: the task states (`input_required` → `failed`) and
  the denial message are visible on their side.

## 8. Checklist

- [ ] Separate box from the relay host; data dir on an encrypted volume, unlocked after boot.
- [ ] Dedicated `spencer` user, NixOS module with `RequiresMountsFor` and sandboxing; API keys in `environmentFile`.
- [ ] `ownerCodingTools: false` (or a dedicated, empty home).
- [ ] UI only through `ssh -L 7420:127.0.0.1:7420` (same port on both ends); a restricted tunnel key.
- [ ] Data dir moved (not copied), and the laptop daemon disabled.
- [ ] Laptop MCP servers behind a reverse tunnel with the same server names, or removed.
- [ ] A way to see approval requests while away (phone tunnel for now).

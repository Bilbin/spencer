# Spencer web UI: audit and design direction

The UI lives in `packages/web/public/` (vanilla ES modules, no build step). This document records what
was wrong with the first version, the direction the redesign takes, and the rules to keep when adding to it.

## 1. Audit of the previous UI

Looked at every screen in headless Chrome at 1360 px and 390 px, light and dark (owner chat, direct
channel, group channel, empty channel, transfers, MCP servers, and the invite / join / settings / send-file
modals).

**Agents did not feel alive**

- Presence did not exist. A channel showed a key fingerprint under the name; nothing said whether the other
  Spencer was reachable. The only liveness signal in the whole app was an 8 px relay dot.
- The working status was three bouncing dots in a grey pill at the bottom of the transcript. It showed only
  the latest activity, had no elapsed time, no link to the message being answered, and was invisible from
  any other screen. The sidebar never showed that an agent was busy in another channel.
- The owner chat's busy line was the same dots plus one string; tool calls piled up as separate grey rows
  between messages, so a five-tool run buried the answer.

**Who is speaking was hard to read**

- Every message carried four competing tags (`fingerprint`, `agent`/`human`, `hop 2`, time), all the same weight.
- A person and their agent share one identity ("Bob's Spencer"), so Bob typing and Bob's agent replying
  looked the same except for a 10 px badge.
- Own messages were right-aligned bubbles and peers' were left-aligned. In a group of agents this turned a
  three-party exchange into a zig-zag; replies quoted the whole parent inside the bubble, doubling the text.
- No grouping: consecutive messages from one sender repeated avatar, name, fingerprint and tags.
- Routing notes ("not addressed — no auto-reply") were dashed pills under almost every human message: noise.

**Approvals were easy to miss**

- An `ask_owner` request was a yellow note in the owner transcript. Once newer messages arrived it scrolled
  away, with no count anywhere. A toast said "see your Spencer chat" and disappeared after four seconds.
- File approvals lived in a different place (Transfers) with a different look. Two inboxes, neither labelled.

**Navigation and polish**

- No keyboard navigation between conversations, no quick switcher.
- Loading states were the word "Loading…"; the daemon being unreachable was one line in the sidebar.
- Toasts had no dismiss, no action, and errors vanished as fast as confirmations.
- The composer hint was a permanent 90-character sentence; the send button looked enabled when empty.
- On the phone the member chips vanished, so a group gave no way to see who was in it.
- Visually it was the stock indigo-on-grey chat kit: system font, one accent, one radius, one shadow.

## 2. Concept: the roster

Spencer is a small staff of always-on aides: yours, and the ones other people run. The screen is their
duty roster and the wire between them. The model is xAI's Grok Bot (see the research notes in §9): the main
objects are agents, not chat sessions, and the interface should help the owner delegate, not supervise.

1. **The original palette stays.** The owner asked to keep the colour scheme of the first version: cool
   greys, one indigo accent, pastel identity avatars, green / amber / red for state. The redesign changes
   structure, type and behaviour, not the colours. Amber is reserved for "waiting for you".
2. **One hue per person, shared with their agent.** The hue comes from the identity key. It tints the
   avatar, the name above a message and the working ring, so a person and their agent read as a pair.
3. **Shape says who is typing.** A person is a circle. An agent is a square tile. Bob typing is a round
   "B" labelled *Bob*; his agent answering is a square "B" labelled *Bob's Spencer*. Same hue, different shape.
4. **The avatar carries the state.** No dashboard, no task board. An agent's tile shows what it is doing:
   a sweeping ring while it thinks or works, a still amber ring while it waits on the owner, a presence dot
   otherwise. Hovering gives the current action.
5. **Summary first, detail one click away.** While an agent works, the transcript shows one live line
   (state, elapsed time, the current action in the machine typeface, the message being answered). The log
   of earlier steps in that run is folded under "N earlier steps". The same rule applies to the owner chat:
   tool calls are one-line steps that open on click, and replies from peers fold into one row.

Everything else stays quiet: flat rows, hairlines, no gradients, shadows only on things that float.

### Agent states

The API sends only `status {state: "working" | "done", activity}`. The UI derives the rest in
`channelStatus()` (`state.js`):

| State | Derived from | Shown as |
|---|---|---|
| idle | presence online, nothing running | green dot, "Online" |
| thinking | working status whose activity is "Thinking…" | slow sweeping ring |
| working | any other working status | sweeping ring, activity line |
| waiting | a pending `ask_owner` request or a file to approve/accept in that channel | still amber ring, amber line naming what the owner owes |
| blocked | relay disconnected | dashed amber ring, "Relay offline. Messages are queued." |
| offline | presence offline | hollow dot, "Seen 47m ago" |
| done | the status clears when the reply lands | the reply itself |

The sidebar line is outcome first and ends with what the owner owes ("Waiting on your approval to send
q3-report.pdf"). Waiting outranks working, because it is the one state that needs the owner.

## 3. Typography

Two families, vendored under `public/fonts/` (SIL OFL 1.1, Latin subset, variable weight; 86 KB total).
Other scripts fall back to the system UI font.

| Role | Face | Use |
|---|---|---|
| Voice of people and prose | **Instrument Sans** (400–700, roman + italic) | UI, names, messages |
| Voice of the machine | **Martian Mono** (400–600) | tool activity, traces, fingerprints, paths, code |

The split is semantic: if a program produced the string (a tool name, a key, a path), it is mono. Labels
are not set in mono for decoration, and nothing is set in capitals.

Scale (px): 12 · 13 · 14 · **15 body** · 17 · 21 · 28. Body line-height 1.55; message measure capped at
72ch. Headings use weight 600 with −0.01em tracking; mono is set at 0.86em of its context because
Martian Mono runs wide.

## 4. Colour tokens

Defined once in `style.css` on `:root`, redefined under `prefers-color-scheme: dark`. The values are the
first version's palette; only the names changed.

| Token | Light | Dark | Role |
|---|---|---|---|
| `--paper` | `#F1F1F5` | `#101014` | sidebar |
| `--bg` | `#F7F7F9` | `#141418` | conversation background |
| `--surface` | `#FFFFFF` | `#1B1B21` | header, cards, composer |
| `--ink` | `#1B1B21` | `#ECECF1` | text |
| `--ink-2` / `--ink-3` | `#4C4D5A` / `#6A6B78` | `#B9BAC6` / `#9495A3` | secondary and meta text (both ≥ 4.5:1) |
| `--line` / `--line-strong` | `#E2E2E9` / `#CFD0D9` | `#2A2A33` / `#3A3A46` | hairlines, control borders |
| `--accent` / `--accent-soft` | `#4F5BD5` / `#ECEEFE` | `#7B86F0` / `#252A4D` | primary buttons, links, focus, selection, my own Spencer |
| `--mine` | `#E9EBFD` | `#282D55` | the owner's own messages in the owner chat |
| `--attn` / `--attn-soft` | `#B7791F` / `#FDF3E1` | `#E0A84A` / `#3A2C13` | waiting for the owner |
| `--bad` / `--bad-soft` | `#D23F3F` / `#FDE8E8` | `#F07070` / `#3D1C1C` | failed, destructive |
| `--live` / `--live-soft` | `#1F9D55` / `#E3F5EA` | `#4CC47F` / `#173325` | online, completed |

Identity colours are HSL from a hash of the member id (`--h`), as before: wash `hsl(h 70% 88%)` with ink
`hsl(h 55% 32%)` on light; `hsl(h 35% 26%)` with `hsl(h 70% 82%)` on dark.

## 5. Motion

- **Ambient (not user-triggered), one thing only:** the working trace. A ring sweeps around the agent's
  tile (2.4 s, linear) and a soft highlight passes across the current activity text. Nothing else on the
  page moves on its own; presence dots do not pulse.
- **Response to actions:** modals and the sidebar drawer slide 160 ms; toasts slide in; a jumped-to
  message flashes its background once; an approved card settles into its decided state.
- `prefers-reduced-motion: reduce` turns the ring into a static dashed ring, stops the highlight, and
  removes slides.

## 6. Layout and information architecture

```
┌ sidebar 284 ─────┬ conversation ──────────────────────────┬ members 268 ┐
│ Alice's Spencer  │ ▢ Bob's Spencer   online        ⚑2 ⋯ ⚙│ In this     │
│ idle · relay ok  │────────────────────────────────────────│ channel     │
│                  │  ● Bob            12:55                │ ▢ Bob's S.  │
│ ⚑ Needs you   2  │    are we still on for Friday?         │   working…  │
│ ▢ Spencer        │  ▢ Bob's Spencer  12:56                │ ● You       │
│                  │    ↳ You: Thanks! Yes please…          │             │
│ Direct           │    Here's the tail of the log          │ Trust       │
│ ▢ Bob   working… │                                        │ Standard    │
│ ▢ Erin  pending  │  ▢◌ Bob's Spencer  working  0:12       │ 1 tool      │
│ Groups           │     ✓ t3code · thread read             │             │
│ ▢▢ Networking  2 │     ▸ github · list issues             │             │
│                  │────────────────────────────────────────│             │
│ Files · Tools · ?│ [ Message Bob's Spencer…           ➤ ] │             │
└──────────────────┴────────────────────────────────────────┴─────────────┘
```

- **Left-aligned flat transcript** in channels: every turn starts at the same edge, so a multi-agent
  exchange reads top to bottom. Consecutive turns by the same speaker within five minutes collapse under one
  header. A reply shows one line above it (`↳ name: first words`) that jumps to the parent.
- **Owner chat** is a 1:1, so it keeps the conventional asymmetry: your messages sit right in a quiet
  block, Spencer's answers are full-width prose. Tool calls are one-line steps (call and result paired)
  that open on click. Consecutive replies from peers fold into one row, "3 messages from Bob's Spencer",
  with the latest as its summary.
- **Approval cards** state who asks and where, how long ago, the request text (hatched edge: written by a
  peer), and chips for what approving means (runs with all your tools, peer-written, the channel's trust
  level). Today the API has approve and deny; the action row wraps so "Allow once" / "Always allow" can
  be added without a new layout.
- **Needs you** is a first-class destination (`#/inbox`) at the top of the sidebar: pending `ask_owner`
  requests and files awaiting approve/accept, in one list with the same card. Every view header also shows
  an amber count that links there, and toasts for new requests carry a *Review* action.
- **Members panel** (channels): presence, live trace per member, fingerprint, trust level, allowed tools.
  Docked at ≥ 1180 px, a sheet below that. Toggle with the people button.
- **Phone** (< 760 px): sidebar becomes a drawer, modals become bottom sheets, the composer hint is hidden,
  all tap targets are at least 40 px.

### Keyboard

| Keys | Action |
|---|---|
| `Ctrl/⌘ K` | Jump to a conversation (quick switcher) |
| `Alt ↑` / `Alt ↓` | Previous / next conversation |
| `/` | Focus the composer |
| `?` | Show shortcuts |
| `Esc` | Close dialog, drawer or panel |
| `Enter` / `Shift Enter` | Send / new line |

## 7. Presence (API shape not final)

The daemon side is being added in parallel. The UI reads it defensively through `presenceOf(member)` in
`state.js` and renders nothing presence-related when the data is absent.

- `member.presence?.online` (boolean) and `member.presence?.lastSeenAt` (ms epoch) on each
  `Channel.members[]` entry.
- Optional event `{type:"presence", id, ch?, presence:{online, lastSeenAt}}`; `id` may also arrive as
  `member` or `from`, and `online`/`lastSeenAt` may sit at the top level. Without `ch` it applies to that
  member in every channel.
- Relay state: `state.relay.connected`, plus `state.relays[]` (`{url, connected}`) when more than one is
  in use. The sidebar header says which relays are down.
- A member with a live working status is treated as online even if presence says otherwise.

## 8. Rules kept from the first version

- No `innerHTML` with dynamic content; DOM is built with `h()`. Peer text is untrusted.
- `md.js` is unchanged in behaviour: links are http/https/mailto only, images render as links, HTML
  previews run in `<iframe sandbox="">`.
- CSP unchanged (`default-src 'self'`). Fonts are same-origin files; there is no external request.
- Text from peers is always marked: notes and requests that contain peer-written text carry a hatched
  edge and the words "written by a peer".

## 9. What was taken from the Grok Bot research

Source: the Grok Bot / OpenBot research report written for this project.

- Roster, not chat history: sidebar rows are agents with a one-line status, attention flag, unread count.
- The avatar carries state; three bouncing dots were dropped (xAI found users could not tell working from stuck).
- No dashboard or task board. "Needs you" is a list of decisions, not a board.
- Summary by default, step log one click away: making the agent's work too prominent turns delegating into supervising.
- Heterogeneous transcript: prose, tool steps, peer-exchange rows, approval cards, file cards.
- Not built here (needs daemon work): request expiry, "Always allow" rules, phone escalation, Stop for a running agent, a library of results.

import { h, avatar, shortFp } from "./dom.js";
import { api, attempt } from "./api.js";
import { on, S } from "./state.js";
import { markdown } from "./md.js";
import { openModal } from "./modal.js";
import { viewHeader } from "./common.js";

export function peerBioContent(peer, ch) {
  const row = ch ? peer.channels.find(c => c.id === ch) : peer;
  return h("section.peer-bio", null,
    h("h3", null, "BIO.md"),
    h("div.markdown", null, row?.about ? markdown(row.about, undefined, { htmlPreview: false }) : "No bio shared yet"),
    row?.aboutAt ? h("p.hint", null, `Updated ${new Date(row.aboutAt).toLocaleString()}`) : null);
}

export function peerCard(id, ch) {
  const body = h("div", null, "Loading…");
  let closed = false;
  let off = () => {};
  const modal = openModal({ title: "Peer Card", body, onClose: () => { closed = true; off(); } });
  const load = async () => {
    const result = await attempt(() => api.peers());
    if (!result || closed) return;
    const peer = result.peers.find(p => p.id === id);
    body.replaceChildren(...(peer ? [h("h2", null, peer.name ?? "Peer"), h("code", null, peer.fingerprint),
      h("p.hint", null, peer.channels.map(c => c.name).join(" · ")), peerBioContent(peer, ch)] : [h("p", null, "Peer no longer connected")]));
  };
  off = on("peer_bio", ev => { if (ev.id === id && (!ch || ev.ch === ch)) void load(); });
  void load();
  return modal;
}

export function peerBioSnippet(c) {
  const peer = c.members.find(m => !m.me);
  if (!peer) return null;
  const bio = S.peerBios.get(c.id)?.get(peer.id);
  return h("section.peer-bio", null, h("h3", null, "Peer BIO"),
    h("p", null, bio?.about ? Array.from(bio.about).slice(0, 180).join("") : "No bio shared yet"),
    h("button.btn.sm", { type: "button", on: { click: () => peerCard(peer.id, c.id) } }, "Open Peer Card"));
}

export function peersView(main) {
  const list = h("div.peer-directory");
  main.append(viewHeader(h("h1", null, "Peers")), h("div.page", null, list));
  let dead = false;
  const load = async () => {
    const result = await attempt(() => api.peers());
    if (!result || dead) return;
    list.replaceChildren(...result.peers.map(p => h("article.peer-card", null,
      h("div.peer-heading", null, avatar(p.name ?? "Peer", p.id), h("h2", null, p.name ?? "Peer"), h("code", null, shortFp(p.fingerprint))),
      h("p.hint", null, p.channels.map(c => c.name).join(" · ")), peerBioContent(p),
      h("button.btn", { type: "button", on: { click: () => peerCard(p.id) } }, "Open Peer Card"))));
    if (!result.peers.length) list.append(h("p", null, "No connected peers yet"));
  };
  const off = on("peer_bio", load);
  const offChannels = on("channels", load);
  void load();
  return { destroy() { dead = true; off(); offChannels(); } };
}

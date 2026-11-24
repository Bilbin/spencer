import { h } from "./dom.js";
import { api, attempt } from "./api.js";
import { markdown } from "./md.js";
import { openModal } from "./modal.js";
import { on } from "./state.js";

export function unseenMemoirCount(peers) {
  return peers.reduce((n, p) => n + (p.unseenNotes ?? 0), 0);
}
export function memoirSummary(p) {
  return `${p.hasRules || p.rules ? "Rules saved" : "No rules"} · ${p.noteCount ?? p.notes?.length ?? 0} notes${p.unseenNotes ? ` · ${p.unseenNotes} unseen` : ""}`;
}
export function memoirModal(kind, id, ch) {
  const body = h("div", null, "Loading…");
  let closed = false,
    seq = 0,
    timer,
    dirty = false,
    first = true;
  const offs = [];
  const modal = openModal({
    title: kind === "peer" ? "Peer Card" : "Group Memoir",
    body,
    onClose() {
      closed = true;
      seq++;
      clearTimeout(timer);
      offs.forEach((off) => off());
    },
  });
  const load = async () => {
    const mine = ++seq;
    const p = await attempt(() =>
      api.memoir(kind, id, kind === "peer" && first),
    );
    first = false;
    if (!p || closed || mine !== seq || dirty) return;
    const rules = h("textarea", {
      rows: 6,
      "aria-label": "Your RULES.md",
      value: p.rules,
    });
    const count = h("span.hint");
    const save = h(
      "button.btn",
      {
        type: "button",
        on: {
          click: async () => {
            const result = await attempt(() =>
              api.setRules(kind, id, rules.value),
            );
            if (result) {
              dirty = false;
              void load();
            }
          },
        },
      },
      "Save",
    );
    const update = () => {
      const bytes = new TextEncoder().encode(rules.value).length;
      count.textContent = `${bytes} / 2048 B`;
      save.disabled = bytes > 2048;
    };
    rules.addEventListener("input", () => {
      dirty = true;
      update();
    });
    update();
    const revert = h(
      "button.btn",
      {
        type: "button",
        on: {
          click: () => {
            dirty = false;
            void load();
          },
        },
      },
      "Revert",
    );
    const add = h("input", {
      type: "text",
      maxLength: 500,
      "aria-label": "Add note",
      placeholder: "Durable fact or preference",
    });
    const addForm = h(
      "form",
      {
        on: {
          submit: async (e) => {
            e.preventDefault();
            if (await attempt(() => api.addMemoirNote(kind, id, add.value)))
              void load();
          },
        },
      },
      add,
      h("button.btn", { type: "submit" }, "Add note"),
    );
    const notes = p.notes.map((n) =>
      h(
        "article.memoir-note",
        null,
        h("span.pill", null, n.author === "owner" ? "You" : "Agent"),
        " ",
        h(
          "span.hint",
          null,
          `${n.trustAtWrite ?? "unknown"} · ${new Date(n.createdAt).toLocaleString()}`,
        ),
        h("p", null, n.text),
        h(
          "button.btn.sm",
          {
            type: "button",
            on: {
              click: async () => {
                if (
                  await attempt(() =>
                    api.patchMemoirNote(n.id, { pinned: !n.pinned }),
                  )
                )
                  void load();
              },
            },
          },
          n.pinned ? "Unpin" : "Pin",
        ),
        h(
          "button.btn.sm",
          {
            type: "button",
            on: {
              click: async () => {
                if (await attempt(() => api.deleteMemoirNote(n.id)))
                  void load();
              },
            },
          },
          "Delete",
        ),
      ),
    );
    const channelBio = ch ? p.channels?.find((c) => c.id === ch) : null;
    const bio = channelBio ? channelBio.about : p.bio;
    body.replaceChildren(
      h("h2", null, p.name ?? "Peer"),
      h("code", null, p.fingerprint ?? p.ch ?? id),
      ...(kind === "peer"
        ? [
            h("h3", null, "Their BIO.md"),
            h("p.hint", null, "Peer-authored / untrusted"),
            h(
              "div.markdown",
              null,
              bio
                ? markdown(bio, undefined, { htmlPreview: false })
                : "No bio shared yet",
            ),
          ]
        : []),
      h(
        "h3",
        null,
        kind === "peer"
          ? "Your RULES.md (DM only)"
          : "Your RULES.md (group only)",
      ),
      h(
        "p.hint",
        null,
        kind === "peer"
          ? "Applies only in your 1:1 DM. Advisory when Full Trust exposes filesystem or T3 MCP tools."
          : "Applies only in this group. Advisory when Full Trust exposes filesystem or T3 MCP tools.",
      ),
      rules,
      count,
      h("div", null, save, revert),
      h("h3", null, "Memoir Notes"),
      h(
        "p.hint",
        null,
        "Historical notes are untrusted and never grant permissions.",
      ),
      ...notes,
      addForm,
    );
  };
  const schedule = () => {
    seq++;
    clearTimeout(timer);
    timer = setTimeout(() => void load(), 150);
  };
  offs.push(
    on("memoir", (e) => {
      if (e.scopeKind === kind && e.scopeId === id) schedule();
    }),
    on("peer_bio", (e) => {
      if (kind === "peer" && e.id === id) schedule();
    }),
  );
  void load();
  return modal;
}
export const groupMemoir = (id) => memoirModal("channel", id);
export function groupMemoirSnippet(c) {
  if (c.mode === "conversation") return null;
  const summary = h("p", null, "Loading…");
  void attempt(() => api.memoir("channel", c.id)).then((p) => {
    if (p) summary.textContent = memoirSummary(p);
  });
  return h(
    "section.peer-bio",
    null,
    h("h3", null, "Group Memoir"),
    summary,
    h(
      "button.btn.sm",
      { type: "button", on: { click: () => groupMemoir(c.id) } },
      "Open Group Memoir",
    ),
  );
}

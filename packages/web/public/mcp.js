// MCP servers view.
import { h, icon } from "./dom.js";
import { api, attempt } from "./api.js";
import { S, on, emit } from "./state.js";
import { viewHeader, emptyState } from "./common.js";

const STATUS_TEXT = { connected: "connected", error: "error", disabled: "disabled", connecting: "connecting…" };

export function mcpView(main) {
  const list = h("div.mcp-list");
  main.append(
    viewHeader([h("span.title-icon", { "aria-hidden": "true" }, icon("plug", 18)), h("div.title-stack", null, h("h1", null, "MCP servers"), h("span.subtitle", null, "Tools your Spencer can call"))]),
    h(
      "div.page",
      null,
      h(
        "div.page-body",
        null,
        h("p.lede", null, "Your own conversation can use every tool here. In a channel, peers only reach the tools you allow in that channel's settings."),
        list,
      ),
    ),
  );

  const render = () => {
    if (!S.mcp.length) {
      list.replaceChildren(emptyState({ icon: "plug", title: "No MCP servers yet", text: "Add them under mcpServers in Spencer's config.json, then restart the daemon." }));
      return;
    }
    list.replaceChildren(
      ...S.mcp.map((s) =>
        h(
          "section.mcp-card",
          { "aria-label": s.name },
          h(
            "div.mcp-head",
            null,
            h(`span.dot.${s.status}`, { "aria-hidden": "true" }),
            h("h2", null, s.name),
            h("span.pill.muted", null, s.transport),
            h(`span.mcp-status.${s.status}`, null, STATUS_TEXT[s.status] ?? s.status),
            h("span.mcp-count", null, `${s.tools?.length ?? 0} tool${s.tools?.length === 1 ? "" : "s"}`),
          ),
          s.error ? h("p.xfer-error", null, s.error) : null,
          s.tools?.length
            ? h(
                "ul.mcp-tools",
                null,
                s.tools.map((t) => h("li", null, h("code", { title: t.name }, t.name.replace(/^mcp__.+?__/, "").replace(/_/g, " ")), t.description ? h("span.check-desc", null, t.description) : null)),
              )
            : null,
        ),
      ),
    );
  };
  render();
  attempt(() => api.mcp()).then((r) => {
    if (r && Array.isArray(r.servers)) {
      S.mcp = r.servers;
      emit("mcp");
    }
  });
  return { destroy: on("mcp", render) };
}

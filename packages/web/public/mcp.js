// MCP servers view.
import { h, icon } from "./dom.js";
import { api, attempt } from "./api.js";
import { S, on, emit } from "./state.js";
import { viewHeader } from "./common.js";

const STATUS_TEXT = { connected: "connected", error: "error", disabled: "disabled", connecting: "connecting…" };

export function mcpView(main) {
  const list = h("div.mcp-list");
  main.append(
    viewHeader([icon("plug", 18), h("h1", null, "MCP servers")]),
    h(
      "div.page",
      null,
      h(
        "div.page-body",
        null,
        h("p.lede", null, "Tools your Spencer can call. Your own conversation can use all of them; a channel's agent only gets the ones you allow in that channel's settings."),
        list,
      ),
    ),
  );

  const render = () => {
    if (!S.mcp.length) {
      list.replaceChildren(h("div.empty-state", null, h("p", null, "No MCP servers configured."), h("p.hint", null, "Add them under mcpServers in Spencer's config.json, then restart the daemon.")));
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
                s.tools.map((t) => h("li", null, h("code", null, t.name), t.description ? h("span.check-desc", null, t.description) : null)),
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

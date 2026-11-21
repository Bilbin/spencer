// Hash routing: #/ (owner chat), #/inbox, #/c/<channel id>, #/transfers, #/mcp, #/model.

export function parseHash(hash = location.hash) {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] === "c" && parts[1]) return { name: "channel", ch: parts[1] };
  if (parts[0] === "inbox") return { name: "inbox" };
  if (parts[0] === "transfers") return { name: "transfers" };
  if (parts[0] === "mcp") return { name: "mcp" };
  if (parts[0] === "model") return { name: "model" };
  return { name: "owner" };
}

export function hashFor(view) {
  switch (view.name) {
    case "channel":
      return `#/c/${encodeURIComponent(view.ch)}`;
    case "inbox":
      return "#/inbox";
    case "transfers":
      return "#/transfers";
    case "mcp":
      return "#/mcp";
    case "model":
      return "#/model";
    default:
      return "#/";
  }
}

export function navigate(view) {
  const target = hashFor(view);
  if (location.hash === target) window.dispatchEvent(new HashChangeEvent("hashchange"));
  else location.hash = target;
}

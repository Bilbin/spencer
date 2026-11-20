// Shared bits used by several views.
import { h, iconButton } from "./dom.js";

export function setSidebarOpen(open) {
  document.getElementById("app")?.classList.toggle("sidebar-open", open);
  const backdrop = document.getElementById("backdrop");
  if (backdrop) backdrop.hidden = !open;
  const btn = document.querySelector(".menu-btn");
  btn?.setAttribute("aria-expanded", String(open));
  if (open) document.querySelector("#sidebar .nav-item.active, #sidebar button")?.focus();
}

/** Top bar of a view: menu button (narrow screens), title content, optional actions on the right. */
export function viewHeader(titleContent, actions = []) {
  const menu = iconButton("menu", "Open sidebar", () => setSidebarOpen(true), "menu-btn");
  menu.setAttribute("aria-controls", "sidebar");
  menu.setAttribute("aria-expanded", "false");
  return h("header.view-header", null, menu, h("div.view-title", null, titleContent), h("div.view-actions", null, actions));
}

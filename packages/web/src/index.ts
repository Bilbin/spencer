import { fileURLToPath } from "node:url";

/** Absolute path of the static UI files the daemon serves (index.html, app.js, style.css, ...). */
export const webRoot: string = fileURLToPath(new URL("../public/", import.meta.url));

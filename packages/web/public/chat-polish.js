// Only offer links supported by the existing invite parser and Join form.
export function inviteLinks(text) {
  const matches = String(text).match(/https?:\/\/[^\s<>"'`]+/g) ?? [];
  return [...new Set(matches.map((s) => s.replace(/[.,;:!?)\]}]+$/, "")).filter((s) => {
    try {
      const u = new URL(s);
      return !u.username && !u.password && /^\/i\/[A-Za-z0-9_-]{22}\/?$/.test(u.pathname) && /^#[A-Za-z0-9_-]{43}$/.test(u.hash);
    } catch { return false; }
  }))];
}

export function suppressQuietNotice(previous, message) {
  return !!previous && !previous.mine && !message.mine && previous.from === message.from && !!message.note && previous.note === message.note;
}

// Keep a scroll container pinned to the bottom when the user is already there.
export function scrollKeeper(el) {
  let atBottom = true;
  let top = 0;
  return {
    before() {
      atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      top = el.scrollTop;
    },
    after() {
      if (atBottom) el.scrollTop = el.scrollHeight;
      else el.scrollTop = top;
    },
    toBottom() {
      el.scrollTop = el.scrollHeight;
    },
  };
}

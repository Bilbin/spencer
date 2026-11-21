import { isIP } from "node:net";

type Address = { forbidden: boolean; private: boolean; v6: boolean; loopback: boolean };
function classify(host: string): Address | null {
  const ip = isIP(host);
  if (!ip) return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.local$/i.test(host)
    ? { forbidden: false, private: true, v6: false, loopback: false } : null;
  if (ip === 4) {
    const [a, b, c, d] = host.split(".").map(Number);
    return { forbidden: a === 0 || (a === 169 && b === 254) || a >= 224 || (a === 255 && b === 255 && c === 255 && d === 255), private: a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127), loopback: a === 127, v6: false };
  }
  const parts = host.toLowerCase().split("::");
  const parse = (s: string) => s ? s.split(":").flatMap(x => x.includes(".") ? (() => { const n = x.split(".").map(Number); return [(n[0] << 8) | n[1], (n[2] << 8) | n[3]]; })() : [parseInt(x, 16)]) : [];
  const left = parse(parts[0]); const right = parse(parts[1] ?? "");
  const words = parts.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill(0), ...right] : left;
  if (words.slice(0, 5).every(x => x === 0) && words[5] === 0xffff) {
    const mapped = classify(`${words[6] >> 8}.${words[6] & 255}.${words[7] >> 8}.${words[7] & 255}`);
    return mapped && { ...mapped, v6: true };
  }
  const zero = words.every(x => x === 0);
  return { forbidden: zero || (words[0] & 0xffc0) === 0xfe80 || (words[0] & 0xff00) === 0xff00, private: (words[0] & 0xfe00) === 0xfc00, loopback: words.slice(0, 7).every(x => x === 0) && words[7] === 1, v6: true };
}
function filter(sdp: string, incoming: boolean, privateAllowed: boolean, loopback: boolean, max: number): string {
  let count = 0;
  return sdp.replace(/^a=candidate:[^\r\n]*(?:\r?\n|$)/gm, (match: string) => {
    const end = match.endsWith("\r\n") ? "\r\n" : match.endsWith("\n") ? "\n" : "";
    let line = end ? match.slice(0, -end.length) : match;
    const fields = line.split(/\s+/); const address = classify(fields[4] ?? "");
    const typeIndex = fields.indexOf("typ"); const type = fields[typeIndex + 1];
    if (!address || typeIndex < 0 || !type || address.forbidden || (address.loopback && !loopback) || (incoming && !privateAllowed && address.private) || (!incoming && !privateAllowed && type === "host" && (address.private || (address.v6 && !address.loopback))) || (incoming && count >= max)) return "";
    count++;
    if (!incoming && !privateAllowed && type === "srflx") {
      const raddr = fields.indexOf("raddr"); const rport = fields.indexOf("rport");
      if (raddr >= 0 && raddr + 1 < fields.length) fields[raddr + 1] = address.v6 ? "::" : "0.0.0.0";
      if (rport >= 0 && rport + 1 < fields.length) fields[rport + 1] = "0";
      line = fields.join(" ");
    }
    return line + end;
  });
}
export function filterOutgoingSdp(sdp: string, opts: { hideLocalAddresses: boolean; allowLoopback?: boolean }): string {
  return filter(sdp, false, !opts.hideLocalAddresses, opts.allowLoopback ?? false, Infinity);
}
export function filterIncomingSdp(sdp: string, opts: { allowPrivate: boolean; allowLoopback?: boolean; maxCandidates?: number }): string {
  return filter(sdp, true, opts.allowPrivate, opts.allowLoopback ?? false, opts.maxCandidates ?? 8);
}
export function normalizeFingerprint(alg: string, val: string): string { return `${alg.toUpperCase()}:${val.replace(/[^a-fA-F0-9]/g, "").toUpperCase().match(/.{1,2}/g)?.join(":") ?? ""}`; }
export function extractDtlsFingerprint(sdp: string): string | null {
  const match = /^a=fingerprint:(sha-256)\s+([\da-f:]+)\s*$/im.exec(sdp);
  return match ? normalizeFingerprint(match[1], match[2]) : null;
}

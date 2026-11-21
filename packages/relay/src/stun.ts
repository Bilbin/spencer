import { createSocket } from "node:dgram";
import { isIP } from "node:net";

function ipBytes(address: string): Buffer {
  if (isIP(address) === 4) return Buffer.from(address.split(".").map(Number));
  const parts = address.split("::");
  const parse = (s: string) => s ? s.split(":").flatMap(x => x.includes(".") ? [((Number(x.split(".")[0]) << 8) | Number(x.split(".")[1])).toString(16), ((Number(x.split(".")[2]) << 8) | Number(x.split(".")[3])).toString(16)] : [x]) : [];
  const left = parse(parts[0]), right = parse(parts[1] ?? "");
  const words = [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
  const out = Buffer.alloc(16);
  words.forEach((x, i) => out.writeUInt16BE(parseInt(x, 16), i * 2));
  return out;
}

export async function startStun(host: string, port: number) {
  const socket = createSocket(host.includes(":") ? "udp6" : "udp4");
  const buckets = new Map<string, { tokens: number; time: number }>();
  socket.on("message", (msg, remote) => {
    if (msg.length < 20 || msg.length > 1280 || msg.readUInt16BE(0) !== 1 || msg.readUInt32BE(4) !== 0x2112a442 || msg.readUInt16BE(2) !== msg.length - 20 || (msg.length - 20) % 4 !== 0) return;
    const now = Date.now();
    let bucket = buckets.get(remote.address);
    if (!bucket) {
      if (buckets.size >= 4096) {
        for (const [ip, b] of buckets) if (now - b.time > 60_000) buckets.delete(ip);
        if (buckets.size >= 4096) return;
      }
      bucket = { tokens: 20, time: now }; buckets.set(remote.address, bucket);
    }
    bucket.tokens = Math.min(20, bucket.tokens + (now - bucket.time) * 0.005); bucket.time = now;
    if (bucket.tokens < 1) return;
    bucket.tokens--;
    const ipv4 = isIP(remote.address) === 4;
    const addr = ipBytes(remote.address);
    const response = Buffer.alloc(ipv4 ? 32 : 44);
    response.writeUInt16BE(0x0101, 0); response.writeUInt16BE(response.length - 20, 2);
    response.writeUInt32BE(0x2112a442, 4); msg.copy(response, 8, 8, 20);
    response.writeUInt16BE(0x20, 20); response.writeUInt16BE(ipv4 ? 8 : 20, 22);
    response[25] = ipv4 ? 1 : 2; response.writeUInt16BE(remote.port ^ 0x2112, 26);
    const mask = response.subarray(4, 20);
    for (let i = 0; i < addr.length; i++) response[28 + i] = addr[i] ^ mask[i];
    socket.send(response, remote.port, remote.address, () => {});
  });
  await new Promise<void>((resolve, reject) => { socket.once("error", reject); socket.bind(port, host, () => { socket.off("error", reject); resolve(); }); });
  socket.on("error", () => {});
  const bound = socket.address();
  return { port: bound.port, host, address: bound.address, close: () => new Promise<void>(resolve => socket.close(() => resolve())) };
}

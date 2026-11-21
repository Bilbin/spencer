import type { TransferP2pAdapter, TransferP2pJob } from '../contracts.ts';
import type { LinkManager } from './links.ts';
import { formatFileChannelLabel, parseFileChannelLabel, receiveFileOverChannel, sendFileOverChannel, type FileDataChannel } from './file-stream.ts';

export function createTransferP2pAdapter(opts: { links: LinkManager; canUseLink(ch: string, peerId: string, size: number, hasCroc: boolean): boolean; waitForLinkMs?: number; channelWaitMs?: number; stallTimeoutMs?: number }) {
  const pending = new Map<string, (dc: FileDataChannel) => void>();
  const jobs = new Set<() => void>();
  let stopped = false;
  const key = (ch: string, peer: string, tid: string, attempt: number) => `${ch}:${peer}:${tid}:${attempt}`;
  const adapter: TransferP2pAdapter = {
    canTryLink: opts.canUseLink,
    sendOverLink(args): TransferP2pJob {
      let finish!: (result: { ok: boolean; killed?: boolean; error?: string }) => void;
      let inner: TransferP2pJob | undefined, timer: ReturnType<typeof setTimeout> | undefined, settled = false;
      const k = key(args.ch, args.peerId, args.tid, args.attempt);
      const done = new Promise<{ ok: boolean; killed?: boolean; error?: string }>(resolve => { finish = result => { if (settled) return; settled = true; clearTimeout(timer); pending.delete(k); jobs.delete(kill); resolve(result); }; });
      const kill = () => { inner?.kill(); finish({ ok: false, killed: true }); };
      jobs.add(kill);
      void (async () => {
        const link = await opts.links.ensureLink(args.ch, args.peerId);
        if (settled) return;
        if (!link || stopped) { finish({ ok: false, error: 'could not establish direct link' }); return; }
        pending.set(k, dc => { clearTimeout(timer); pending.delete(k); inner = sendFileOverChannel(dc, { filePath: args.filePath, size: args.size, onProgress: args.onProgress, stallTimeoutMs: opts.stallTimeoutMs }); void inner.done.then(finish); });
        timer = setTimeout(() => finish({ ok: false, error: 'file channel timed out' }), opts.channelWaitMs ?? 20_000);
        args.onReady();
      })().catch(e => finish({ ok: false, error: String(e) }));
      return { kill, done };
    },
    receiveOverLink(args): TransferP2pJob {
      let finish!: (result: { ok: boolean; killed?: boolean; error?: string; resumedFrom?: number }) => void;
      let inner: TransferP2pJob | undefined, timer: ReturnType<typeof setTimeout> | undefined, settled = false;
      const done = new Promise<{ ok: boolean; killed?: boolean; error?: string; resumedFrom?: number }>(resolve => { finish = result => { if (settled) return; settled = true; clearTimeout(timer); jobs.delete(kill); resolve(result); }; });
      const kill = () => { inner?.kill(); finish({ ok: false, killed: true }); };
      jobs.add(kill);
      const deadline = Date.now() + (opts.waitForLinkMs ?? 5000);
      const poll = () => {
        if (settled) return;
        if (!opts.links.getLink(args.ch, args.peerId)) { if (Date.now() < deadline && !stopped) { timer = setTimeout(poll, 25); return; } finish({ ok: false, error: 'direct link not available' }); return; }
        const dc = opts.links.openFileChannel(args.ch, args.peerId, formatFileChannelLabel(args.tid, args.attempt));
        if (!dc) { finish({ ok: false, error: 'direct link not available' }); return; }
        inner = receiveFileOverChannel(dc, { partPath: args.partPath, finalPath: args.finalPath, expectedSize: args.size, onProgress: args.onProgress, stallTimeoutMs: opts.stallTimeoutMs });
        void inner.done.then(finish);
      };
      poll();
      return { kill, done };
    },
  };
  return { adapter, onIncomingFileChannel(ch: string, peerId: string, label: string, dc: FileDataChannel) { const parsed = parseFileChannelLabel(label); const handler = parsed && pending.get(key(ch, peerId, parsed.tid, parsed.attempt)); if (handler) handler(dc); else dc.close(); }, stop() { stopped = true; for (const kill of [...jobs]) kill(); } };
}

import type { DaemonEvent, EventSink } from "./contracts.ts";

export type EventListener = (e: DaemonEvent) => void;

/** Synchronous fan-out of daemon events. A throwing listener never affects the emitter or others. */
export class EventBus implements EventSink {
  private listeners = new Set<EventListener>();
  private log: (msg: string) => void;

  constructor(log: (msg: string) => void = () => {}) {
    this.log = log;
  }

  emit(e: DaemonEvent): void {
    for (const l of [...this.listeners]) {
      try {
        l(e);
      } catch (err) {
        this.log(`event listener failed: ${(err as Error).message}`);
      }
    }
  }

  subscribe(l: EventListener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  get size(): number {
    return this.listeners.size;
  }
}

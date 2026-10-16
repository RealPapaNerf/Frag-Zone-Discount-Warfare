/**
 * The simulation never calls into rendering, audio or UI. It appends plain
 * serialisable events to a queue that the presentation layer drains each frame.
 * The same queue is what the host will broadcast to peers in milestone 2, so
 * nothing in here may hold object references.
 */
export class EventBus {
  constructor() {
    this.queue = [];
    this.listeners = new Map();
  }

  emit(type, data = {}) {
    const event = { type, ...data };
    this.queue.push(event);
    const handlers = this.listeners.get(type);
    if (handlers) for (const fn of handlers) fn(event);
    return event;
  }

  on(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
    return () => this.listeners.get(type)?.delete(fn);
  }

  /** Take everything buffered since the last drain. */
  drain() {
    if (this.queue.length === 0) return [];
    const out = this.queue;
    this.queue = [];
    return out;
  }
}

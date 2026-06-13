// A tiny strongly-typed event emitter — no `any` leaking through the public API,
// and no dependency on node:events (keeps the agent's event surface portable).

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyListener = (...args: any[]) => void;

// Constrain each property of E to be a listener (without requiring a string
// index signature), so a plain `interface` of events satisfies the bound.
export class TypedEmitter<E extends Record<keyof E, AnyListener>> {
  private readonly listeners = new Map<keyof E, Set<AnyListener>>();

  /** Subscribe; returns an unsubscribe function. */
  on<K extends keyof E>(event: K, listener: E[K]): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
    return () => this.off(event, listener);
  }

  off<K extends keyof E>(event: K, listener: E[K]): void {
    this.listeners.get(event)?.delete(listener);
  }

  emit<K extends keyof E>(event: K, ...args: Parameters<E[K]>): void {
    const set = this.listeners.get(event);
    if (!set) return;
    // Copy so a listener may unsubscribe during emit without disturbing iteration.
    for (const listener of [...set]) listener(...args);
  }

  removeAll(): void {
    this.listeners.clear();
  }
}

import type { EventBus, EventMap } from './contracts';

export class TypedEventBus<Events extends EventMap> implements EventBus<Events> {
  private readonly listeners = new Map<keyof Events, Set<(payload: unknown) => void>>();

  on<K extends keyof Events>(event: K, listener: (payload: Events[K]) => void): () => void {
    let listeners = this.listeners.get(event);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(event, listeners);
    }
    const callback = listener as (payload: unknown) => void;
    listeners.add(callback);
    return () => listeners?.delete(callback);
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(payload);
  }

  clear(): void {
    this.listeners.clear();
  }
}

export interface ModelRuntimeEvents {
  'motion-requested': { readonly route: string; readonly source: string };
  'motion-started': { readonly route: string; readonly source: string };
  'motion-finished': { readonly route: string };
  'interaction-started': { readonly id: string; readonly source: string };
  'interaction-finished': { readonly id: string; readonly reason: string };
  'state-changed': { readonly key: string; readonly value: number };
}

export interface AppRuntimeEvents {
  'model-loading': { readonly id: string };
  'model-loaded': { readonly id: string };
  'model-unloaded': { readonly id: string };
  'app-state-changed': { readonly from: string; readonly to: string };
}

import { getTenantId } from "./context.js";

const instances = new Set<{ deleteTenant(id: string): void }>();

/** Module-level conversational state and caches, partitioned at every access. */
export class TenantMap<K, V> {
  private readonly tenants = new Map<string, Map<K, V>>();

  constructor() { instances.add(this); }

  private current(): Map<K, V> {
    const id = getTenantId();
    let entries = this.tenants.get(id);
    if (!entries) { entries = new Map<K, V>(); this.tenants.set(id, entries); }
    return entries;
  }

  get size(): number { return this.current().size; }
  get(key: K): V | undefined { return this.current().get(key); }
  set(key: K, value: V): this { this.current().set(key, value); return this; }
  has(key: K): boolean { return this.current().has(key); }
  delete(key: K): boolean { return this.current().delete(key); }
  clear(): void { this.current().clear(); }
  keys(): MapIterator<K> { return this.current().keys(); }
  values(): MapIterator<V> { return this.current().values(); }
  entries(): MapIterator<[K, V]> { return this.current().entries(); }
  [Symbol.iterator](): MapIterator<[K, V]> { return this.entries(); }
  deleteTenant(id: string): void { this.tenants.delete(id); }
}

export function clearTenantMemory(tenantId: string): void {
  for (const instance of instances) instance.deleteTenant(tenantId);
}

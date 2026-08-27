/**
 * The shape Baileys asks for in SocketConfig.msgRetryCounterCache
 * (Types/Socket.d.ts:12-21). Baileys defaults to @cacheable/node-cache, but that
 * only reaches us as a transitive dependency, and a retry counter needs nothing
 * more than this.
 */
export interface CacheStore {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
  del(key: string): void;
  flushAll(): void;
}

/**
 * Expiry is checked on read rather than on a timer: a daemon that reconnects every
 * half hour should not also carry an interval whose only job is deleting integers.
 * The cap is what keeps an unread key from pinning memory forever, since nothing
 * else ever sweeps.
 */
export function makeTtlCache(ttlMs: number, maxEntries = 10_000): CacheStore {
  const entries = new Map<string, { value: unknown; expiresAt: number }>();

  const alive = (key: string, now: number): { value: unknown; expiresAt: number } | undefined => {
    const hit = entries.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= now) {
      entries.delete(key);
      return undefined;
    }
    return hit;
  };

  return {
    get<T>(key: string): T | undefined {
      return alive(key, Date.now())?.value as T | undefined;
    },

    set<T>(key: string, value: T): void {
      const now = Date.now();
      if (entries.size >= maxEntries && !entries.has(key)) {
        for (const [k, v] of entries) if (v.expiresAt <= now) entries.delete(k);
        // Still full means everything is live, so drop the oldest insertion.
        if (entries.size >= maxEntries) {
          const oldest = entries.keys().next();
          if (!oldest.done) entries.delete(oldest.value);
        }
      }
      entries.set(key, { value, expiresAt: now + ttlMs });
    },

    del(key: string): void {
      entries.delete(key);
    },

    flushAll(): void {
      entries.clear();
    },
  };
}

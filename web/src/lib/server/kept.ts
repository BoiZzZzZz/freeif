// A value read from somewhere slow, kept in this server's memory for a while. Everyone who asks while a
// read is out waits for that one read, so a busy page does not multiply the calls to an exchange. A read
// that fails is not kept: the next caller tries again, and gets the last good value if it is still fresh
// enough to be worth more than an error (twice its normal life).

type Held = { value: unknown; at: number };

const held = new Map<string, Held>();
const out = new Map<string, Promise<unknown>>();
const PRUNE_ABOVE = 2_000;

export function kept<T>(key: string, lifeMs: number, read: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const have = held.get(key);
  if (have && now - have.at < lifeMs) return Promise.resolve(have.value as T);
  const running = out.get(key);
  if (running) return running as Promise<T>;
  const next = read()
    .then((value) => {
      if (held.size > PRUNE_ABOVE) held.clear();
      held.set(key, { value, at: Date.now() });
      return value;
    })
    .catch((err: unknown) => {
      const stale = held.get(key);
      if (stale && Date.now() - stale.at < lifeMs * 2) return stale.value as T;
      throw err;
    })
    .finally(() => out.delete(key));
  out.set(key, next);
  return next;
}

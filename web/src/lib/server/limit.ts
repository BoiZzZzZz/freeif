// How often one address may call the routes under /api. The routes cost something each time (a call to
// Circle on this app's key, and for a login an email sent in this app's name), and the first of them
// needs no login.
//
// The counts are kept in this server's memory. The host may run more than one copy of the server, each
// with its own counts, so this stops a loop and a simple script and is not an exact limit.

/** `max` requests, handed back evenly over `windowMs`. A client that has been quiet may send `max` at once. */
export type Rule = { name: string; max: number; windowMs: number };

const PRUNE_ABOVE = 5_000;
const buckets = new Map<string, { left: number; at: number; fullAt: number }>();

/**
 * Takes one request out of what `who` has left under `rule`. Returns 0 when the request may go on, or the
 * seconds until the next one may.
 */
export function take(rule: Rule, who: string, now: number = Date.now()): number {
  const key = `${rule.name} ${who}`;
  const perMs = rule.max / rule.windowMs;
  const held = buckets.get(key);
  const left = held === undefined ? rule.max : Math.min(rule.max, held.left + (now - held.at) * perMs);
  const allowed = left >= 1;
  const after = allowed ? left - 1 : left;
  // A bucket that is full again says the same as no bucket.
  if (buckets.size > PRUNE_ABOVE) for (const [k, bucket] of buckets) if (bucket.fullAt <= now) buckets.delete(k);
  buckets.set(key, { left: after, at: now, fullAt: now + (rule.max - after) / perMs });
  return allowed ? 0 : Math.max(1, Math.ceil((1 - left) / perMs / 1000));
}

/**
 * The address a request came from. Vercel sets both headers itself and does not pass on what a client
 * put in them. On a developer machine there is neither, and every request counts as one client.
 */
export function clientOf(request: Request): string {
  const real = request.headers.get("x-real-ip")?.trim();
  if (real) return real;
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
}

/** Every route under /api/wallet together: a payment asks about its transaction every 1.5 seconds. */
export const EVERY_ROUTE: Rule = { name: "wallet", max: 240, windowMs: 60_000 };
/**
 * Login codes: each one is an email. Circle already limits the codes sent to one email address; this is
 * for one address asking for codes to many. It leaves room for a hall of people logging in from one WiFi.
 */
export const LOGIN_CODES: Rule = { name: "codes", max: 20, windowMs: 10 * 60_000 };

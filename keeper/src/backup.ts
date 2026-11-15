// A backup of the keeper's file, and a restore that merges one into the file of a running keeper.
//
// The host can lose the file (Railway removed the whole project once, volume included). The chain keeps
// the money and the claims; the file keeps the rest: the words for each promo's card, its chart, its
// hedge, who has claimed, who has had starter test dollars. `GET /backup` hands the file out, a laptop
// pulls it on a timer (`pnpm backup --watch`), and `POST /restore` pushes it back into a new keeper.
//
// The restore merges, and what the live keeper already has wins: it only adds what the live file lacks
// (and, in two places, takes the backup's record where it knows more), so it can never take anything
// away, and running it a second time changes nothing.
import type { Address } from "viem";
import type { Hedge } from "./hedge.ts";
import { MAX_POINTS, thin, type OddsPoint } from "./odds.ts";
import { MAX_TXS, empty, type Data, type StarterGrant, type TxRecord } from "./store.ts";
import { MAX_EVENTS, byPosition, type FeedEvent } from "./stream.ts";

export const BACKUP_VERSION = 1;
/** The largest backup `POST /restore` reads. The file is a few megabytes. */
export const MAX_BACKUP_BYTES = 50 * 1024 * 1024;

export type BackupMeta = {
  version: typeof BACKUP_VERSION;
  /** The vault the file belongs to. A backup is restored only into a keeper on the same vault. */
  vault: Address;
  /** Unix seconds: when the keeper made it. */
  at: number;
  /** The commit the keeper was built from, as `GET /health` names it. Null on a laptop. */
  commit: string | null;
  /** The plain settings the keeper ran with (config.PLAIN_SETTINGS), for `pnpm rehost`. Never a secret. */
  settings: Record<string, string>;
};
export type Backup = { meta: BackupMeta; data: Data };

/** What a restore added, section by section. */
export type Added = {
  events: number;
  instruments: number;
  liveQuotes: number;
  /** Logins that have claimed a promo, counted once per promo. */
  claims: number;
  pendingLabels: number;
  promoLabels: number;
  /** Readings, over every promo. */
  odds: number;
  oddsStart: number;
  pendingOdds: number;
  /** Hedges added, or a simulated one replaced by the backup's sandbox order. */
  hedges: number;
  /** Grants added, or a grant whose transfer the live file did not know replaced by the backup's. */
  starter: number;
  txs: number;
  feedEvents: number;
  /** Events the live feed had from its own read of the chain, replaced by the Stream's delivery of them. */
  feedViaStream: number;
};

/** A body that is not a backup. The message says what is wrong with it. */
export class BackupError extends Error {}

// ---- Reading a backup ----

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === "string";
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const whole = (v: unknown): v is number => Number.isInteger(v);
const digits = (v: unknown): boolean => str(v) && /^\d+$/.test(v);
const orNull = (v: unknown, ok: (v: unknown) => boolean): boolean => v === null || ok(v);
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** A key that would set an object's prototype instead of naming an entry. */
const BAD_KEY = "__proto__";

const point = (v: unknown): boolean =>
  Array.isArray(v) && v.length === 4 && num(v[0]) && num(v[1]) && orNull(v[2], num) && orNull(v[3], num);

/** The sections that are records: one entry per key. */
type RecordName = "events" | "instruments" | "liveQuotes" | "claims" | "pendingLabels" | "promoLabels" | "odds" | "oddsStart" | "pendingOdds" | "hedges" | "starter";

// What each section holds, checked as far as the keeper's own code relies on it: a restored entry must
// never make a module throw.
const ENTRY: Record<RecordName, (v: unknown) => boolean> = {
  events: (v) => isObject(v) && str(v.eventId) && str(v.eventTicker) && str(v.title),
  instruments: (v) => isObject(v) && str(v.symbol) && str(v.label),
  liveQuotes: (v) => isObject(v) && digits(v.maxPayout) && digits(v.premium) && num(v.expiry),
  claims: (v) => isObject(v) && Object.entries(v).every(([k, a]) => k !== BAD_KEY && str(a)),
  pendingLabels: (v) =>
    isObject(v) && str(v.item) && str(v.business) && str(v.merchant) && str(v.geminiEventId) && str(v.instrumentSymbol) &&
    str(v.payoutPerClaim) && num(v.maxClaims) && str(v.premium) && num(v.claimDeadline) && num(v.at),
  promoLabels: (v) => isObject(v) && str(v.item) && str(v.business),
  odds: (v) => Array.isArray(v) && v.every(point),
  oddsStart: point,
  pendingOdds: point,
  hedges: (v) =>
    isObject(v) && (v.kind === "sandbox" || v.kind === "simulated") && str(v.symbol) && str(v.quantity) && str(v.price) &&
    num(v.at) && (v.orderId === undefined || str(v.orderId)),
  starter: (v) => isObject(v) && str(v.address) && digits(v.amount) && num(v.at) && orNull(v.txHash, str),
};
const RECORDS = Object.keys(ENTRY) as RecordName[];

const txOk = (v: unknown): boolean => isObject(v) && num(v.at) && str(v.promoId) && str(v.action) && str(v.hash);
const eventOk = (v: unknown): boolean =>
  isObject(v) && str(v.id) && str(v.event) && orNull(v.promoId, str) && whole(v.block) && whole(v.logIndex) && str(v.hash) &&
  num(v.at) && (v.via === "stream" || v.via === "rpc") && num(v.seenAt);

/**
 * The backup in a request body, checked: `{ meta: { version: 1, vault, ... }, data }`. A section the
 * backup lacks (a file from before it existed) is empty. Throws `BackupError` for anything else.
 */
export function readBackup(body: unknown): Backup {
  if (!isObject(body) || !isObject(body.meta) || !isObject(body.data)) throw new BackupError("a backup is { meta, data }");
  const { meta, data } = body;
  if (meta.version !== BACKUP_VERSION) throw new BackupError(`this keeper reads backups of version ${BACKUP_VERSION}`);
  if (!str(meta.vault) || !ADDRESS.test(meta.vault)) throw new BackupError("meta.vault must be the vault's address");

  const out = empty();
  for (const name of RECORDS) {
    const section = data[name];
    if (section === undefined) continue;
    if (!isObject(section)) throw new BackupError(`data.${name} must be an object`);
    for (const [key, entry] of Object.entries(section)) {
      if (key === BAD_KEY || !ENTRY[name](entry)) throw new BackupError(`data.${name} holds an entry the keeper does not keep there ("${key}")`);
    }
    (out as unknown as Json)[name] = section;
  }
  if (data.txs !== undefined) {
    if (!Array.isArray(data.txs) || !data.txs.every(txOk)) throw new BackupError("data.txs must be a list of transactions");
    out.txs = data.txs as TxRecord[];
  }
  if (data.feed !== undefined) {
    const feed = data.feed;
    if (!isObject(feed)) throw new BackupError("data.feed must be an object");
    if (!Array.isArray(feed.events) || !feed.events.every(eventOk)) throw new BackupError("data.feed.events must be a list of vault events");
    if (!orNull(feed.cursor, whole) || !num(feed.deliveries) || !orNull(feed.lastDeliveryAt, num) || !(feed.signed === undefined || num(feed.signed))) {
      throw new BackupError("data.feed's counts are not numbers");
    }
    out.feed = {
      events: feed.events as FeedEvent[],
      cursor: feed.cursor as number | null,
      deliveries: feed.deliveries,
      lastDeliveryAt: feed.lastDeliveryAt as number | null,
      ...(feed.signed === undefined ? {} : { signed: feed.signed as number }),
    };
  }
  return {
    meta: {
      version: BACKUP_VERSION,
      vault: meta.vault as Address,
      at: num(meta.at) ? meta.at : 0,
      commit: str(meta.commit) ? meta.commit : null,
      settings: isObject(meta.settings) ? Object.fromEntries(Object.entries(meta.settings).filter(([, v]) => str(v))) as Record<string, string> : {},
    },
    data: out,
  };
}

// ---- The merge ----

const own = <T>(record: Record<string, T>, key: string): T | undefined => (Object.hasOwn(record, key) ? record[key] : undefined);

/**
 * The live record with the backup's entries it lacks (those `take` accepts). Where both have an entry the
 * live one stays, unless `prefer(live, backup)` says the backup's knows more. Returns `live` itself when
 * nothing is added, so an untouched section is the same object.
 */
function addMissing<T>(
  live: Record<string, T>,
  backup: Record<string, T>,
  take: (entry: T) => boolean = () => true,
  prefer: (live: T, backup: T) => boolean = () => false,
): Record<string, T> {
  let out: Record<string, T> | null = null;
  for (const [key, entry] of Object.entries(backup)) {
    if (key === BAD_KEY) continue;
    const held = own(live, key);
    if (held === undefined ? !take(entry) : !prefer(held, entry)) continue;
    out ??= { ...live };
    out[key] = entry;
  }
  return out ?? live;
}

/**
 * One promo's readings. The backup's are added where the live keeper has none: before its first reading
 * and after its last. Inside that span the live readings are the record (the keeper may have thinned
 * them on purpose), so adding the backup's there would undo the thinning, and a second restore would
 * change the result again. Past the cap the older half is thinned, as odds.ts does.
 */
function mergePoints(live: OddsPoint[] | undefined, backup: OddsPoint[]): OddsPoint[] | undefined {
  const times = live?.map((p) => p[0]) ?? [];
  const first = times.length === 0 ? Infinity : Math.min(...times);
  const last = times.length === 0 ? -Infinity : Math.max(...times);
  const seen = new Set<number>();
  const fresh = backup.filter((p) => {
    if ((p[0] >= first && p[0] <= last) || seen.has(p[0])) return false;
    seen.add(p[0]);
    return true;
  });
  if (fresh.length === 0) return live;
  const all = [...(live ?? []), ...fresh].sort((a, b) => a[0] - b[0]);
  while (all.length > MAX_POINTS) thin(all);
  return all;
}

/**
 * Both lists of transactions, by time, the newest `MAX_TXS`. At the same second the backup's come first,
 * so the cap drops the backup's before the live keeper's own, and a second restore drops the same ones.
 */
function mergeTxs(live: TxRecord[], backup: TxRecord[]): TxRecord[] {
  const have = new Set(live.map((t) => t.hash.toLowerCase()));
  const fresh: TxRecord[] = [];
  for (const tx of backup) {
    const hash = tx.hash.toLowerCase();
    if (have.has(hash)) continue;
    have.add(hash);
    fresh.push(tx);
  }
  if (fresh.length === 0) return live;
  const tagged = [...fresh.map((tx) => ({ tx, live: 1 })), ...live.map((tx) => ({ tx, live: 2 }))];
  tagged.sort((a, b) => a.tx.at - b.tx.at || a.live - b.live);
  return tagged.slice(-MAX_TXS).map((t) => t.tx);
}

/**
 * Both feeds, by the id the feed counts an event under (`txHash:logIndex`), in chain order, the newest
 * `MAX_EVENTS`. Where both have an event, the one the Stream delivered is kept (it says when the Stream
 * had it), else the live one.
 */
function mergeEvents(live: FeedEvent[], backup: FeedEvent[]): FeedEvent[] {
  const byId = new Map(live.map((e) => [e.id, e]));
  let changed = false;
  for (const event of backup) {
    const held = byId.get(event.id);
    if (held !== undefined && !(held.via !== "stream" && event.via === "stream")) continue;
    byId.set(event.id, event);
    changed = true;
  }
  return changed ? [...byId.values()].sort(byPosition).slice(-MAX_EVENTS) : live;
}

const larger = (a: number | null | undefined, b: number | null | undefined): number | null | undefined =>
  a === null || a === undefined ? b : b === null || b === undefined ? a : Math.max(a, b);

/**
 * Merges a backup's data into the live keeper's, live first. Pure: neither input is changed, and a
 * section with nothing added is the live object itself. `now` (unix seconds) decides which of the
 * backup's signed quotes are still usable. Returns the merged data and what was added.
 */
export function mergeData(live: Data, backup: Data, now: number): { data: Data; added: Added } {
  const claims: Data["claims"] = { ...live.claims };
  let claimsChanged = false;
  for (const [promoId, who] of Object.entries(backup.claims)) {
    if (promoId === BAD_KEY) continue;
    const held = own(live.claims, promoId);
    const merged = addMissing(held ?? {}, who);
    if (merged !== held && Object.keys(merged).length > 0) {
      claims[promoId] = merged;
      claimsChanged = true;
    }
  }

  const odds: Data["odds"] = { ...live.odds };
  let oddsChanged = false;
  for (const [promoId, points] of Object.entries(backup.odds)) {
    if (promoId === BAD_KEY) continue;
    const held = own(live.odds, promoId);
    const merged = mergePoints(held, points);
    if (merged !== held && merged !== undefined) {
      odds[promoId] = merged;
      oddsChanged = true;
    }
  }

  const feed = live.feed;
  const events = mergeEvents(feed.events, backup.feed.events);
  const signed = larger(feed.signed, backup.feed.signed);
  const data: Data = {
    ...live,
    events: addMissing(live.events, backup.events),
    instruments: addMissing(live.instruments, backup.instruments),
    liveQuotes: addMissing(live.liveQuotes, backup.liveQuotes, (q) => q.expiry > now),
    claims: claimsChanged ? claims : live.claims,
    pendingLabels: addMissing(live.pendingLabels, backup.pendingLabels),
    promoLabels: addMissing(live.promoLabels, backup.promoLabels),
    odds: oddsChanged ? odds : live.odds,
    oddsStart: addMissing(live.oddsStart, backup.oddsStart),
    pendingOdds: addMissing(live.pendingOdds, backup.pendingOdds),
    hedges: addMissing<Hedge>(live.hedges, backup.hedges, undefined, (l, b) => l.kind === "simulated" && str(b.orderId) && b.orderId !== ""),
    starter: addMissing<StarterGrant>(live.starter, backup.starter, undefined, (l, b) => l.txHash === null && b.txHash !== null),
    txs: mergeTxs(live.txs, backup.txs),
    feed: {
      ...feed,
      events,
      // The live keeper's own read of the chain goes on from where it is.
      cursor: feed.cursor,
      deliveries: Math.max(feed.deliveries, backup.feed.deliveries),
      lastDeliveryAt: larger(feed.lastDeliveryAt, backup.feed.lastDeliveryAt) ?? null,
      ...(signed === undefined || signed === null ? {} : { signed }),
    },
  };
  tie(data, live);
  return { data, added: count(live, data) };
}

/**
 * A promo is tied to its quote's label and first reading when its `PromoCreated` reaches the feed (the
 * event carries the quote's nonce). A restored pending label or reading whose promo's event the live
 * feed already had would never be tied: this ties them, as the feed and odds.ts would have. A promo that
 * already has its label or first reading keeps it.
 */
function tie(data: Data, live: Data): void {
  for (const event of data.feed.events) {
    if (event.event !== "PromoCreated" || !event.nonce || event.promoId === null) continue;
    const label = own(data.pendingLabels, event.nonce);
    if (label !== undefined && own(data.promoLabels, event.promoId) === undefined) {
      if (data.promoLabels === live.promoLabels) data.promoLabels = { ...data.promoLabels };
      if (data.pendingLabels === live.pendingLabels) data.pendingLabels = { ...data.pendingLabels };
      data.promoLabels[event.promoId] = { item: label.item, business: label.business };
      delete data.pendingLabels[event.nonce];
    }
    const reading = own(data.pendingOdds, event.nonce);
    if (reading !== undefined && own(data.oddsStart, event.promoId) === undefined) {
      if (data.oddsStart === live.oddsStart) data.oddsStart = { ...data.oddsStart };
      if (data.pendingOdds === live.pendingOdds) data.pendingOdds = { ...data.pendingOdds };
      data.oddsStart[event.promoId] = [event.at, reading[1], reading[2], reading[3]];
      delete data.pendingOdds[event.nonce];
    }
  }
}

/** Entries of `after` that `before` did not have, or had as another record. */
function changedEntries(before: Record<string, unknown>, after: Record<string, unknown>): number {
  if (before === after) return 0;
  let n = 0;
  for (const key of Object.keys(after)) if (own(before, key) !== after[key]) n++;
  return n;
}

function count(live: Data, data: Data): Added {
  let claims = 0;
  for (const [promoId, who] of Object.entries(data.claims)) {
    const held = own(live.claims, promoId) ?? {};
    for (const key of Object.keys(who)) if (own(held, key) === undefined) claims++;
  }
  let odds = 0;
  for (const [promoId, points] of Object.entries(data.odds)) {
    const times = new Set((own(live.odds, promoId) ?? []).map((p) => p[0]));
    for (const p of points) if (!times.has(p[0])) odds++;
  }
  const hashes = new Set(live.txs.map((t) => t.hash.toLowerCase()));
  const before = new Map(live.feed.events.map((e) => [e.id, e]));
  let feedEvents = 0;
  let feedViaStream = 0;
  for (const event of data.feed.events) {
    const held = before.get(event.id);
    if (held === undefined) feedEvents++;
    else if (held.via !== "stream" && event.via === "stream") feedViaStream++;
  }
  return {
    events: changedEntries(live.events, data.events),
    instruments: changedEntries(live.instruments, data.instruments),
    liveQuotes: changedEntries(live.liveQuotes, data.liveQuotes),
    claims,
    pendingLabels: changedEntries(live.pendingLabels, data.pendingLabels),
    promoLabels: changedEntries(live.promoLabels, data.promoLabels),
    odds,
    oddsStart: changedEntries(live.oddsStart, data.oddsStart),
    pendingOdds: changedEntries(live.pendingOdds, data.pendingOdds),
    hedges: changedEntries(live.hedges, data.hedges),
    starter: changedEntries(live.starter, data.starter),
    txs: data.txs.filter((t) => !hashes.has(t.hash.toLowerCase())).length,
    feedEvents,
    feedViaStream,
  };
}

/**
 * Writes merged data into the store's own data, keeping each section the same object (a module that
 * holds a section across an await keeps writing into the live one). Entries the merge left out are
 * removed: only the two pending lists lose entries, those the merge tied to their promos.
 */
export function applyInto(target: Data, source: Data): void {
  for (const name of RECORDS) {
    const into = target[name] as Record<string, unknown>;
    const from = source[name] as Record<string, unknown>;
    if (into === from) continue;
    for (const key of Object.keys(into)) if (!Object.hasOwn(from, key)) delete into[key];
    Object.assign(into, from);
  }
  if (target.txs !== source.txs) target.txs.splice(0, target.txs.length, ...source.txs);
  const feed = target.feed;
  if (feed.events !== source.feed.events) feed.events.splice(0, feed.events.length, ...source.feed.events);
  feed.cursor = source.feed.cursor;
  feed.deliveries = source.feed.deliveries;
  feed.lastDeliveryAt = source.feed.lastDeliveryAt;
  if (source.feed.signed !== undefined) feed.signed = source.feed.signed;
}

/** Non-zero counts as words, for a log line: "3 promoLabels, 120 odds". */
export function describeAdded(added: Added): string {
  const parts = Object.entries(added).filter(([, n]) => n > 0).map(([name, n]) => `${n} ${name}`);
  return parts.length === 0 ? "nothing new" : parts.join(", ");
}

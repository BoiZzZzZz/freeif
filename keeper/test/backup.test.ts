// The backup and the restore: the store's vault stamp in a temporary directory, the merge section by
// section (what is added, where the live file wins, that a second restore changes nothing), the two
// routes through the HTTP app, and a restored event that the feed's next read of the chain does not add
// again.
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Address, Hex } from "viem";
import "../src/config.ts";
import { MAX_BACKUP_BYTES, applyInto, mergeData, readBackup, BackupError, type Backup } from "../src/backup.ts";
import { Status, type PublicClient } from "../src/chain.ts";
import { LIMITS, type Limits } from "../src/limit.ts";
import { MAX_POINTS, type OddsPoint } from "../src/odds.ts";
import { makeApp } from "../src/server.ts";
import { MAX_TXS, Store, asideName, empty, type Data, type TxRecord } from "../src/store.ts";
import { Feed, MAX_EVENTS, type FeedEvent, type Via } from "../src/stream.ts";

const VAULT: Address = "0x68a00243927f250dBcD9160b5d06623b62B2e06d";
const OTHER: Address = "0x828295d7213DBA6eB281354d61801082006f72e6";
const USDC: Address = "0x3600000000000000000000000000000000000000";
const ALICE: Address = "0x6f3DE22768B24a4cAE412BF3575E691488B7d6E4";
const BOB: Address = "0x7DA5F6f9bbEBf584f71CdD082aeBEaF46fa7E799";
const KEY = "the-backup-key";
const NOW = 1_794_500_000;

const hex = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;
const quiet = () => undefined;
const label = (item: string) => ({ item, business: "Tony's Pizza" });

// ---- The store's vault stamp ----

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "freeif-backup-"));
}
const onDisk = (dir: string, name = "keeper.json") => JSON.parse(readFileSync(join(dir, name), "utf8")) as Data;

test("store_aFileWithNoStamp_isTakenAndStamped", () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, "keeper.json"), JSON.stringify({ promoLabels: { "9": label("Wings") } }));
    const lines: string[] = [];
    const store = new Store(dir, VAULT, (line) => lines.push(line));
    assert.deepEqual(store.data.promoLabels, { "9": label("Wings") });
    assert.equal(store.data.vault, VAULT);
    assert.equal(onDisk(dir).vault, VAULT, "the stamp is on disk at once");
    assert.equal(lines.length, 1);
    // The next start finds the stamp and says nothing.
    new Store(dir, VAULT, (line) => lines.push(line));
    assert.equal(lines.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("store_aFileOfAnotherVault_isSetAside_andTheKeeperStartsEmpty", () => {
  const dir = tempDir();
  try {
    const first = new Store(dir, VAULT, quiet);
    first.data.promoLabels["9"] = label("Wings");
    first.save();

    const lines: string[] = [];
    const second = new Store(dir, OTHER, (line) => lines.push(line));
    assert.deepEqual(second.data.promoLabels, {});
    assert.equal(second.data.vault, OTHER);
    assert.equal(lines.length, 1, "one line says what happened");
    assert.match(lines[0]!, /set it aside as keeper\.0x68a00243927f250dbcd9160b5d06623b62b2e06d\.json/);
    assert.deepEqual(onDisk(dir, asideName(VAULT)).promoLabels, { "9": label("Wings") });
    assert.equal(onDisk(dir).vault, OTHER);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("store_backOnTheFirstVault_takesItsFileBack_andSetsTheOtherAside", () => {
  const dir = tempDir();
  try {
    const a = new Store(dir, VAULT, quiet);
    a.data.promoLabels["9"] = label("Wings");
    a.save();
    const b = new Store(dir, OTHER, quiet);
    b.data.promoLabels["0"] = label("Fries");
    b.save();

    const lines: string[] = [];
    const again = new Store(dir, VAULT, (line) => lines.push(line));
    assert.deepEqual(again.data.promoLabels, { "9": label("Wings") });
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /took back keeper\.0x68a0.*\.json/);
    assert.deepEqual(onDisk(dir, asideName(OTHER)).promoLabels, { "0": label("Fries") });
    // Nothing was deleted: the live file and the other vault's.
    assert.deepEqual(readdirSync(dir).sort(), [asideName(OTHER), "keeper.json"].sort());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("store_theStampIsComparedWithoutCase", () => {
  const dir = tempDir();
  try {
    const a = new Store(dir, VAULT, quiet);
    a.data.promoLabels["9"] = label("Wings");
    a.save();
    const lines: string[] = [];
    const same = new Store(dir, VAULT.toLowerCase() as Address, (line) => lines.push(line));
    assert.deepEqual(same.data.promoLabels, { "9": label("Wings") });
    assert.deepEqual(lines, []);
    assert.deepEqual(readdirSync(dir), ["keeper.json"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("store_aRunThatStoppedHalfWay_findsThisVaultsFileSetAside", () => {
  const dir = tempDir();
  try {
    // keeper.json was set aside and the keeper stopped before taking its own file back.
    writeFileSync(join(dir, asideName(VAULT)), JSON.stringify({ vault: VAULT, promoLabels: { "9": label("Wings") } }));
    const store = new Store(dir, VAULT, quiet);
    assert.deepEqual(store.data.promoLabels, { "9": label("Wings") });
    assert.deepEqual(readdirSync(dir), ["keeper.json"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("store_aSetAsideNameThatIsTaken_isNotOverwritten", () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, asideName(VAULT)), JSON.stringify({ vault: VAULT, promoLabels: { "1": label("Old") } }));
    writeFileSync(join(dir, "keeper.json"), JSON.stringify({ vault: VAULT, promoLabels: { "2": label("New") } }));
    new Store(dir, OTHER, quiet);
    const files = readdirSync(dir);
    assert.equal(files.length, 3, "both of the first vault's files are kept");
    assert.ok(files.includes(asideName(VAULT)));
    assert.deepEqual(onDisk(dir, asideName(VAULT)).promoLabels, { "1": label("Old") });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("store_withNoVault_readsTheFileAsBefore", () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, "keeper.json"), JSON.stringify({ vault: OTHER, promoLabels: { "9": label("Wings") } }));
    const store = new Store(dir);
    assert.deepEqual(store.data.promoLabels, { "9": label("Wings") });
    assert.equal(new Store(null).data.vault, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- The merge ----

/** Data with some sections filled; the rest empty. */
function data(over: Partial<Omit<Data, "feed">> & { feed?: Partial<Data["feed"]> } = {}): Data {
  const base = empty();
  return { ...base, ...over, feed: { ...base.feed, ...over.feed } };
}

/** One vault event, at block `block` and place `logIndex`. */
function ev(block: number, logIndex: number, via: Via, over: Partial<FeedEvent> = {}): FeedEvent {
  return {
    id: `${hex(block)}:${logIndex}`,
    event: "ClaimRegistered",
    promoId: "1",
    block,
    logIndex,
    hash: hex(block),
    at: 1_794_000_000 + block,
    via,
    seenAt: (1_794_000_000 + block) * 1000,
    ...over,
  };
}

const tx = (n: number, at: number): TxRecord => ({ at, promoId: "1", action: "settle", hash: hex(n) });
const pts = (from: number, to: number, step = 30): OddsPoint[] => {
  const out: OddsPoint[] = [];
  for (let t = from; t <= to; t += step) out.push([t, 4000, 3900, 4000]);
  return out;
};
const pending = (item: string, at = NOW) => ({
  ...label(item),
  merchant: ALICE,
  geminiEventId: hex(11),
  instrumentSymbol: hex(22),
  payoutPerClaim: "8000000",
  maxClaims: 2,
  premium: "7060000",
  claimDeadline: NOW + 3600,
  at,
});
const sandbox = (orderId: string) => ({ kind: "sandbox" as const, symbol: "BTC05M", quantity: "16", price: "0.43", at: NOW, orderId, status: "open" });
const simulated = { kind: "simulated" as const, symbol: "GEMI-X", quantity: "16", price: "0.43", at: NOW, reason: "Gemini's sandbox does not list this contract." };
const grant = (txHash: Hex | null) => ({ address: ALICE, amount: "8000000", at: NOW, txHash });

/** A backup with something in every section. */
function fullBackup(): Data {
  return data({
    events: { [hex(11)]: { eventId: "455167", eventTicker: "NFL-2611151430-NE-DET-M", title: "Patriots at Lions", game: "Patriots at Lions" } },
    instruments: { [hex(22)]: { symbol: "GEMI-NE", label: "New England", team: "the Patriots", condition: "the Patriots win" } },
    liveQuotes: { [hex(31)]: { maxPayout: "16000000", premium: "7060000", expiry: NOW + 60 }, [hex(32)]: { maxPayout: "1000000", premium: "500000", expiry: NOW - 1 } },
    claims: { "9": { aaa: ALICE, bbb: BOB } },
    pendingLabels: { [hex(41)]: pending("Fries") },
    promoLabels: { "9": label("Wings"), "16": label("Drink") },
    odds: { "9": pts(NOW - 600, NOW - 300) },
    oddsStart: { "9": [NOW - 900, 4200, 4100, 4200] },
    pendingOdds: { [hex(42)]: [NOW - 50, 3000, 2900, 3000] },
    hedges: { "9": simulated },
    starter: { s1: grant(hex(51)) },
    txs: [tx(61, NOW - 100), tx(62, NOW - 50)],
    feed: { events: [ev(100, 0, "stream"), ev(101, 3, "rpc")], cursor: 101, deliveries: 7, lastDeliveryAt: NOW * 1000, signed: 7 },
  });
}

test("merge_intoAnEmptyFile_addsEverySection_butNoQuoteThatHasExpired", () => {
  const backup = fullBackup();
  const { data: out, added } = mergeData(empty(), backup, NOW);
  assert.deepEqual(out.events, backup.events);
  assert.deepEqual(out.instruments, backup.instruments);
  assert.deepEqual(Object.keys(out.liveQuotes), [hex(31)]);
  assert.deepEqual(out.claims, backup.claims);
  assert.deepEqual(out.promoLabels, backup.promoLabels);
  assert.deepEqual(out.odds, backup.odds);
  assert.deepEqual(out.hedges, backup.hedges);
  assert.deepEqual(out.starter, backup.starter);
  assert.deepEqual(out.txs, backup.txs);
  assert.deepEqual(out.feed.events, backup.feed.events);
  assert.deepEqual(added, {
    events: 1, instruments: 1, liveQuotes: 1, claims: 2, pendingLabels: 1, promoLabels: 2, odds: 11, oddsStart: 1, pendingOdds: 1,
    hedges: 1, starter: 1, txs: 2, feedEvents: 2, feedViaStream: 0,
  });
  // The live keeper's own read of the chain goes on from where it is; the Stream's counts are the larger.
  assert.equal(out.feed.cursor, null);
  assert.deepEqual([out.feed.deliveries, out.feed.signed, out.feed.lastDeliveryAt], [7, 7, NOW * 1000]);
});

test("merge_whereBothHaveAnEntry_theLiveOneWins", () => {
  const live = data({
    events: { [hex(11)]: { eventId: "455167", eventTicker: "LIVE", title: "Live" } },
    promoLabels: { "9": label("Live wings") },
    oddsStart: { "9": [NOW - 800, 1, 1, 1] },
    claims: { "9": { aaa: BOB } },
    hedges: { "9": sandbox("111") },
    starter: { s1: grant(hex(99)) },
    liveQuotes: { [hex(31)]: { maxPayout: "1", premium: "1", expiry: NOW + 10 } },
  });
  const backup = fullBackup();
  backup.hedges["9"] = sandbox("222");
  const { data: out, added } = mergeData(live, backup, NOW);
  assert.equal(out.events[hex(11)]!.eventTicker, "LIVE");
  assert.deepEqual(out.promoLabels["9"], label("Live wings"));
  assert.deepEqual(out.promoLabels["16"], label("Drink"), "the entries it lacked are added");
  assert.deepEqual(out.oddsStart["9"], [NOW - 800, 1, 1, 1]);
  assert.deepEqual(out.claims["9"], { aaa: BOB, bbb: BOB }, "the login that claimed keeps its own address; the other login is added");
  assert.equal(out.hedges["9"]!.orderId, "111");
  assert.equal(out.starter.s1!.txHash, hex(99));
  assert.equal(out.liveQuotes[hex(31)]!.premium, "1");
  assert.deepEqual([added.events, added.promoLabels, added.oddsStart, added.claims, added.hedges, added.starter, added.liveQuotes], [0, 1, 0, 1, 0, 0, 0]);
});

test("merge_aGrantWhoseTransferTheLiveFileDoesNotKnow_takesTheBackupsHash", () => {
  const live = data({ starter: { s1: grant(null), s2: grant(hex(7)) } });
  const backup = data({ starter: { s1: grant(hex(51)), s2: grant(null) } });
  const { data: out, added } = mergeData(live, backup, NOW);
  assert.equal(out.starter.s1!.txHash, hex(51));
  assert.equal(out.starter.s2!.txHash, hex(7), "a hash the live file knows is never replaced");
  assert.equal(added.starter, 1);
});

test("merge_aSimulatedHedge_givesWayToTheBackupsSandboxOrder_neverTheOtherWayRound", () => {
  const live = data({ hedges: { "9": simulated, "15": sandbox("145853902318667186") } });
  const backup = data({ hedges: { "9": sandbox("145853902318667999"), "15": simulated } });
  const { data: out, added } = mergeData(live, backup, NOW);
  assert.equal(out.hedges["9"]!.orderId, "145853902318667999");
  assert.equal(out.hedges["15"]!.orderId, "145853902318667186");
  assert.equal(added.hedges, 1);
});

test("merge_odds_theBackupsReadingsComeBeforeAndAfterTheLiveOnes_notInsideThem", () => {
  // The live keeper has readings from 1000 to 2000, thinned in the middle; the backup has 0 to 3000.
  const live = data({ odds: { "9": [[1000, 1, 1, 1], [2000, 2, 2, 2]] } });
  const backup = data({ odds: { "9": pts(0, 3000, 500), "10": pts(0, 60) } });
  const { data: out, added } = mergeData(live, backup, NOW);
  assert.deepEqual(out.odds["9"]!.map((p) => p[0]), [0, 500, 1000, 2000, 2500, 3000]);
  assert.deepEqual(out.odds["9"]![2], [1000, 1, 1, 1], "the live reading at the same time stays");
  assert.equal(out.odds["10"]!.length, 3);
  assert.equal(added.odds, 4 + 3);
});

test("merge_odds_pastTheCap_theOlderHalfIsThinned_asTheKeeperDoes", () => {
  const live = data({ odds: { "9": pts(1_000_000, 1_000_000 + 30 * 2999) } });
  const backup = data({ odds: { "9": pts(0, 30 * 1999) } });
  const { data: out } = mergeData(live, backup, NOW);
  const merged = out.odds["9"]!;
  assert.ok(merged.length <= MAX_POINTS, `${merged.length} readings`);
  assert.equal(merged[0]![0], 0, "the first reading is never dropped");
  assert.equal(merged.at(-1)![0], 1_000_000 + 30 * 2999, "the newest are as they were read");
  for (let i = 1; i < merged.length; i++) assert.ok(merged[i]![0] > merged[i - 1]![0], "oldest first");
});

test("merge_txs_byHash_byTime_theNewestWithinTheCap", () => {
  const live = data({ txs: [tx(1, 100), tx(3, 300)] });
  const backup = data({ txs: [tx(2, 200), tx(3, 300), tx(4, 50)] });
  const { data: out, added } = mergeData(live, backup, NOW);
  assert.deepEqual(out.txs.map((t) => t.hash), [hex(4), hex(1), hex(2), hex(3)]);
  assert.equal(added.txs, 2);

  const many = data({ txs: Array.from({ length: MAX_TXS }, (_, i) => tx(10_000 + i, 1_000 + i)) });
  const { data: capped } = mergeData(many, data({ txs: [tx(1, 5), tx(2, 999_999)] }), NOW);
  assert.equal(capped.txs.length, MAX_TXS);
  assert.equal(capped.txs.at(-1)!.hash, hex(2), "the newest is added");
  assert.ok(!capped.txs.some((t) => t.hash === hex(1)), "one older than all of them is not");
});

test("merge_feed_byId_inChainOrder_theStreamsCopyWins_withinTheCap", () => {
  const live = data({ feed: { events: [ev(105, 0, "rpc"), ev(103, 1, "stream"), ev(110, 2, "rpc")], cursor: 500, deliveries: 3, lastDeliveryAt: 5, signed: 1 } });
  const backup = data({ feed: { events: [ev(101, 0, "rpc"), ev(105, 0, "stream"), ev(103, 1, "rpc"), ev(110, 2, "rpc")], cursor: 900, deliveries: 9, lastDeliveryAt: 4, signed: 0 } });
  const { data: out, added } = mergeData(live, backup, NOW);
  assert.deepEqual(out.feed.events.map((e) => `${e.block}:${e.via}`), ["101:rpc", "103:stream", "105:stream", "110:rpc"]);
  assert.deepEqual([added.feedEvents, added.feedViaStream], [1, 1]);
  assert.deepEqual([out.feed.cursor, out.feed.deliveries, out.feed.lastDeliveryAt, out.feed.signed], [500, 9, 5, 1]);

  const full = data({ feed: { events: Array.from({ length: MAX_EVENTS }, (_, i) => ev(1_000 + i, 0, "rpc")) } });
  const { data: capped } = mergeData(full, data({ feed: { events: [ev(1, 0, "stream"), ev(1_000_000, 0, "stream")] } }), NOW);
  assert.equal(capped.feed.events.length, MAX_EVENTS);
  assert.equal(capped.feed.events.at(-1)!.block, 1_000_000);
  assert.ok(!capped.feed.events.some((e) => e.block === 1), "an event older than the cap keeps is not added");
});

test("merge_tiesARestoredLabelAndFirstReading_toThePromoWhoseEventTheLiveFeedHad", () => {
  // The rebuilt keeper read the promo's PromoCreated from the chain before the restore, so it could not
  // tie the label and the reading kept under the quote's nonce: it did not have them yet.
  const nonce = hex(41);
  const created = ev(200, 0, "rpc", { event: "PromoCreated", promoId: "26", nonce, at: NOW - 10 });
  const live = data({ feed: { events: [created] }, promoLabels: { "9": label("Wings") } });
  const backup = data({ pendingLabels: { [nonce]: pending("Fries"), [hex(43)]: pending("Soda") }, pendingOdds: { [nonce]: [NOW - 70, 3000, 2900, 3000] } });
  const { data: out, added } = mergeData(live, backup, NOW);
  assert.deepEqual(out.promoLabels["26"], label("Fries"));
  assert.deepEqual(out.oddsStart["26"], [NOW - 10, 3000, 2900, 3000], "at the promo's block time, as odds.ts does");
  assert.deepEqual(Object.keys(out.pendingLabels), [hex(43)], "a label still waiting for its promo stays");
  assert.deepEqual(out.pendingOdds, {});
  assert.deepEqual([added.promoLabels, added.oddsStart, added.pendingLabels, added.pendingOdds], [1, 1, 1, 0]);

  // A promo that has its label keeps it.
  const labelled = data({ feed: { events: [created] }, promoLabels: { "26": label("Live") } });
  assert.deepEqual(mergeData(labelled, backup, NOW).data.promoLabels["26"], label("Live"));
});

test("merge_twice_changesNothingTheSecondTime", () => {
  // A live file and a backup that overlap in every section, with the caps reached.
  const live = data({
    promoLabels: { "9": label("Live") },
    claims: { "9": { aaa: BOB } },
    odds: { "9": pts(10_000_000, 10_000_000 + 30 * 3990) },
    hedges: { "9": simulated },
    starter: { s1: grant(null) },
    txs: Array.from({ length: MAX_TXS - 5 }, (_, i) => tx(20_000 + i, 1_000 + i)),
    feed: { events: Array.from({ length: MAX_EVENTS - 3 }, (_, i) => ev(5_000 + i, 0, "rpc")), cursor: 99, deliveries: 1, lastDeliveryAt: null },
  });
  const backup = fullBackup();
  backup.hedges["9"] = sandbox("333");
  backup.odds["9"] = pts(0, 30 * 50);
  backup.txs = [...backup.txs, ...Array.from({ length: 20 }, (_, i) => tx(30_000 + i, 1_000 + i))];
  backup.feed.events = [...backup.feed.events, ...Array.from({ length: 10 }, (_, i) => ev(5_000 + i, 0, "stream")), ev(9_999_999, 0, "stream")];

  const first = mergeData(live, backup, NOW);
  const second = mergeData(first.data, backup, NOW);
  assert.ok(Object.values(first.added).some((n) => n > 0));
  assert.ok(Object.values(second.added).every((n) => n === 0), JSON.stringify(second.added));
  assert.deepEqual(second.data, first.data);
});

test("merge_isPure_neitherInputIsChanged", () => {
  const live = data({ promoLabels: { "9": label("Live") }, odds: { "9": pts(1000, 1100) }, feed: { events: [ev(100, 0, "rpc")] } });
  const backup = fullBackup();
  backup.pendingLabels[hex(41)] = pending("Fries");
  backup.feed.events.push(ev(150, 0, "rpc", { event: "PromoCreated", promoId: "30", nonce: hex(41) }));
  const liveBefore = structuredClone(live);
  const backupBefore = structuredClone(backup);
  const { data: out } = mergeData(live, backup, NOW);
  assert.deepEqual(live, liveBefore);
  assert.deepEqual(backup, backupBefore);
  assert.deepEqual(out.promoLabels["30"], label("Fries"));

  // Nothing to add: every section is the live object itself.
  const { data: same } = mergeData(live, empty(), NOW);
  for (const name of Object.keys(live) as Array<keyof Data>) {
    if (name !== "feed") assert.equal(same[name], live[name], name);
  }
  assert.equal(same.feed.events, live.feed.events);
});

test("applyInto_writesTheMergeIntoTheLiveSections_keepingEachTheSameObject", () => {
  const live = data({ pendingLabels: { [hex(41)]: pending("Fries") }, feed: { events: [ev(200, 0, "rpc", { event: "PromoCreated", promoId: "26", nonce: hex(41) })] } });
  const sections = { labels: live.promoLabels, pending: live.pendingLabels, txs: live.txs, feed: live.feed, events: live.feed.events };
  const { data: out } = mergeData(live, fullBackup(), NOW);
  applyInto(live, out);
  assert.deepEqual(live, out);
  assert.equal(live.promoLabels, sections.labels);
  assert.equal(live.pendingLabels, sections.pending);
  assert.equal(live.txs, sections.txs);
  assert.equal(live.feed, sections.feed);
  assert.equal(live.feed.events, sections.events);
  assert.equal(live.pendingLabels[hex(41)], undefined, "the label tied to its promo has left the pending list");
});

test("readBackup_refusesWhatIsNotABackup", () => {
  const meta = { version: 1, vault: VAULT, at: NOW, commit: null, settings: {} };
  const refuse = (body: unknown, message: RegExp) => assert.throws(() => readBackup(body), (err: unknown) => err instanceof BackupError && message.test(err.message));
  refuse(null, /meta, data/);
  refuse({ data: {} }, /meta, data/);
  refuse({ meta: { ...meta, version: 2 }, data: {} }, /version 1/);
  refuse({ meta: { ...meta, vault: "0x12" }, data: {} }, /vault/);
  refuse({ meta, data: { promoLabels: [] } }, /data\.promoLabels must be an object/);
  refuse({ meta, data: { starter: { s1: { ...grant(null), amount: "8 dollars" } } } }, /data\.starter/);
  refuse({ meta, data: { odds: { "9": [[1, 2, 3]] } } }, /data\.odds/);
  refuse({ meta, data: JSON.parse(`{"promoLabels": {"__proto__": {"item": "x", "business": "y"}}}`) }, /data\.promoLabels/);
  refuse({ meta, data: { txs: {} } }, /data\.txs/);
  refuse({ meta, data: { feed: { events: [{ id: "x" }], cursor: null, deliveries: 0, lastDeliveryAt: null } } }, /data\.feed\.events/);
});

test("readBackup_aSectionTheBackupLacks_isEmpty", () => {
  const { meta, data: read } = readBackup({ meta: { version: 1, vault: VAULT, at: NOW, settings: { CARDS_FROM_PROMO: "24", BAD: 3 } }, data: { promoLabels: { "9": label("Wings") } } });
  assert.deepEqual(read, { ...empty(), promoLabels: { "9": label("Wings") } });
  assert.deepEqual(meta, { version: 1, vault: VAULT, at: NOW, commit: null, settings: { CARDS_FROM_PROMO: "24" } });
});

// ---- The routes ----

/** A keeper on a fake chain with one promo, the vault's books, and blocks with no logs. */
function keeper(opts: { backupKey?: string; store?: Store; limits?: Partial<Limits>; client?: PublicClient; settings?: Record<string, string> } = {}) {
  const store = opts.store ?? new Store(null, VAULT);
  const client =
    opts.client ??
    ({
      getBlockNumber: async () => 1n,
      readContract: async () => 1_000_000n,
      multicall: async ({ contracts }: { contracts: Array<{ functionName: string }> }) =>
        contracts.map(({ functionName }) =>
          functionName === "getPromo"
            ? { merchant: ALICE, geminiEventId: hex(11), instrumentSymbol: hex(22), payoutPerClaim: 8_000_000n, maxClaims: 2, claimCount: 0, paidCount: 0, premiumPaid: 7_060_000n, collateralLocked: 16_000_000n, claimDeadline: 0n, marketCloseTime: 0n, settledAt: 0n, status: Status.Open, outcomeYes: false, hedgeMode: false }
            : functionName === "promoCount" ? 1n
            : functionName === "paused" ? false
            : functionName === "maxExposureBps" ? 2000
            : functionName === "disputeWindow" ? 3600
            : 0n,
        ),
    } as unknown as PublicClient);
  const feed = new Feed({ store, vault: VAULT, log: quiet });
  const unused = {} as never;
  const app = makeApp({
    client, vault: VAULT, usdc: USDC, maxLockedBps: 6000, pricer: { address: ALICE } as never, games: unused, relayer: { address: BOB } as never,
    oracle: VAULT, store, feed, backupKey: opts.backupKey, settings: opts.settings, limits: { ...LIMITS, ...opts.limits }, now: () => NOW * 1000,
  });
  const get = (path: string, headers: Record<string, string> = { "x-backup-key": KEY }) => app.request(path, { headers });
  const restore = (body: unknown, headers: Record<string, string> = { "x-backup-key": KEY }) =>
    app.request("/restore", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
  return { app, store, feed, get, restore };
}

const backupOf = (d: Data, vault: Address = VAULT): Backup => ({ meta: { version: 1, vault, at: NOW, commit: "24800e1", settings: {} }, data: d });

test("backupAndRestore_onAKeeperWithNoKey_are404Off", async () => {
  const { get, restore } = keeper();
  for (const res of [await get("/backup"), await restore(backupOf(fullBackup()))]) {
    assert.equal(res.status, 404);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, "off");
  }
});

test("backupAndRestore_withoutTheKey_orWithAnotherOne_are401_andNothingIsRestored", async () => {
  const { get, restore, store } = keeper({ backupKey: KEY });
  for (const headers of [{}, { "x-backup-key": "a-guess" }] as Record<string, string>[]) {
    assert.equal((await get("/backup", headers)).status, 401);
    const res = await restore(backupOf(fullBackup()), headers);
    assert.equal(res.status, 401);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, "unauthorized");
  }
  assert.deepEqual(store.data.promoLabels, {});
});

test("getBackup_isTheWholeFile_withTheVaultTheTimeTheBuildAndThePlainSettings", async () => {
  const store = new Store(null, VAULT);
  Object.assign(store.data, fullBackup(), { vault: VAULT });
  const settings = { CARDS_FROM_PROMO: "24", STARTER_AMOUNT: "8" };
  const { get } = keeper({ backupKey: KEY, store, settings });
  const res = await get("/backup");
  assert.equal(res.status, 200);
  const body = (await res.json()) as Backup;
  assert.deepEqual(body.meta, { version: 1, vault: VAULT, at: NOW, commit: process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) ?? null, settings });
  assert.deepEqual(body.data, JSON.parse(JSON.stringify(store.data)));
});

test("postRestore_aBackupOfAnotherVault_is409_andNothingIsRestored", async () => {
  const { restore, store } = keeper({ backupKey: KEY });
  const res = await restore(backupOf(fullBackup(), OTHER));
  assert.equal(res.status, 409);
  assert.equal(((await res.json()) as { error: { code: string } }).error.code, "other-vault");
  assert.deepEqual(store.data.promoLabels, {});
});

test("postRestore_aBodyThatIsNotABackup_is400", async () => {
  const { restore, store } = keeper({ backupKey: KEY });
  for (const body of ["{not json", JSON.stringify({ hello: 1 }), JSON.stringify(backupOf(data({ odds: { "9": "lots" as never } })))]) {
    const res = await restore(body);
    assert.equal(res.status, 400, body);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, "bad-request");
  }
  assert.deepEqual(store.data, new Store(null, VAULT).data);
});

test("postRestore_aBodyLargerThanABackupCanBe_is413", async () => {
  const { app } = keeper({ backupKey: KEY });
  const res = await app.request("/restore", {
    method: "POST",
    headers: { "x-backup-key": KEY, "content-type": "application/json", "content-length": String(MAX_BACKUP_BYTES + 1) },
    body: "{}",
  });
  assert.equal(res.status, 413);
  assert.equal(((await res.json()) as { error: { code: string } }).error.code, "too-large");
});

test("restore_thenBackup_givesBackWhatTheOldKeeperHad_andASecondRestoreAddsNothing", async () => {
  // The old keeper, with a full file.
  const oldStore = new Store(null, VAULT);
  Object.assign(oldStore.data, fullBackup(), { vault: VAULT });
  const old = keeper({ backupKey: KEY, store: oldStore });
  const pulled = await (await old.get("/backup")).json();

  // The new one, made again from nothing, with one event it read from the chain by itself.
  const fresh = keeper({ backupKey: KEY });
  fresh.store.data.feed.events.push(ev(100, 0, "rpc"));
  fresh.store.data.feed.cursor = 150;
  fresh.feed.reload();
  const res = await fresh.restore(pulled);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; from: { at: number; commit: string | null }; added: Record<string, number> };
  assert.equal(body.ok, true);
  assert.equal(body.added.promoLabels, 2);
  assert.equal(body.added.feedEvents, 1);
  assert.equal(body.added.feedViaStream, 1, "the event the new keeper read itself is now the Stream's, as it first came");
  assert.equal(body.added.liveQuotes, 1);

  const back = (await (await fresh.get("/backup")).json()) as Backup;
  const want = JSON.parse(JSON.stringify(oldStore.data)) as Data;
  for (const name of ["events", "instruments", "claims", "pendingLabels", "promoLabels", "odds", "oddsStart", "pendingOdds", "hedges", "starter", "txs"] as const) {
    assert.deepEqual(back.data[name], want[name], name);
  }
  assert.deepEqual(back.data.feed.events, want.feed.events);
  assert.equal(back.data.feed.cursor, 150, "the new keeper's own read goes on from where it is");

  const again = (await (await fresh.restore(pulled)).json()) as { added: Record<string, number> };
  assert.ok(Object.values(again.added).every((n) => n === 0), JSON.stringify(again.added));
  assert.deepEqual(await (await fresh.get("/backup")).json(), back);
});

test("postRestore_dropsTheSharedVaultRead_soTheRestoredWordsShowAtOnce", async () => {
  const { app, restore } = keeper({ backupKey: KEY });
  const before = (await (await app.request("/vault")).json()) as { promos: Array<{ item: string | null; game: string | null }> };
  assert.deepEqual([before.promos[0]!.item, before.promos[0]!.game], [null, null]);
  await restore(backupOf(data({ promoLabels: { "0": label("Wings") }, events: fullBackup().events })));
  // Within the two seconds the read is shared for.
  const after = (await (await app.request("/vault")).json()) as { promos: Array<{ item: string | null; game: string | null }> };
  assert.deepEqual([after.promos[0]!.item, after.promos[0]!.game], ["Wings", "Patriots at Lions"]);
});

test("postRestore_savesTheFileOnce_withTheRestoredData", async () => {
  const dir = tempDir();
  try {
    const store = new Store(dir, VAULT, quiet);
    const { restore } = keeper({ backupKey: KEY, store });
    assert.equal((await restore(backupOf(fullBackup()))).status, 200);
    const saved = onDisk(dir);
    assert.deepEqual(saved.promoLabels, fullBackup().promoLabels);
    assert.equal(saved.vault, VAULT);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- A restored event and the feed's next read of the chain ----

type ChainLog = { address: string; topics: Hex[]; data: Hex; blockNumber: Hex; blockTimestamp: Hex; transactionHash: Hex; logIndex: Hex };
const logs = JSON.parse(readFileSync(new URL("./fixtures/vault-logs.json", import.meta.url), "utf8")) as ChainLog[];

test("aRestoredEvent_isNotAddedASecondTime_byTheFeedsNextReadOfTheChain", async () => {
  // The old keeper had every event of the fixture, by the Stream.
  const oldStore = new Store(null, VAULT);
  const oldFeed = new Feed({ store: oldStore, vault: VAULT, log: quiet, now: () => NOW * 1000 });
  oldFeed.deliver({ events: logs });
  assert.equal(oldStore.data.feed.events.length, 12);

  // The new keeper has read nothing yet: its cursor is null. The backup is restored before its first read,
  // an hour after the newest log, so no log waits for the Stream.
  const head = Math.max(...logs.map((l) => Number(l.blockNumber))) + 10;
  const first = Math.min(...logs.map((l) => Number(l.blockNumber)));
  const later = (Math.max(...logs.map((l) => Number(l.blockTimestamp))) + 3600) * 1000;
  const client = {
    getBlockNumber: async () => BigInt(head),
    getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) =>
      logs
        .filter((l) => Number(l.blockNumber) >= Number(fromBlock) && Number(l.blockNumber) <= Number(toBlock))
        .map((l) => ({ ...l, blockNumber: BigInt(l.blockNumber), blockTimestamp: BigInt(l.blockTimestamp), logIndex: Number(l.logIndex) })),
  } as unknown as PublicClient;
  const store = new Store(null, VAULT);
  const feed = new Feed({ store, vault: VAULT, client, log: quiet, startBlock: first, now: () => later });
  const unused = {} as never;
  const app = makeApp({ client, vault: VAULT, usdc: USDC, maxLockedBps: 6000, pricer: unused, games: unused, relayer: unused, oracle: VAULT, store, feed, backupKey: KEY });
  const seen: FeedEvent[] = [];
  feed.subscribe((event) => seen.push(event));

  const res = await app.request("/restore", { method: "POST", headers: { "x-backup-key": KEY }, body: JSON.stringify(backupOf(oldStore.data)) });
  assert.equal(res.status, 200);
  assert.equal(store.data.feed.events.length, 12);

  // The read of the chain covers every block of the fixture and adds nothing.
  assert.equal(await feed.catchUp(), 0);
  assert.equal(store.data.feed.cursor, head);
  assert.equal(store.data.feed.events.length, 12);
  assert.ok(store.data.feed.events.every((e) => e.via === "stream"));
  assert.deepEqual(seen, [], "no page is told of an old event as if it were new");

  // What the feed's reload prevents: the same merge written into a store whose feed did not read its
  // events again, and the same read of the chain adds every one of them a second time.
  const bare = new Store(null, VAULT);
  const bareFeed = new Feed({ store: bare, vault: VAULT, client, log: quiet, startBlock: first, now: () => later });
  applyInto(bare.data, mergeData(bare.data, oldStore.data, NOW).data);
  assert.equal(await bareFeed.catchUp(), 12);
  assert.equal(bare.data.feed.events.length, 24);
});

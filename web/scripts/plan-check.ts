// Checks the plan page's server side: the arithmetic on fixed books, then the real reads of Kalshi's and
// Polymarket US's public data (no key, nothing is sent or ordered). Run: pnpm check:plan
import assert from "node:assert/strict";
import { contractsFor, fillsCleanly, order, readVoucher, voucherUrl, type Book } from "@/lib/plan";
import { Refusal } from "@/lib/server/http";
import { kalshiBookOf, LEAGUES } from "@/lib/server/kalshi";
import { books, games, voucherMarket } from "@/lib/server/plan-data";
import { matchGame, polymarketBookOf, type PolymarketGame } from "@/lib/server/polymarket";

function math() {
  // 50 customers at $8.00 is $400 to give away: 400 contracts, each paying $1.00.
  assert.equal(contractsFor(8_000_000n, 50), 400);
  assert.equal(contractsFor(7_990_000n, 3), 24); // $23.97 rounds up to 24
  assert.equal(contractsFor(0n, 50), 0);

  // Kalshi's own table: 100 contracts at 50 cents cost $50.00 and a $1.75 fee; at 61 cents, $1.67.
  const flat: Book = { bid: 0.49, asks: [{ price: 0.5, size: 1000 }] };
  const a = order(flat, 100, 0.07);
  assert.deepEqual([a.cost, a.fee, a.filled, a.limit, a.average], [50_000_000n, 1_750_000n, 100, 0.5, 0.5]);
  assert.equal(order({ bid: 0.6, asks: [{ price: 0.61, size: 1000 }] }, 100, 0.07).fee, 1_670_000n);

  // An order bigger than the best offer walks up the book: 285.69 at 61, 260 at 62, the rest at 63.
  const thin: Book = { bid: 0.59, asks: [{ price: 0.61, size: 285.69 }, { price: 0.62, size: 260 }, { price: 0.63, size: 622 }] };
  const b = order(thin, 800, 0.07);
  assert.equal(b.filled, 800);
  assert.equal(b.limit, 0.63);
  assert.equal(b.steps.length, 3);
  const dollars = 285.69 * 0.61 + 260 * 0.62 + (800 - 285.69 - 260) * 0.63;
  assert.equal(b.cost, BigInt(Math.ceil(dollars * 100 - 1e-6)) * 10_000n);
  assert.ok(fillsCleanly(b));
  // More than the book offers: what is there is filled, and the order is not clean.
  const c = order(thin, 2000, 0.07);
  assert.equal(Math.round(c.filled * 100), 116_769);
  assert.ok(!fillsCleanly(c));
  assert.ok(!fillsCleanly(order({ bid: 0.5, asks: [{ price: 0.51, size: 10 }, { price: 0.6, size: 500 }] }, 100, 0.07)));
  assert.equal(order({ bid: null, asks: [] }, 100, 0.07).filled, 0);

  // Kalshi lists bids only: a "no" bid at 39 cents is an offer of "yes" at 61.
  const kalshi = kalshiBookOf({ orderbook_fp: { yes_dollars: [["0.5800", "453.74"], ["0.5900", "8.10"]], no_dollars: [["0.3800", "260.00"], ["0.3900", "285.69"]] } });
  assert.deepEqual(kalshi, { bid: 0.59, asks: [{ price: 0.61, size: 285.69 }, { price: 0.62, size: 260 }] });

  // Polymarket US: the home team is the short side, bought from the bids.
  const body = { marketData: { bids: [{ px: { value: "0.3800" }, qty: "7034.31" }, { px: { value: "0.3900" }, qty: "810.69" }], offers: [{ px: { value: "0.4100" }, qty: "749.7" }, { px: { value: "0.4000" }, qty: "2.84" }] } };
  assert.deepEqual(polymarketBookOf(body, true), { bid: 0.39, asks: [{ price: 0.4, size: 2.84 }, { price: 0.41, size: 749.7 }] });
  assert.deepEqual(polymarketBookOf(body, false), { bid: 0.6, asks: [{ price: 0.61, size: 810.69 }, { price: 0.62, size: 7034.31 }] });

  const pm: PolymarketGame[] = [
    { startTime: 1000, slug: "a", event: "a", fee: 0.11, away: { name: "heat", long: true }, home: { name: "knicks", long: false } },
    { startTime: 1000, slug: "b", event: "b", fee: 0.11, away: { name: "trailblazers", long: true }, home: { name: "76ers", long: false } },
  ];
  assert.equal(matchGame(pm, 1000, "Heat", "Knicks")?.slug, "a");
  assert.equal(matchGame(pm, 1000, "Trail Blazers", "76ers")?.slug, "b");
  assert.equal(matchGame(pm, 5000, "Heat", "Knicks"), null);
  assert.equal(matchGame(pm, 1000, "Knicks", "Heat"), null);

  const voucher = { ticker: "KXNBAGAME-26NOV27MIANYK-NYK", item: "Wings & fries", business: "Tony's Bar", number: 7, of: 50, until: 1_800_000_000 };
  const url = new URL(voucherUrl("https://freeif.app", voucher));
  assert.deepEqual(readVoucher(Object.fromEntries(url.searchParams)), voucher);
  assert.equal(readVoucher({ t: "KXNBAGAME-26NOV27MIANYK-NYK/../x" }), null);
  assert.equal(readVoucher({ t: "BTC05M2611130430" }), null);
  console.log("math: ok");
}

async function refused(label: string, run: Promise<unknown>) {
  try {
    await run;
    console.log(`NOT REFUSED: ${label}`);
    process.exitCode = 1;
  } catch (err) {
    console.log(`refused (${label}):`, err instanceof Refusal ? `${err.status} ${err.code} | ${err.message}` : String(err));
    if (!(err instanceof Refusal)) process.exitCode = 1;
  }
}

async function live() {
  let sample: { ticker: string; slug: string | null; long: boolean; label: string } | null = null;
  for (const league of LEAGUES) {
    const t0 = Date.now();
    const reply = await games(league.key);
    const matched = reply.games.filter((g) => g.teams.every((t) => t.polymarket !== null)).length;
    const priced = reply.games.filter((g) => g.teams.every((t) => t.ask !== null)).length;
    console.log(`${league.key}: ${reply.games.length} games not started, ${priced} with both teams offered on Kalshi, ${matched} found on Polymarket US (${Date.now() - t0} ms)`);
    for (const g of reply.games.slice(0, 3)) {
      console.log(`   ${new Date(g.startTime * 1000).toISOString()}  ${g.game}  [Kalshi: ${g.kalshiTitle}]  ${g.teams.map((t) => `${t.name} ${t.ask ?? "-"}${t.polymarket ? "" : " (not on Polymarket US)"}`).join(" / ")}`);
    }
    const missing = reply.games.filter((g) => g.teams.some((t) => t.polymarket === null));
    if (missing.length > 0) console.log(`   not found on Polymarket US: ${missing.slice(0, 6).map((g) => `${g.game} (${new Date(g.startTime * 1000).toISOString().slice(5, 16)})`).join("; ")}${missing.length > 6 ? "; ..." : ""}`);
    const first = reply.games.find((g) => g.teams.every((t) => t.ask !== null && t.polymarket !== null));
    if (first && !sample) {
      const team = first.teams[1]!;
      sample = { ticker: team.ticker, slug: team.polymarket!.slug, long: team.polymarket!.long, label: `${team.name} in ${first.game}` };
    }
  }
  if (!sample) throw new Error("No game with both exchanges to read a book for.");

  const reply = await books(sample.ticker, sample.slug, sample.long);
  console.log(`books for ${sample.label} (${sample.ticker}; ${sample.slug}, ${sample.long ? "long" : "short"}):`);
  for (const [name, book, rate] of [["Kalshi", reply.kalshi, reply.fees.kalshi], ["Polymarket US", reply.polymarket, reply.fees.polymarket]] as const) {
    if (!book) {
      console.log(`   ${name}: no book`);
      continue;
    }
    const o = order(book, 400, rate);
    console.log(
      `   ${name}: bid ${book.bid}, ${book.asks.length} offers, best ${book.asks[0]?.price} x ${book.asks[0]?.size}; 400 contracts: filled ${o.filled}, cost ${o.cost}, fee ${o.fee} (rate ${rate}), average ${o.average?.toFixed(4)}, limit ${o.limit}, clean ${fillsCleanly(o)}`,
    );
  }
  assert.ok(reply.kalshi.asks.every((l, i, all) => i === 0 || l.price > all[i - 1]!.price), "Kalshi's offers are not cheapest first");

  const open = await voucherMarket(sample.ticker);
  console.log("voucher, a game not played:", JSON.stringify(open));
  assert.equal(open.final, false);

  await refused("a ticker that is not a game", books("BTC05M2611130430", null, false));
  await refused("a slug with a path in it", books(sample.ticker, "../v1/x", false));
  await refused("a league we don't list", games("mlb"));
  await refused("a voucher for no market", voucherMarket("KXNBAGAME-26NOV27MIANYK-ZZZ"));
}

async function main() {
  math();
  await live();
  // Any tickers given are games with a result: `pnpm check:plan KXNBAGAME-26NOV24DALDEN-DAL`.
  for (const settled of process.argv.slice(2)) console.log("voucher, a game with a result:", JSON.stringify(await voucherMarket(settled)));
  console.log(process.exitCode ? "FAILED" : "OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

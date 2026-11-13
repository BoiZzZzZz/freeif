// The keeper's HTTP API: prices and signed quotes for the merchant form, claims for the customer page,
// the QuickNode Stream's webhook, and the vault's events for the pages that show a promo.
// Amounts are USDC base units (6 decimals) as decimal strings. Times are unix seconds.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { getConnInfo } from "@hono/node-server/conninfo";
import { createPublicClient, erc20Abi, http, isAddress, type Address } from "viem";
import { promoVaultAbi } from "./abi.ts";
import { CHAIN_ID, rpcUrls } from "./config.ts";
import { Status, arcTestnet, statusName, type PublicClient } from "./chain.ts";
import { LEAGUES, WEATHER, type Games } from "./games.ts";
import type { Odds } from "./odds.ts";
import { getEvent, isIntervalMarket, priceToBps, upcomingIntervalTickers } from "./gemini.ts";
import { cleanText, findLabel } from "./labels.ts";
import { Gate, LIMITS, Limiter, type Limits } from "./limit.ts";
import { Pricer, Refusal, type PriceRequest } from "./pricer.ts";
import { ClaimRefusal, Relayer } from "./relayer.ts";
import { sleep } from "./sleep.ts";
import type { Store } from "./store.ts";
import type { Feed, FeedEvent } from "./stream.ts";

type Deps = {
  client: PublicClient;
  vault: Address;
  /** The token the vault holds. */
  usdc: Address;
  /** The pricing service's ceiling: it signs no quote that would leave more than this locked. */
  maxLockedBps: number;
  pricer: Pricer;
  games: Games;
  relayer: Relayer;
  oracle: Address;
  store: Store;
  feed: Feed;
  /** The readings of each promo's chance. Without it the keeper has none to give (tests). */
  odds?: Odds;
  /** The test loop's key for claims with no login. Undefined turns that way in off. */
  testKey?: string;
  /** The secret the QuickNode Stream sends with each delivery. Undefined refuses every delivery. */
  streamSecret?: string;
  /** How much one client may ask (limit.ts). Tests pass smaller numbers. */
  limits?: Limits;
  /** The clock the limits are counted on (tests). */
  now?: () => number;
};

class BadRequest extends Error {}

/** An open event stream gets a line this often when nothing happens, so no proxy closes it as idle. */
const EVENTS_PING_MS = 20_000;
/** How long a promo read from the chain is served again before the chain is asked once more. */
const PROMO_READ_MS = 1_000;
/** The same for the whole vault, which is every promo in one read. */
const VAULT_READ_MS = 2_000;
const VAULT_EVENTS = 60;
const MAX_DELIVERY_BYTES = 2 * 1024 * 1024;
/** Promo reads held at once before the ones that have run out are dropped. */
const MAX_PROMO_READS = 500;

/**
 * The address a request came from, which is all that names a client of the open routes. Railway's proxy
 * puts it in `X-Real-IP`; a keeper with no proxy in front of it reads the connection itself.
 */
function clientOf(c: Context): string {
  const real = c.req.header("x-real-ip")?.trim();
  if (real) return real;
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown";
  }
}

function tooMany(c: Context, seconds: number): Response {
  c.header("Retry-After", String(seconds));
  return c.json({ error: { code: "too-many", message: "That's a lot of requests at once. Try again in a minute." } }, 429);
}

/**
 * Server-sent events: each vault event that `wanted` accepts, the moment it reaches the feed. The page
 * reads the promo again when one arrives, so an event that is missed while the connection is down costs
 * nothing: the page also reads the promo when the connection comes back.
 */
function eventStream(c: Context, feed: Feed, gate: Gate, wanted: (event: FeedEvent) => boolean): Response {
  // A stream is a connection held open, so they are counted while they are open. A page that is
  // refused one still reads the promo on its timer, and asks for the stream again.
  const leave = gate.enter(clientOf(c));
  if (leave === null) return tooMany(c, 30);
  // Tells a proxy in front of the keeper to pass each line on as it is written.
  c.header("X-Accel-Buffering", "no");
  return streamSSE(c, async (stream) => {
    const queue: FeedEvent[] = [];
    let wake: (() => void) | null = null;
    let open = true;
    const stop = feed.subscribe((event) => {
      if (!wanted(event)) return;
      queue.push(event);
      wake?.();
    });
    stream.onAbort(() => {
      open = false;
      leave();
      wake?.();
    });
    try {
      // The first line tells the page it is connected, and to come back 2 seconds after a drop.
      await stream.writeSSE({ event: "ready", data: "{}", retry: 2000 });
      while (open) {
        for (let event = queue.shift(); event !== undefined; event = queue.shift()) {
          await stream.writeSSE({ event: "vault", id: event.id, data: JSON.stringify(event) });
        }
        await sleep(EVENTS_PING_MS, undefined, (w) => { wake = w; });
        wake = null;
        if (open && queue.length === 0) await stream.write(": still here\n\n");
      }
    } finally {
      stop();
      leave();
    }
  });
}

const CLAIM_STATUS: Partial<Record<ClaimRefusal["code"], 401 | 403 | 409 | 502>> = {
  login: 401,
  "not-your-wallet": 403,
  "already-claimed": 409,
  failed: 502,
};

/** Compares two secrets without giving away, by the time it takes, how much of a guess was right. */
function sameSecret(given: string | undefined, secret: string): boolean {
  if (given === undefined) return false;
  const hash = (text: string) => createHash("sha256").update(text).digest();
  return timingSafeEqual(hash(given), hash(secret));
}

/**
 * QuickNode signs each delivery: the hex HMAC-SHA256, under the Stream's security token, of the nonce,
 * the timestamp and the body as one string (the body after decompression, exactly as sent).
 */
export function validSignature(
  token: string,
  nonce: string | undefined,
  timestamp: string | undefined,
  body: string,
  given: string | undefined,
): boolean {
  if (!nonce || !timestamp || given === undefined || !/^[0-9a-fA-F]{64}$/.test(given)) return false;
  const expected = createHmac("sha256", token).update(nonce + timestamp + body).digest();
  return timingSafeEqual(expected, Buffer.from(given, "hex"));
}

function parsePriceRequest(input: Record<string, unknown>): PriceRequest {
  const text = (name: string): string => {
    const value = input[name];
    if (typeof value !== "string" || value === "") throw new BadRequest(`${name} is required`);
    return value;
  };
  const whole = (name: string): string => {
    const value = typeof input[name] === "number" ? String(input[name]) : text(name);
    if (!/^\d+$/.test(value)) throw new BadRequest(`${name} must be a whole number`);
    return value;
  };

  let claimDeadline: PriceRequest["claimDeadline"];
  const raw = input.claimDeadline;
  if (raw === undefined || raw === "" || raw === "start") claimDeadline = "start";
  else if (raw === "30min") claimDeadline = "30min";
  else if (/^\d+$/.test(String(raw))) claimDeadline = Number(raw);
  else throw new BadRequest(`claimDeadline must be "start", "30min" or a unix time`);

  return {
    eventTicker: text("eventTicker"),
    instrumentSymbol: text("instrumentSymbol"),
    payoutPerClaim: BigInt(whole("payoutPerClaim")),
    maxClaims: Number(whole("maxClaims")),
    claimDeadline,
  };
}

export function makeApp(d: Deps): Hono {
  const app = new Hono();
  app.use("*", cors());

  // The limits come after CORS, so that a page can read a refusal. `/health` is left out because the web
  // app's own server asks it for the vault's address, and the webhook because it has its own proof.
  const limits = d.limits ?? LIMITS;
  const limiter = new Limiter(d.now);
  const streams = new Gate(limits.streams.perClient, limits.streams.inAll);
  app.use("*", async (c, next) => {
    const path = c.req.path;
    if (path === "/health" || path === "/stream") return next();
    const post = c.req.method === "POST";
    const own =
      path === "/quote" && post ? limits.quote
      : path === "/claims" && post ? limits.claims
      : path === "/price" ? limits.price
      : path === "/intervals" ? limits.intervals
      : path === "/health/rpc" ? limits.rpc
      : null;
    const who = clientOf(c);
    const wait = limiter.take(limits.all, who) || (own === null ? 0 : limiter.take(own, who));
    if (wait > 0) return tooMany(c, wait);
    return next();
  });

  app.onError((err, c) => {
    if (err instanceof Refusal) {
      return c.json(
        { error: { code: err.code, message: err.message, maxCustomers: err.maxCustomers, maxPayout: err.maxPayout?.toString() } },
        422,
      );
    }
    if (err instanceof ClaimRefusal) {
      return c.json({ error: { code: err.code, message: err.message } }, CLAIM_STATUS[err.code] ?? 422);
    }
    if (err instanceof BadRequest || err instanceof SyntaxError) {
      return c.json({ error: { code: "bad-request", message: err.message } }, 400);
    }
    console.error("[server]", err);
    return c.json({ error: { code: "internal", message: "Something went wrong on our side." } }, 500);
  });

  app.get("/health", async (c) => {
    const block = await d.client.getBlockNumber();
    return c.json({
      ok: true,
      chainId: CHAIN_ID,
      vault: d.vault,
      pricer: d.pricer.address,
      oracle: d.oracle,
      relayer: d.relayer.address,
      block: Number(block),
      // The commit this build was made from, when the host says (Railway does). Null on a laptop.
      commit: process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
      // The feed: what the QuickNode Stream has delivered, and how far the keeper's own read has come.
      stream: { ...d.feed.status(), webhook: d.streamSecret !== undefined },
    });
  });

  // The QuickNode Stream's webhook. A delivery is the vault's logs of one block, as `stream/filter.js`
  // returns them. Only a request that carries the Stream's secret is read.
  app.post("/stream", bodyLimit({ maxSize: MAX_DELIVERY_BYTES }), async (c) => {
    const secret = d.streamSecret;
    const refused = () => c.json({ error: { code: "unauthorized", message: "This is the Stream's webhook." } }, 401);
    if (secret === undefined) return refused();

    let text: string;
    try {
      const bytes = Buffer.from(await c.req.arrayBuffer());
      const gzipped = /gzip/i.test(c.req.header("content-encoding") ?? "");
      text = (gzipped ? gunzipSync(bytes, { maxOutputLength: MAX_DELIVERY_BYTES * 8 }) : bytes).toString("utf8");
    } catch {
      throw new BadRequest("the delivery cannot be read");
    }
    // Two proofs that a delivery is the Stream's: QuickNode's signature over the body, made with the
    // Stream's security token, or the secret header the Stream is set to send. The token and the header
    // are the same secret (scripts/stream.ts sets both).
    const signed = validSignature(secret, c.req.header("x-qn-nonce"), c.req.header("x-qn-timestamp"), text, c.req.header("x-qn-signature"));
    if (!signed && !sameSecret(c.req.header("x-stream-secret"), secret)) return refused();

    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new BadRequest("the delivery is not JSON");
    }
    // A delivery with no vault event in it (QuickNode's test message) is answered the same way: 200.
    return c.json({ ok: true, signed, ...d.feed.deliver(body, signed) });
  });

  // Every vault event as it happens, as server-sent events. `/promos/:id/events` is one promo's.
  app.get("/events", (c) => eventStream(c, d.feed, streams, () => true));

  // The newest vault events of every kind, oldest first, and the Stream's record.
  app.get("/feed", (c) => {
    const limit = Number(c.req.query("limit") ?? 100);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new BadRequest("limit must be 1 to 1000");
    return c.json({ stream: d.feed.status(), events: d.feed.recent(limit) });
  });

  // Each RPC endpoint on its own, in the order the keeper tries them. The URLs stay private.
  app.get("/health/rpc", async (c) => {
    const endpoints = await Promise.all(
      rpcUrls().map(async (url, i) => {
        const started = Date.now();
        try {
          const one = createPublicClient({ chain: arcTestnet, transport: http(url, { timeout: 8_000, retryCount: 0 }) });
          const block = await one.getBlockNumber();
          return { endpoint: i + 1, ok: true, block: Number(block), ms: Date.now() - started };
        } catch {
          return { endpoint: i + 1, ok: false, block: null, ms: Date.now() - started };
        }
      }),
    );
    return c.json({ ok: endpoints.some((e) => e.ok), endpoints });
  });

  // The price of a promo, unsigned. No merchant needed: the form shows it before login.
  app.get("/price", async (c) => c.json(await d.pricer.getPrice(parsePriceRequest(c.req.query()))));

  // A signed quote for `createPromo(quote, signature)`. Usable for 90 seconds, by `merchant` only.
  app.post("/quote", async (c) => {
    const body = (await c.req.json()) as Record<string, unknown>;
    const merchant = body.merchant;
    if (typeof merchant !== "string" || !isAddress(merchant)) throw new BadRequest("merchant must be an address");
    const label = { item: cleanText(body.item), business: cleanText(body.business) };
    const request = parsePriceRequest(body);
    // A 5 or 15-minute market is sold while it is running, and a signed quote stands for 90 seconds: on
    // such a market that is time to watch the price and use the quote only if it moved the buyer's way,
    // at the vault's cost. So a quote on one is the test loop's alone, behind the test key. With no key
    // set on the keeper these markets are not sold at all. `GET /price` is unsigned and stays open.
    if (isIntervalMarket({ ticker: request.eventTicker }) && (d.testKey === undefined || !sameSecret(c.req.header("x-test-key"), d.testKey))) {
      throw new Refusal("test-only", "This market is for testing only.");
    }
    return c.json(await d.pricer.signQuote({ ...request, merchant, hedgeMode: body.hedgeMode === true, label }));
  });

  // Step 1 of the merchant form: one league's games that have not started, each team with its chance.
  // `leagues` is the list of tabs; without `league` the first one is returned.
  app.get("/games", async (c) => {
    const key = c.req.query("league") ?? LEAGUES[0].key;
    const league = LEAGUES.find((l) => l.key === key);
    if (!league) throw new BadRequest(`league must be one of ${LEAGUES.map((l) => l.key).join(", ")}`);
    const leagues = LEAGUES.map(({ key, name }) => ({ key, name }));
    return c.json({ leagues, ...(await d.games.list(league)) });
  });

  // Step 1 of the form in hedge mode ("My business gets paid"): Gemini's daily high-temperature markets
  // whose day has not begun, in the shape of `/games`. Each city and day is a "game", each range a "team".
  app.get("/weather", async (c) => c.json(await d.games.list(WEATHER)));

  // Registers a customer on a promo. `userToken` is the customer's Circle login: the relayer asks Circle
  // whose it is. One claim per Circle user per promo, for an address that is one of that user's wallets.
  app.post("/claims", async (c) => {
    const body = (await c.req.json()) as Record<string, unknown>;
    if (!/^\d+$/.test(String(body.promoId))) throw new BadRequest("promoId must be a whole number");
    if (typeof body.customer !== "string") throw new BadRequest("customer is required");
    const promoId = BigInt(String(body.promoId));

    // The test loop's customers are plain keys with no login. With the test key in the `X-Test-Key`
    // header it names them itself (`testUser`). With no key set on the keeper this way in does not exist.
    if (body.testUser !== undefined) {
      if (d.testKey === undefined || !sameSecret(c.req.header("x-test-key"), d.testKey)) {
        throw new ClaimRefusal("login", "Please log in again.");
      }
      if (typeof body.testUser !== "string" || body.testUser === "") throw new BadRequest("testUser must be a name");
      return c.json(await d.relayer.registerTestClaim(promoId, body.customer, body.testUser));
    }

    if (typeof body.userToken !== "string" || body.userToken === "") throw new BadRequest("userToken is required");
    return c.json(await d.relayer.registerClaim(promoId, body.customer, body.userToken));
  });

  // A promo as the chain has it, in one call, kept for a second and shared by every request that comes
  // in meanwhile: when an event arrives, every page that shows the promo asks at once. Null is a promo
  // the vault does not have.
  const reads = new Map<string, { at: number; value: ReturnType<typeof readChain> }>();
  async function readChain(id: bigint) {
    const call = { address: d.vault, abi: promoVaultAbi } as const;
    const [count, totalOwed, promo, claimants] = await d.client.multicall({
      allowFailure: true,
      contracts: [
        { ...call, functionName: "promoCount" },
        { ...call, functionName: "totalOwedPayouts" },
        { ...call, functionName: "getPromo", args: [id] },
        { ...call, functionName: "getClaimants", args: [id] },
      ],
    });
    if (count.status !== "success") throw count.error;
    if (id >= count.result) return null;
    if (promo.status !== "success") throw promo.error;
    if (claimants.status !== "success") throw claimants.error;
    if (totalOwed.status !== "success") throw totalOwed.error;
    return { promo: promo.result, claimants: claimants.result, anyOwed: totalOwed.result > 0n };
  }
  function readPromo(id: bigint): ReturnType<typeof readChain> {
    const key = id.toString();
    const held = reads.get(key);
    if (held && Date.now() - held.at < PROMO_READ_MS) return held.value;
    const value = readChain(id);
    // Ids nobody asks about again would otherwise stay for good.
    if (reads.size >= MAX_PROMO_READS) {
      for (const [k, read] of reads) if (Date.now() - read.at >= PROMO_READ_MS) reads.delete(k);
    }
    reads.set(key, { at: Date.now(), value });
    // A read that failed is not served again.
    value.catch(() => {
      if (reads.get(key)?.value === value) reads.delete(key);
    });
    return value;
  }
  // An event changes its promo: the next request reads the chain again.
  d.feed.subscribe((event) => {
    if (event.promoId !== null) reads.delete(event.promoId);
  });

  // The vault as a liquidity provider reads it: its books, every promo with what it locks and what it
  // made, and the newest events. Everything is read at one block, kept for two seconds and shared; any
  // event drops it.
  let vaultRead: { at: number; value: ReturnType<typeof readVault> } | null = null;
  async function readVault() {
    const call = { address: d.vault, abi: promoVaultAbi } as const;
    const blockNumber = await d.client.getBlockNumber();
    const [balance, books] = await Promise.all([
      d.client.readContract({ address: d.usdc, abi: erc20Abi, functionName: "balanceOf", args: [d.vault], blockNumber }),
      d.client.multicall({
        allowFailure: false,
        blockNumber,
        contracts: [
          { ...call, functionName: "lockedCollateral" },
          { ...call, functionName: "pendingCollateral" },
          { ...call, functionName: "totalOwedPayouts" },
          { ...call, functionName: "totalShares" },
          { ...call, functionName: "maxExposureBps" },
          { ...call, functionName: "paused" },
          { ...call, functionName: "disputeWindow" },
          { ...call, functionName: "promoCount" },
        ],
      }),
    ]);
    const [locked, pending, owed, totalShares, maxExposureBps, paused, disputeWindow, count] = books;
    const ids = Array.from({ length: Number(count) }, (_, i) => BigInt(i));
    const chain =
      ids.length === 0
        ? []
        : await d.client.multicall({
            allowFailure: false,
            blockNumber,
            contracts: ids.map((id) => ({ ...call, functionName: "getPromo", args: [id] }) as const),
          });

    let netEarned = 0n;
    const promos = chain.map((p, i) => {
      const raw = String(i);
      const event = d.store.data.events[p.geminiEventId];
      const instrument = d.store.data.instruments[p.instrumentSymbol];
      const label = d.store.data.promoLabels[raw];
      // What the vault made on a promo with a final result: the premium, less what its customers get.
      // A "no" keeps the whole premium, a voided promo gave it back, and one still running is not counted.
      let net: bigint | null = null;
      if (p.status === Status.FinalizedNo) net = p.premiumPaid;
      else if (p.status === Status.FinalizedYes || p.status === Status.PaidOut) net = p.premiumPaid - p.payoutPerClaim * BigInt(p.claimCount);
      else if (p.status === Status.Voided) net = 0n;
      if (net !== null) netEarned += net;
      return {
        promoId: raw,
        status: statusName(p.status),
        item: label?.item || null,
        business: label?.business || null,
        game: event?.game ?? event?.title ?? null,
        condition: instrument?.condition ?? null,
        premium: p.premiumPaid.toString(),
        /** The most the promo can pay: what was locked when it was made. */
        maxPayout: (p.payoutPerClaim * BigInt(p.maxClaims)).toString(),
        /** What it still locks now. */
        locked: p.collateralLocked.toString(),
        payoutPerClaim: p.payoutPerClaim.toString(),
        claimCount: p.claimCount,
        maxClaims: p.maxClaims,
        claimDeadline: Number(p.claimDeadline),
        marketCloseTime: Number(p.marketCloseTime),
        settledAt: Number(p.settledAt),
        outcomeYes: p.outcomeYes,
        /** True for a promo that pays the business itself: one payout, taken when it was made. */
        hedgeMode: p.hedgeMode,
        net: net === null ? null : net.toString(),
        /** The promo's hedge: an order on Gemini's sandbox exchange, or the order the keeper would place. */
        hedge: d.store.data.hedges[raw] ?? null,
        /** The chance of "yes" at the newest reading of Gemini's book, while the promo has no result. */
        chance: p.status === Status.Open ? (d.odds?.chance(raw)?.chance ?? null) : null,
      };
    });

    const free = balance - locked;
    return {
      vault: d.vault,
      usdc: d.usdc,
      block: Number(blockNumber),
      /** USDC the vault holds. */
      balance: balance.toString(),
      /** The part of it promised to promos, and to payouts that failed and wait. */
      locked: locked.toString(),
      /** The part of `locked` held by promos with no final result: it comes back if they end "no". */
      pending: pending.toString(),
      owed: owed.toString(),
      /** `balance - locked`: what a withdrawal is priced on. */
      free: free.toString(),
      /** `free + pending`: what a deposit is priced on. */
      depositBasis: (free + pending).toString(),
      totalShares: totalShares.toString(),
      /** The contract's cap: one promo's risk may be at most this part of `free`. */
      maxExposureBps,
      /** The pricing service's ceiling: no quote may leave more than this part of the vault locked. */
      maxLockedBps: d.maxLockedBps,
      paused,
      disputeWindow,
      /** Premiums kept on promos with a final result, less what those promos paid their customers. */
      netEarned: netEarned.toString(),
      promos,
      /** The newest events on the vault, oldest first. */
      events: d.feed.recent(VAULT_EVENTS),
    };
  }
  d.feed.subscribe(() => {
    vaultRead = null;
  });
  app.get("/vault", async (c) => {
    if (vaultRead === null || Date.now() - vaultRead.at >= VAULT_READ_MS) {
      const value = readVault();
      vaultRead = { at: Date.now(), value };
      value.catch(() => {
        if (vaultRead?.value === value) vaultRead = null;
      });
    }
    return c.json(await vaultRead.value);
  });

  // One promo's events as they happen, as server-sent events. A page that shows a promo keeps this open
  // and reads the promo again on every event.
  app.get("/promos/:id/events", (c) => {
    const id = c.req.param("id");
    if (!/^\d+$/.test(id)) throw new BadRequest("promo id must be a whole number");
    return eventStream(c, d.feed, streams, (event) => event.promoId === id);
  });

  // How a promo's chance has moved since it started: the keeper's readings of Gemini's book, oldest
  // first, each `[unix seconds, chance, bid, ask]` with the three prices in basis points of a dollar. The
  // page draws them as its chart. With `?after=` only the readings later than that time.
  app.get("/promos/:id/odds", (c) => {
    const id = c.req.param("id");
    if (!/^\d+$/.test(id)) throw new BadRequest("promo id must be a whole number");
    const after = c.req.query("after") ?? "0";
    if (!/^\d{1,12}$/.test(after)) throw new BadRequest("after must be a unix time");
    const history = d.odds?.history(id, Number(after)) ?? { everySeconds: 0, start: null, points: [], latest: null };
    return c.json({ promoId: id, ...history });
  });

  // A promo as the chain has it, with the plain names behind its two hashes, what the merchant said is
  // free, its events on the vault, and the transactions the keeper sent for it. With `?customer=0x...`
  // it adds that customer's place in line and whether they have been paid.
  app.get("/promos/:id", async (c) => {
    const raw = c.req.param("id");
    if (!/^\d+$/.test(raw)) throw new BadRequest("promo id must be a whole number");
    const id = BigInt(raw);
    const read = await readPromo(id);
    if (read === null) return c.json({ error: { code: "unknown-promo", message: "We could not find this promotion." } }, 404);
    const { promo: p, claimants } = read;
    const event = d.store.data.events[p.geminiEventId];
    const instrument = d.store.data.instruments[p.instrumentSymbol];

    // The first read of a promo ties it to the label that was sent with its quote.
    const { pendingLabels, promoLabels } = d.store.data;
    if (!promoLabels[raw]) {
      const nonce = findLabel(pendingLabels, p);
      if (nonce !== null) {
        const { item, business } = pendingLabels[nonce]!;
        promoLabels[raw] = { item, business };
        delete pendingLabels[nonce];
        d.store.save();
      }
    }
    const label = promoLabels[raw];
    const stream = d.feed.status();

    const who = c.req.query("customer");
    let customer = null;
    if (who !== undefined) {
      if (!isAddress(who)) throw new BadRequest("customer must be an address");
      // Nothing is owed to anyone unless a payout has failed somewhere, which the shared read says.
      const owed = read.anyOwed
        ? await d.client.readContract({ address: d.vault, abi: promoVaultAbi, functionName: "owedPayout", args: [id, who] })
        : 0n;
      const index = claimants.findIndex((a) => a.toLowerCase() === who.toLowerCase());
      customer = {
        address: who,
        /** The customer's place in line, from 1. Null when this address is not on the promo. */
        number: index < 0 ? null : index + 1,
        /** True once `payoutBatch` has sent this customer's money. */
        paid: index >= 0 && p.outcomeYes && index < p.paidCount && owed === 0n,
        /** A payout whose transfer failed and is waiting to be retried. */
        owed: owed.toString(),
      };
    }

    return c.json({
      promoId: raw,
      status: statusName(p.status),
      merchant: p.merchant,
      eventId: event?.eventId ?? null,
      eventTicker: event?.eventTicker ?? null,
      eventTitle: event?.title ?? null,
      instrumentSymbol: instrument?.symbol ?? null,
      contractLabel: instrument?.label ?? null,
      /** The words for the card (names.ts). Null on promos made before the keeper kept them. */
      game: event?.game ?? null,
      league: event?.league ?? null,
      eventStartTime: event?.startTime ?? null,
      team: instrument?.team ?? null,
      subject: instrument?.subject ?? null,
      condition: instrument?.condition ?? null,
      rule: instrument?.rule ?? null,
      /** What the merchant said is free, and the shop's name. Null when the quote carried none. */
      item: label?.item || null,
      business: label?.business || null,
      payoutPerClaim: p.payoutPerClaim.toString(),
      maxClaims: p.maxClaims,
      claimCount: p.claimCount,
      paidCount: p.paidCount,
      premiumPaid: p.premiumPaid.toString(),
      collateralLocked: p.collateralLocked.toString(),
      claimDeadline: Number(p.claimDeadline),
      marketCloseTime: Number(p.marketCloseTime),
      settledAt: Number(p.settledAt),
      outcomeYes: p.outcomeYes,
      hedgeMode: p.hedgeMode,
      /** The promo's hedge: an order on Gemini's sandbox exchange, or the order the keeper would place. Null until it is made. */
      hedge: d.store.data.hedges[raw] ?? null,
      /** What the keeper and the relayer sent for this promo, oldest first. */
      txs: d.store.data.txs.filter((t) => t.promoId === raw).map(({ at, action, hash }) => ({ at, action, hash })),
      /** The promo's events on the vault, oldest first, each with how it reached the keeper (`via`). */
      events: d.feed.forPromo(raw),
      /** The QuickNode Stream's record: deliveries that carried a vault event, and when the last one came. */
      stream: { deliveries: stream.deliveries, lastDeliveryAt: stream.lastDeliveryAt },
      customer,
    });
  });

  // Test-loop helper: the next windows of a 5 or 15-minute market, with the price Gemini shows for each.
  app.get("/intervals", async (c) => {
    const series = c.req.query("series") ?? "BTC05M";
    if (!/^[A-Z]+(05|15)M$/.test(series)) throw new BadRequest("series must look like BTC05M or ETH15M");
    const windows = upcomingIntervalTickers(series, new Date(), 4);
    // A window Gemini does not answer for is left out; the others are still listed.
    const events = await Promise.all(windows.map((w) => getEvent(w.ticker).catch(() => null)));
    return c.json({
      series,
      windows: windows.flatMap((w, i) => {
        const event = events[i];
        const contract = event?.contracts[0];
        if (!event || !contract) return [];
        return [{
          eventTicker: event.ticker,
          eventTitle: event.title,
          instrumentSymbol: contract.instrumentSymbol,
          closeTime: Math.floor(w.closeTime.getTime() / 1000),
          status: event.status,
          bestAsk: contract.prices?.bestAsk ?? null,
          quotable: event.status === "active" && priceToBps(contract.prices?.bestAsk) !== null,
        }];
      }),
    });
  });

  return app;
}

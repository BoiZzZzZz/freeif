// The keeper's HTTP API: prices and signed quotes for the merchant form, claims for the customer page.
// Amounts are USDC base units (6 decimals) as decimal strings. Times are unix seconds.
import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { createPublicClient, http, isAddress, type Address } from "viem";
import { promoVaultAbi } from "./abi.ts";
import { CHAIN_ID, rpcUrls } from "./config.ts";
import { arcTestnet, statusName, type PublicClient } from "./chain.ts";
import { LEAGUES, type Games } from "./games.ts";
import { getEvent, priceToBps, upcomingIntervalTickers } from "./gemini.ts";
import { cleanText, findLabel } from "./labels.ts";
import { Pricer, Refusal, type PriceRequest } from "./pricer.ts";
import { ClaimRefusal, Relayer } from "./relayer.ts";
import type { Store } from "./store.ts";

type Deps = {
  client: PublicClient;
  vault: Address;
  pricer: Pricer;
  games: Games;
  relayer: Relayer;
  oracle: Address;
  store: Store;
  /** The test loop's key for claims with no login. Undefined turns that way in off. */
  testKey?: string;
};

class BadRequest extends Error {}

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

  app.onError((err, c) => {
    if (err instanceof Refusal) {
      return c.json({ error: { code: err.code, message: err.message, maxCustomers: err.maxCustomers } }, 422);
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
    });
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
    return c.json(
      await d.pricer.signQuote({ ...parsePriceRequest(body), merchant, hedgeMode: body.hedgeMode === true, label }),
    );
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

  // A promo as the chain has it, with the plain names behind its two hashes, what the merchant said is
  // free, and the transactions the keeper sent for it. With `?customer=0x...` it adds that customer's
  // place in line and whether they have been paid.
  app.get("/promos/:id", async (c) => {
    const raw = c.req.param("id");
    if (!/^\d+$/.test(raw)) throw new BadRequest("promo id must be a whole number");
    const id = BigInt(raw);
    const count = await d.client.readContract({ address: d.vault, abi: promoVaultAbi, functionName: "promoCount" });
    if (id >= count) return c.json({ error: { code: "unknown-promo", message: "We could not find this promotion." } }, 404);
    const p = await d.client.readContract({ address: d.vault, abi: promoVaultAbi, functionName: "getPromo", args: [id] });
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

    const who = c.req.query("customer");
    let customer = null;
    if (who !== undefined) {
      if (!isAddress(who)) throw new BadRequest("customer must be an address");
      const [claimants, owed] = await Promise.all([
        d.client.readContract({ address: d.vault, abi: promoVaultAbi, functionName: "getClaimants", args: [id] }),
        d.client.readContract({ address: d.vault, abi: promoVaultAbi, functionName: "owedPayout", args: [id, who] }),
      ]);
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
      /** What the keeper and the relayer sent for this promo, oldest first. */
      txs: d.store.data.txs.filter((t) => t.promoId === raw).map(({ at, action, hash }) => ({ at, action, hash })),
      customer,
    });
  });

  // Test-loop helper: the next windows of a 5 or 15-minute market, with the price Gemini shows for each.
  app.get("/intervals", async (c) => {
    const series = c.req.query("series") ?? "BTC05M";
    if (!/^[A-Z]+(05|15)M$/.test(series)) throw new BadRequest("series must look like BTC05M or ETH15M");
    const windows = upcomingIntervalTickers(series, new Date(), 4);
    const events = await Promise.all(windows.map((w) => getEvent(w.ticker)));
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

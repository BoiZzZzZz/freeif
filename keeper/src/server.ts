// The keeper's HTTP API: prices and signed quotes for the merchant form, claims for the customer page.
// Amounts are USDC base units (6 decimals) as decimal strings. Times are unix seconds.
import { Hono } from "hono";
import { cors } from "hono/cors";
import { isAddress, type Address } from "viem";
import { promoVaultAbi } from "./abi.ts";
import { CHAIN_ID } from "./config.ts";
import { statusName, type PublicClient } from "./chain.ts";
import { getEvent, priceToBps, upcomingIntervalTickers } from "./gemini.ts";
import { Pricer, Refusal, type PriceRequest } from "./pricer.ts";
import { ClaimRefusal, Relayer } from "./relayer.ts";
import type { Store } from "./store.ts";

type Deps = {
  client: PublicClient;
  vault: Address;
  pricer: Pricer;
  relayer: Relayer;
  oracle: Address;
  store: Store;
};

class BadRequest extends Error {}

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
      const status = err.code === "email-used" ? 409 : err.code === "failed" ? 502 : 422;
      return c.json({ error: { code: err.code, message: err.message } }, status);
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
    });
  });

  // The price of a promo, unsigned. No merchant needed: the form shows it before login.
  app.get("/price", async (c) => c.json(await d.pricer.getPrice(parsePriceRequest(c.req.query()))));

  // A signed quote for `createPromo(quote, signature)`. Usable for 90 seconds, by `merchant` only.
  app.post("/quote", async (c) => {
    const body = (await c.req.json()) as Record<string, unknown>;
    const merchant = body.merchant;
    if (typeof merchant !== "string" || !isAddress(merchant)) throw new BadRequest("merchant must be an address");
    return c.json(await d.pricer.signQuote({ ...parsePriceRequest(body), merchant, hedgeMode: body.hedgeMode === true }));
  });

  // Registers a customer on a promo. One claim per email per promo.
  app.post("/claims", async (c) => {
    const body = (await c.req.json()) as Record<string, unknown>;
    if (!/^\d+$/.test(String(body.promoId))) throw new BadRequest("promoId must be a whole number");
    if (typeof body.customer !== "string" || typeof body.email !== "string") {
      throw new BadRequest("customer and email are required");
    }
    return c.json(await d.relayer.registerClaim(BigInt(String(body.promoId)), body.customer, body.email));
  });

  // A promo as the chain has it, with the plain names behind its two hashes.
  app.get("/promos/:id", async (c) => {
    const raw = c.req.param("id");
    if (!/^\d+$/.test(raw)) throw new BadRequest("promo id must be a whole number");
    const id = BigInt(raw);
    const count = await d.client.readContract({ address: d.vault, abi: promoVaultAbi, functionName: "promoCount" });
    if (id >= count) return c.json({ error: { code: "unknown-promo", message: "We could not find this promotion." } }, 404);
    const p = await d.client.readContract({ address: d.vault, abi: promoVaultAbi, functionName: "getPromo", args: [id] });
    const event = d.store.data.events[p.geminiEventId];
    const instrument = d.store.data.instruments[p.instrumentSymbol];
    return c.json({
      promoId: raw,
      status: statusName(p.status),
      merchant: p.merchant,
      eventId: event?.eventId ?? null,
      eventTicker: event?.eventTicker ?? null,
      eventTitle: event?.title ?? null,
      instrumentSymbol: instrument?.symbol ?? null,
      contractLabel: instrument?.label ?? null,
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

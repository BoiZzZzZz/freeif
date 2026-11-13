// Settings for the keeper. Values come from the environment; on a developer machine they are
// filled from a secrets file that lives outside the repo (never from a file inside it).
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Address, Hex } from "viem";
import type { PricingParams } from "./pricing.ts";

const secretsPath = process.env.FREEIF_SECRETS ?? join(homedir(), ".freeif", "secrets.env");
// Variables already set in the environment win over the file, so a host's settings are never overridden.
if (existsSync(secretsPath)) process.loadEnvFile(secretsPath);

export function env(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`Missing environment variable ${name}`);
  return value;
}

function optional(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === "" ? undefined : value;
}

function int(name: string, fallback: number): number {
  const raw = optional(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a whole number, got "${raw}"`);
  return value;
}

export const CHAIN_ID = 5042002;
export const PUBLIC_RPC_URL = "https://rpc.testnet.arc.io";
export const USDC_DEFAULT: Address = "0x3600000000000000000000000000000000000000";

/** Every RPC endpoint to try, in order. The public one first, QuickNode's as the fallback. */
export function rpcUrls(): string[] {
  const urls = [optional("ARC_RPC_URL") ?? PUBLIC_RPC_URL, optional("QUICKNODE_ARC_RPC_URL")];
  return [...new Set(urls.filter((u): u is string => u !== undefined))];
}

export const vaultAddress = (): Address => env("VAULT_ADDRESS") as Address;
export const usdcAddress = (): Address => (optional("USDC_ADDRESS") as Address | undefined) ?? USDC_DEFAULT;
export const geminiBase = (): string => optional("GEMINI_BASE") ?? "https://api.gemini.com";

export const pricerKey = (): Hex => env("PRICER_PK") as Hex;
export const oracleKey = (): Hex => env("ORACLE_PK") as Hex;
export const relayerKey = (): Hex => env("RELAYER_PK") as Hex;

/** Circle's API key: the relayer asks Circle whose login a claim carries. */
export const circleApiKey = (): string => env("CIRCLE_API_KEY");
/** Lets the test loop register customers that have no login. Leave it unset to turn that off. */
export const claimTestKey = (): string | undefined => optional("CLAIM_TEST_KEY");

/**
 * Claim cards: a promo with this id or a higher one, unless it is a cover (hedge mode), is covered by
 * cards the merchant prints, and the open claim (`POST /claims`) refuses it. Unset, no promo uses cards.
 * The switch exists so that promos already open on a vault keep the way they were sold.
 */
export function cardsFromPromo(): bigint | undefined {
  const raw = optional("CARDS_FROM_PROMO");
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) throw new Error(`CARDS_FROM_PROMO must be a promo id (a whole number), got "${raw}"`);
  return BigInt(raw);
}

/**
 * The secret the QuickNode Stream sends with every delivery, in the header `x-stream-secret`. Unset,
 * `POST /stream` refuses everything and the feed is filled from the chain alone.
 */
export const streamSecret = (): string | undefined => optional("QUICKNODE_STREAM_SECRET");

/** How the keeper reads the chain's logs for events the Stream has not delivered. */
export const feedSettings = () => ({
  /** Pause between two reads. */
  intervalMs: int("FEED_RPC_MS", 2_000),
  /** How long a log waits for the Stream before the keeper takes it from the chain itself. */
  graceMs: int("FEED_GRACE_MS", 4_000),
  /** Where the first read starts. Unset, the keeper finds the vault's first block by itself. */
  startBlock: optional("FEED_START_BLOCK") === undefined ? undefined : int("FEED_START_BLOCK", 0),
});

/**
 * Gemini's sandbox exchange, where the keeper places each promo's hedge order. Null without a key: every
 * hedge is then written down as simulated.
 */
export function geminiSandbox(): { key: string; secret: string; base: string } | null {
  const key = optional("GEMINI_SANDBOX_KEY");
  const secret = optional("GEMINI_SANDBOX_SECRET");
  if (key === undefined || secret === undefined) return null;
  return { key, secret, base: optional("GEMINI_SANDBOX_BASE") ?? "https://api.sandbox.gemini.com" };
}

/** Pricing settings (SPEC section 2). All of them can be changed without a deploy. */
export function pricingParams(): PricingParams {
  return {
    spreadBps: int("SPREAD_BPS", 500),
    // A book with a side missing, or with its sides more than half a dollar apart, is priced with this.
    thinSpreadBps: int("THIN_SPREAD_BPS", 1500),
    minMarkupBps: int("MIN_MARKUP_BPS", 200),
    loadingStepBps: int("LOADING_STEP_BPS", 500),
    // Off until the loading formula is decided: the premium is the flat spread. 100 turns on SPEC's
    // example, 1% of the expected loss per 5% of the vault locked.
    loadingBpsPerStep: int("LOADING_BPS_PER_STEP", 0),
    maxLockedBps: int("MAX_LOCKED_BPS", 6000),
    exposureHeadroomBps: int("EXPOSURE_HEADROOM_BPS", 9000),
  };
}

export const timing = () => ({
  /** How long a signed quote can be used. */
  quoteTtlSeconds: int("QUOTE_TTL_SECONDS", 90),
  /** Interval markets (5 and 15-minute crypto) stop taking claims this long before they close. */
  intervalCutoffSeconds: int("INTERVAL_CUTOFF_SECONDS", 60),
  /** A quote is refused when its claim deadline is closer than this. */
  minClaimWindowSeconds: int("MIN_CLAIM_WINDOW_SECONDS", 30),
  /** Pause between two passes of the settlement loop. */
  loopMs: int("KEEPER_LOOP_MS", 30_000),
  /** Pause between two rounds of retrying payouts whose transfer failed. */
  retryMs: int("KEEPER_RETRY_MS", 600_000),
});

export const port = (): number => int("PORT", 8787);
export const dataDir = (): string => optional("KEEPER_DATA_DIR") ?? join(import.meta.dirname, "..", "data");

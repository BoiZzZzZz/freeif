// The test loop: one promo on a 5-minute BTC market, from quote to payout, against a running keeper.
// This script plays the merchant and the customers. The keeper prices, relays the claims, settles,
// finalizes and pays. Needs TEST_MERCHANT_PK and TEST_CUSTOMER_ADDRESSES, and a funded vault.
//
//   node scripts/e2e.ts [--series BTC05M] [--payout 1] [--customers 3] [--pick next|likely] [--approve]
//
// --pick likely takes the running window when Gemini prices it at 60% or more, which makes a payout more likely.
// --approve uses approve + createPromo; the default is one transaction, createPromoWithPermit.
import { parseArgs } from "node:util";
import { erc20Abi, formatUnits, hashTypedData, parseEventLogs, parseSignature, parseUnits, type Address, type Hex } from "viem";
import { promoVaultAbi } from "../src/abi.ts";
import { Status, explorerTx, makePublicClient, makeWalletClient, quoteDomain, quoteFromJson, quoteTypes, statusName, type QuoteJson } from "../src/chain.ts";
import * as config from "../src/config.ts";

const { values: args } = parseArgs({
  options: {
    series: { type: "string", default: "BTC05M" },
    payout: { type: "string", default: "1" },
    customers: { type: "string", default: "3" },
    pick: { type: "string", default: "next" },
    approve: { type: "boolean", default: false },
  },
});

const keeperUrl = (process.env.KEEPER_URL ?? `http://127.0.0.1:${config.port()}`).replace(/\/$/, "");
const vault = config.vaultAddress();
const usdc = config.usdcAddress();
const client = makePublicClient();
const merchant = makeWalletClient(config.env("TEST_MERCHANT_PK") as Hex);
const customers = config.env("TEST_CUSTOMER_ADDRESSES").split(",").slice(0, Number(args.customers)) as Address[];
const payoutPerClaim = parseUnits(args.payout, 6);

const usd = (amount: bigint | string) => `$${formatUnits(BigInt(amount), 6)}`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const now = () => Math.floor(Date.now() / 1000);
const step = (text: string) => console.log(`\n== ${text}`);

async function api<T>(path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${keeperUrl}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as T };
}
async function ok<T>(path: string, body?: unknown): Promise<T> {
  const res = await api<T>(path, body);
  if (res.status !== 200) throw new Error(`${path} answered ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body;
}

type Window = { eventTicker: string; eventTitle: string; instrumentSymbol: string; closeTime: number; bestAsk: string | null; quotable: boolean };
type PriceBody = {
  eventId: string;
  eventTitle: string;
  claimDeadline: number;
  breakdown: { chance: number; mostOwed: string; fee: string; cost: string };
  maxCustomers: number;
  limit: string;
};
type QuoteBody = PriceBody & { quote: QuoteJson; signature: Hex };
type ClaimBody = { alreadyRegistered: boolean; claimCount: number | null; txHash: Hex | null };

step(`Keeper at ${keeperUrl}`);
const health = await ok<{ vault: Address; pricer: Address; relayer: Address; oracle: Address }>("/health");
console.log(health);
if (health.vault.toLowerCase() !== vault.toLowerCase()) throw new Error(`The keeper serves vault ${health.vault}, this script expects ${vault}`);

step("Pick a window");
const { windows } = await ok<{ windows: Window[] }>(`/intervals?series=${args.series}`);
// Leave a minute to create the promo and register the customers before claims close (60s before the close).
// A window about to start can show an empty book (ask 0.99), which the keeper refuses as too likely.
const usable = windows.filter((w) => w.quotable && w.closeTime - now() >= 120 && Number(w.bestAsk) <= 0.9);
if (usable.length === 0) throw new Error("No window is quotable right now");
// "likely": the soonest window priced between 60% and 90%, which is only ever the one that is running.
const chosen =
  (args.pick === "likely" ? usable.find((w) => Number(w.bestAsk) >= 0.6 && Number(w.bestAsk) <= 0.9) : undefined) ?? usable[0]!;
console.log(`${chosen.eventTicker} "${chosen.eventTitle}", ask ${chosen.bestAsk}, closes in ${chosen.closeTime - now()}s`);

step("Price, then a signed quote");
const request = {
  eventTicker: chosen.eventTicker,
  instrumentSymbol: chosen.instrumentSymbol,
  payoutPerClaim: payoutPerClaim.toString(),
  maxClaims: String(customers.length),
};
const priced = await ok<PriceBody>(`/price?${new URLSearchParams(request)}`);
console.log(
  `chance ${(priced.breakdown.chance * 100).toFixed(0)}%, most owed ${usd(priced.breakdown.mostOwed)}, fee ${usd(priced.breakdown.fee)}, ` +
    `cost ${usd(priced.breakdown.cost)}; the vault can cover ${priced.maxCustomers} customers (${priced.limit})`,
);
const quoted = await ok<QuoteBody>("/quote", { ...request, merchant: merchant.account.address });
const quote = quoteFromJson(quoted.quote);

// What the merchant's wallet would check before paying: the vault agrees with the hash and the signer.
const ours = hashTypedData({ domain: quoteDomain(vault), types: quoteTypes, primaryType: "Quote", message: quote });
const theirs = await client.readContract({ address: vault, abi: promoVaultAbi, functionName: "quoteDigest", args: [quote] });
if (ours !== theirs) throw new Error(`Digest mismatch: keeper ${ours}, vault ${theirs}`);
console.log(`quote signed by ${health.pricer}, premium ${usd(quote.premium)}, digest matches the vault's`);

step(`Merchant ${merchant.account.address} creates the promo`);
const balance = await client.readContract({ address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [merchant.account.address] });
if (balance < quote.premium + 500_000n) throw new Error(`The merchant holds ${usd(balance)}; it needs the premium plus gas`);

let createHash: Hex;
if (args.approve) {
  const approveHash = await merchant.writeContract({ address: usdc, abi: erc20Abi, functionName: "approve", args: [vault, quote.premium] });
  await client.waitForTransactionReceipt({ hash: approveHash });
  console.log(`approve ${explorerTx(approveHash)}`);
  createHash = await merchant.writeContract({ address: vault, abi: promoVaultAbi, functionName: "createPromo", args: [quote, quoted.signature] });
} else {
  // One transaction: a USDC permit for exactly the premium, checked inside createPromoWithPermit.
  const permitDeadline = BigInt(now() + 600);
  const nonce = await client.readContract({
    address: usdc,
    abi: [{ type: "function", name: "nonces", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ type: "uint256" }] }],
    functionName: "nonces",
    args: [merchant.account.address],
  });
  const permit = await merchant.signTypedData({
    domain: { name: "USDC", version: "2", chainId: config.CHAIN_ID, verifyingContract: usdc },
    types: {
      Permit: [
        { name: "owner", type: "address" },
        { name: "spender", type: "address" },
        { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "Permit",
    message: { owner: merchant.account.address, spender: vault, value: quote.premium, nonce, deadline: permitDeadline },
  });
  const { r, s, v, yParity } = parseSignature(permit);
  createHash = await merchant.writeContract({
    address: vault,
    abi: promoVaultAbi,
    functionName: "createPromoWithPermit",
    args: [quote, quoted.signature, permitDeadline, Number(v ?? BigInt(yParity + 27)), r, s],
  });
}
const created = await client.waitForTransactionReceipt({ hash: createHash });
if (created.status !== "success") throw new Error(`The create reverted: ${explorerTx(createHash)}`);
const [createdLog] = parseEventLogs({ abi: promoVaultAbi, eventName: "PromoCreated", logs: created.logs });
if (!createdLog) throw new Error("No PromoCreated event in the receipt");
const promoId = createdLog.args.promoId;
console.log(`promo ${promoId} created ${explorerTx(createHash)}`);

step("Customers claim through the relayer");
const before = await Promise.all(customers.map((c) => client.readContract({ address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [c] })));
const email = (i: number) => `customer${i + 1}.promo${promoId}@example.com`;
for (const [i, customer] of customers.entries()) {
  const claim = await ok<ClaimBody>("/claims", { promoId: promoId.toString(), customer, email: email(i) });
  console.log(`${customer} is customer ${claim.claimCount} ${claim.txHash ? explorerTx(claim.txHash) : ""}`);
}
const again = await ok<ClaimBody>("/claims", { promoId: promoId.toString(), customer: customers[0], email: email(0) });
if (!again.alreadyRegistered) throw new Error("A repeated claim was registered twice");
if (customers.length > 1) {
  const reused = await api<{ error: { code: string } }>("/claims", { promoId: promoId.toString(), customer: customers[1], email: email(0) });
  if (reused.status !== 409) throw new Error(`An email was used for a second wallet: ${JSON.stringify(reused)}`);
}
console.log("a repeated claim sends nothing, and one email cannot claim for two wallets");

step("Wait for the keeper: settle, finalize, pay");
const disputeWindow = await client.readContract({ address: vault, abi: promoVaultAbi, functionName: "disputeWindow" });
const giveUpAt = chosen.closeTime + disputeWindow + 240;
let last = -1;
let promo = await client.readContract({ address: vault, abi: promoVaultAbi, functionName: "getPromo", args: [promoId] });
while (promo.status !== Status.PaidOut && promo.status !== Status.FinalizedNo) {
  if (promo.status !== last) {
    last = promo.status;
    const wait = promo.status === Status.Open ? `; the market closes in ${Math.max(0, chosen.closeTime - now())}s` : "";
    console.log(`${new Date().toISOString().slice(11, 19)} ${statusName(promo.status)}${wait}`);
  }
  if (now() > giveUpAt) throw new Error(`Promo ${promoId} is still ${statusName(promo.status)}; is the keeper running?`);
  await sleep(3000);
  promo = await client.readContract({ address: vault, abi: promoVaultAbi, functionName: "getPromo", args: [promoId] });
}
console.log(`${new Date().toISOString().slice(11, 19)} ${statusName(promo.status)}`);

step("What happened on chain");
const logs = parseEventLogs({
  abi: promoVaultAbi,
  logs: await client.getLogs({ address: vault, fromBlock: created.blockNumber, toBlock: "latest" }),
}).filter((l) => "promoId" in l.args && l.args.promoId === promoId);
for (const l of logs) {
  const detail =
    l.eventName === "Settled" ? ` ${l.args.resolutionSide} (Gemini event ${l.args.geminiEventId})`
    : l.eventName === "Paid" || l.eventName === "PayoutFailed" ? ` ${usd(l.args.amount)} to ${l.args.customer}`
    : l.eventName === "Finalized" ? ` released ${usd(l.args.collateralReleased)}`
    : "";
  console.log(`${l.eventName}${detail} ${explorerTx(l.transactionHash)}`);
}
const after = await Promise.all(customers.map((c) => client.readContract({ address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [c] })));
const received = after.map((a, i) => a - before[i]!);

// Judged from this promo's own Paid events. The balances are a second check, and only a lower bound:
// another promo may pay the same test customers while this one runs.
const paidLogs = logs.filter((l) => l.eventName === "Paid");
const paid = paidLogs.length;
if (promo.outcomeYes) {
  const eachPaidOnce = customers.every(
    (c) => paidLogs.filter((l) => l.args.customer.toLowerCase() === c.toLowerCase() && l.args.amount === payoutPerClaim).length === 1,
  );
  if (paid !== customers.length || !eachPaidOnce || received.some((r) => r < payoutPerClaim)) {
    throw new Error(`Result "yes" but ${paid} of ${customers.length} were paid; received ${received.map(usd).join(", ")}`);
  }
  console.log(`\nRESULT: yes. ${paid} customers were paid ${usd(payoutPerClaim)} each.`);
} else {
  if (paid !== 0) throw new Error(`Result "no" but a customer was paid`);
  console.log(`\nRESULT: no. Nobody was paid; the ${usd(promo.premiumPaid)} premium stays with the vault. Run again for a "yes".`);
}

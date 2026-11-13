// One process: the pricing API, the claim relayer and the settlement loop.
import { serve } from "@hono/node-server";
import { privateKeyToAccount } from "viem/accounts";
import { promoVaultAbi } from "./abi.ts";
import { makePublicClient, makeWalletClient } from "./chain.ts";
import { makeIdentify } from "./circle.ts";
import * as config from "./config.ts";
import { Games } from "./games.ts";
import { Keeper } from "./keeper.ts";
import { Pricer } from "./pricer.ts";
import { Relayer } from "./relayer.ts";
import { makeApp } from "./server.ts";
import { Store } from "./store.ts";

const vault = config.vaultAddress();
const usdc = config.usdcAddress();
const timing = config.timing();
const client = makePublicClient();
const store = new Store(config.dataDir());

const pricerAccount = privateKeyToAccount(config.pricerKey());
const oracleWallet = makeWalletClient(config.oracleKey());
const relayerWallet = makeWalletClient(config.relayerKey());

// Refuse to start with keys the vault does not know: every quote and every settle would revert.
const [chainId, vaultPricer, vaultOracle, vaultUsdc] = await Promise.all([
  client.getChainId(),
  client.readContract({ address: vault, abi: promoVaultAbi, functionName: "pricer" }),
  client.readContract({ address: vault, abi: promoVaultAbi, functionName: "oracle" }),
  client.readContract({ address: vault, abi: promoVaultAbi, functionName: "usdc" }),
]);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
if (chainId !== config.CHAIN_ID) throw new Error(`RPC is chain ${chainId}, expected ${config.CHAIN_ID}`);
if (!same(vaultPricer, pricerAccount.address)) throw new Error(`PRICER_PK is ${pricerAccount.address}, the vault's pricer is ${vaultPricer}`);
if (!same(vaultOracle, oracleWallet.account.address)) throw new Error(`ORACLE_PK is ${oracleWallet.account.address}, the vault's oracle is ${vaultOracle}`);
if (!same(vaultUsdc, usdc)) throw new Error(`USDC_ADDRESS is ${usdc}, the vault's token is ${vaultUsdc}`);

const relayer = new Relayer({ client, wallet: relayerWallet, vault, store, identify: makeIdentify(config.circleApiKey()) });
const pricer = new Pricer({
  client,
  vault,
  usdc,
  account: pricerAccount,
  claimSigner: relayer.address,
  params: config.pricingParams(),
  timing,
  store,
});
const keeper = new Keeper({ client, wallet: oracleWallet, vault, store });
const games = new Games({ spreadBps: config.pricingParams().spreadBps, minLeadSeconds: timing.minClaimWindowSeconds });

const app = makeApp({ client, vault, pricer, games, relayer, oracle: keeper.address, store, testKey: config.claimTestKey() });
const server = serve({ fetch: app.fetch, port: config.port(), hostname: "0.0.0.0" }, (info) => {
  console.log(`[server] listening on ${info.port}; vault ${vault}; RPCs: ${config.rpcUrls().length}`);
});

// Read Gemini's game lists now, so the first merchant to open the form does not wait for them.
void games.prewarm();

const stop = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stop.abort();
    server.close();
  });
}
await keeper.run(timing.loopMs, timing.retryMs, stop.signal);

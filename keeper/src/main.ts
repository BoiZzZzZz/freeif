// One process: the pricing API, the claim relayer and the settlement loop.
import { serve } from "@hono/node-server";
import { privateKeyToAccount } from "viem/accounts";
import { promoVaultAbi } from "./abi.ts";
import { makePublicClient, makeWalletClient } from "./chain.ts";
import * as config from "./config.ts";
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

const relayer = new Relayer({ client, wallet: relayerWallet, vault, store });
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

const app = makeApp({ client, vault, pricer, relayer, oracle: keeper.address, store });
const server = serve({ fetch: app.fetch, port: config.port(), hostname: "0.0.0.0" }, (info) => {
  console.log(`[server] listening on ${info.port}; vault ${vault}; RPCs: ${config.rpcUrls().length}`);
});

const stop = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stop.abort();
    server.close();
  });
}
await keeper.run(timing.loopMs, timing.retryMs, stop.signal);

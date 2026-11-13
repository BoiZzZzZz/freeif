// The keeper's EIP-712 hashing against the deployed vault. Reads the chain; sends nothing.
// Skipped when VAULT_ADDRESS is not set.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { hashTypedData, keccak256, recoverTypedDataAddress, toBytes, toHex, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { promoVaultAbi } from "../src/abi.ts";
import { makePublicClient, quoteDomain, quoteTypes, type Quote } from "../src/chain.ts";
import "../src/config.ts";

const vault = process.env.VAULT_ADDRESS as Address | undefined;
const skip = vault ? false : "VAULT_ADDRESS is not set";

const quote = (over: Partial<Quote> = {}): Quote => ({
  merchant: "0xF9Aac480396174FFF98988D25d74c78Af7Abfb88",
  claimSigner: "0xa03aF58DF0B042fFA9342F178bb37F8a9f1E3286",
  geminiEventId: keccak256(toBytes("455065")),
  instrumentSymbol: keccak256(toBytes("GEMI-BTC05M2611130355-UP")),
  payoutPerClaim: 20_000_000n,
  maxClaims: 200,
  premium: 1_638_000_000n,
  claimDeadline: 1794542040n,
  marketCloseTime: 1794542100n,
  hedgeMode: false,
  expiry: 1794541990n,
  nonce: toHex(randomBytes(32)),
  ...over,
});

test("quoteDigest_keeperHash_equalsTheVaults", { skip }, async () => {
  const client = makePublicClient();
  const quotes = [
    quote(),
    quote({ hedgeMode: true, maxClaims: 1 }),
    quote({ payoutPerClaim: 2n ** 255n, maxClaims: 0xffffffff, premium: 1n, claimDeadline: 2n ** 64n - 1n }),
  ];
  for (const q of quotes) {
    const ours = hashTypedData({ domain: quoteDomain(vault!), types: quoteTypes, primaryType: "Quote", message: q });
    const theirs = await client.readContract({ address: vault!, abi: promoVaultAbi, functionName: "quoteDigest", args: [q] });
    assert.equal(ours, theirs);
  }
});

test("eip712Domain_onChain_isTheDomainTheKeeperSignsWith", { skip }, async () => {
  const client = makePublicClient();
  const [, name, version, chainId, verifyingContract] = await client.readContract({
    address: vault!,
    abi: promoVaultAbi,
    functionName: "eip712Domain",
  });
  const ours = quoteDomain(vault!);
  assert.deepEqual(
    { name, version, chainId: Number(chainId), verifyingContract: verifyingContract.toLowerCase() },
    { name: ours.name, version: ours.version, chainId: ours.chainId, verifyingContract: vault!.toLowerCase() },
  );
});

test("signTypedData_withThePricerKey_recoversToTheVaultsPricer", { skip: skip || (process.env.PRICER_PK ? false : "PRICER_PK is not set") }, async () => {
  const client = makePublicClient();
  const account = privateKeyToAccount(process.env.PRICER_PK as `0x${string}`);
  const q = quote();
  const signature = await account.signTypedData({ domain: quoteDomain(vault!), types: quoteTypes, primaryType: "Quote", message: q });
  assert.equal(signature.length, 2 + 65 * 2);
  const signer = await recoverTypedDataAddress({ domain: quoteDomain(vault!), types: quoteTypes, primaryType: "Quote", message: q, signature });
  const pricer = await client.readContract({ address: vault!, abi: promoVaultAbi, functionName: "pricer" });
  assert.equal(signer.toLowerCase(), pricer.toLowerCase());
});

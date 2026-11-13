// Moves test USDC between the project's own wallets, so the ones that spend it do not run dry.
//
// Circle's faucet API refuses this project's key (403: it needs an account upgraded to mainnet), and the
// public faucet is a web page behind a captcha. But the pricer wallet only signs quotes and never sends
// a transaction, so the test USDC it holds is spare, and the oracle and relayer spend a fraction of a
// cent per transaction. This script sends from one of those to a wallet that is low.
//
//   pnpm topup                          what it would do: bring the test merchant up to 5 USDC (nothing sent)
//   pnpm topup --send                   do it
//   pnpm topup --to deployer --amount 50 --send
//   pnpm topup --to 0xabc... --amount 3 --send
//   pnpm topup --target 10 --send       bring the test merchant up to 10 instead
//   pnpm topup --from oracle ...        send from the oracle (default: the pricer)
//   pnpm topup --list                   every wallet's balance, nothing else
import { erc20Abi, formatUnits, getAddress, isAddress, parseUnits, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { explorerTx, makePublicClient, makeWalletClient } from "../src/chain.ts";
import * as config from "../src/config.ts";

/** What a sending wallet always keeps, for its own network fees. */
const SOURCE_FLOOR = parseUnits("5", 6);

type Wallet = { label: string; address: Address; key?: Hex };

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

function wallets(): Wallet[] {
  const list: Wallet[] = [];
  for (const [label, name] of [["deployer", "DEPLOYER_PK"], ["pricer", "PRICER_PK"], ["oracle", "ORACLE_PK"], ["relayer", "RELAYER_PK"]] as const) {
    const key = process.env[name];
    if (key) list.push({ label, address: privateKeyToAccount(key as Hex).address, key: key as Hex });
  }
  const merchant = process.env.TEST_MERCHANT_ADDRESS;
  if (merchant) list.push({ label: "merchant", address: getAddress(merchant) });
  (process.env.TEST_CUSTOMER_ADDRESSES ?? "")
    .split(",")
    .map((a) => a.trim())
    .filter((a) => a !== "")
    .forEach((a, i) => list.push({ label: `customer${i + 1}`, address: getAddress(a) }));
  return list;
}

const usdc = config.usdcAddress();
const client = makePublicClient();
const all = wallets();
const usd = (units: bigint): string => `$${Number(formatUnits(units, 6)).toFixed(2)}`;
const balanceOf = (address: Address): Promise<bigint> =>
  client.readContract({ address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [address] });

if (flag("list")) {
  for (const w of all) console.log(`${w.label.padEnd(10)} ${w.address}  ${usd(await balanceOf(w.address))}`);
  process.exit(0);
}

const fromLabel = argValue("from") ?? "pricer";
const source = all.find((w) => w.label === fromLabel);
if (!source?.key) throw new Error(`--from must be one of the wallets whose key is set: ${all.filter((w) => w.key).map((w) => w.label).join(", ")}`);

const toArg = argValue("to") ?? "merchant";
const target = isAddress(toArg) ? { label: toArg, address: getAddress(toArg) } : all.find((w) => w.label === toArg);
if (!target) throw new Error(`--to must be an address or one of: ${all.map((w) => w.label).join(", ")}`);
if (target.address === source.address) throw new Error("--to is the sending wallet itself");

const [fromBalance, toBalance] = await Promise.all([balanceOf(source.address), balanceOf(target.address)]);
let amount: bigint;
const amountArg = argValue("amount");
if (amountArg !== undefined) {
  amount = parseUnits(amountArg, 6);
} else {
  // No amount: bring the wallet up to the target, or leave it if it already has that much.
  const goal = parseUnits(argValue("target") ?? "5", 6);
  amount = goal > toBalance ? goal - toBalance : 0n;
}

console.log(`${source.label} ${source.address}  ${usd(fromBalance)}`);
console.log(`${target.label} ${target.address}  ${usd(toBalance)}`);
if (amount <= 0n) {
  console.log("Nothing to send: it already has that much.");
  process.exit(0);
}
if (fromBalance - amount < SOURCE_FLOOR) {
  throw new Error(`${source.label} would keep ${usd(fromBalance - amount)}; it keeps at least ${usd(SOURCE_FLOOR)} for its own fees`);
}
console.log(`Send ${usd(amount)} from ${source.label} to ${target.label}.`);
if (!flag("send")) {
  console.log("Nothing sent. Add --send to send it.");
  process.exit(0);
}

const wallet = makeWalletClient(source.key);
const { request } = await client.simulateContract({
  account: wallet.account,
  address: usdc,
  abi: erc20Abi,
  functionName: "transfer",
  args: [target.address, amount],
});
const hash = await wallet.writeContract(request);
const receipt = await client.waitForTransactionReceipt({ hash });
if (receipt.status !== "success") throw new Error(`The transfer reverted: ${explorerTx(hash)}`);
console.log(`Sent: ${explorerTx(hash)}`);
console.log(`${target.label} now holds ${usd(await balanceOf(target.address))}`);

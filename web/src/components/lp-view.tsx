"use client";

// /lp (prep/WIREFRAMES.md section 10): the vault as a liquidity provider reads it. This is the one page
// that speaks DeFi (USDC, vault, premiums, locked) and the one page with a browser wallet. The numbers
// come from the keeper's `GET /vault` and refresh when an event on the vault reaches the keeper.
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { SiteFooter } from "@/components/mechanics";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { explorerAddress, explorerTx, FEE_BUFFER } from "@/lib/config";
import { follow } from "@/lib/events";
import { dayTime, parseDollars, shortAddress, usd } from "@/lib/format";
import { connect, connected, deposit, injected, onAccount, position, withdraw, type Position } from "@/lib/injected";
import { keeper, type FeedEvent, type Vault, type VaultPromo } from "@/lib/keeper";
import { useNow } from "@/lib/use-now";

type Address = `0x${string}`;

/** The vault's first deposit leaves this many shares with nobody, for good. */
const DEAD_SHARES = 1_000n;

const big = (text: string): bigint => BigInt(text);
const percent = (part: bigint, whole: bigint): string => (whole === 0n ? "0%" : `${Number((part * 1000n) / whole) / 10}%`);
/** "+$6.62" or "−$32.69". */
const signed = (amount: bigint): string => `${amount < 0n ? "−" : "+"}${usd(amount < 0n ? -amount : amount)}`;
/** USDC for one share, to four places. Both have six decimals, so the ratio is the price. */
const sharePrice = (basis: bigint, totalShares: bigint): string =>
  totalShares === 0n ? "1.0000" : (Number((basis * 10_000n) / totalShares) / 10_000).toFixed(4);
const shareCount = (shares: bigint): string => (Number(shares) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 2 });
const promoName = (p: VaultPromo): string => `${p.item ?? "Promo"} · ${p.condition ?? p.game ?? `promo ${p.promoId}`}`;

/** The vault, read again every 15 seconds and whenever an event on it reaches the keeper. */
function useVault(): { vault: Vault | null; failed: boolean; reload: () => Promise<void> } {
  const [vault, setVault] = useState<Vault | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(
    (signal?: AbortSignal) =>
      keeper.vault(signal).then(
        (next) => {
          setVault(next);
          setFailed(false);
        },
        () => {
          if (!signal?.aborted) setFailed(true);
        },
      ),
    [],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    const timer = window.setInterval(() => void load(controller.signal), 15_000);
    let again: number | undefined;
    const close = follow("/events", {
      onReady: () => undefined,
      // Several events in one block arrive together and share one read.
      onEvent: () => {
        window.clearTimeout(again);
        again = window.setTimeout(() => void load(controller.signal), 300);
      },
      onDown: () => undefined,
    });
    return () => {
      controller.abort();
      window.clearInterval(timer);
      window.clearTimeout(again);
      close();
    };
  }, [load]);

  return { vault, failed, reload: load };
}

export function LpView() {
  const { vault, failed, reload } = useVault();
  const [account, setAccount] = useState<Address | null>(null);
  const [mine, setMine] = useState<Position | null>(null);
  const [walletError, setWalletError] = useState<string | null>(null);
  const now = Math.floor(useNow(15_000) / 1000);
  const address = vault?.vault;
  const block = vault?.block;

  // A wallet that already shares its account with this site is used without asking again.
  useEffect(() => {
    void connected().then(setAccount);
    return onAccount(setAccount);
  }, []);

  // What the account holds, read again whenever the vault's numbers are.
  useEffect(() => {
    if (!account || !address) return;
    let live = true;
    position(account, address).then(
      (next) => live && setMine(next),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [account, address, block]);

  if (!vault) {
    return (
      <Frame>
        {failed ? (
          <p className="rounded-[10px] border border-line bg-card p-5 text-[16px]">We can&apos;t reach the vault&apos;s numbers right now. This page tries again by itself.</p>
        ) : (
          <div className="h-[260px] animate-pulse rounded-[10px] border border-line bg-card" aria-label="Loading" />
        )}
      </Frame>
    );
  }

  const balance = big(vault.balance);
  const locked = big(vault.locked);
  const free = big(vault.free);
  const lockedShare = balance === 0n ? 0 : Number((locked * 1000n) / balance) / 10;
  const open = vault.promos.filter((p) => big(p.locked) > 0n || p.net === null).reverse();
  const settled = vault.promos.filter((p) => p.net !== null && big(p.locked) === 0n).reverse();
  const held = account && mine ? mine : null;

  return (
    <Frame>
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-[26px] font-semibold leading-tight tracking-tight">FreeIf vault</h1>
          <p className="mt-1 max-w-[560px] text-[15px] text-ink/60">
            Deposits underwrite merchant promos. The vault keeps the premium when a promo&apos;s result is &ldquo;no&rdquo; and pays the
            promo&apos;s customers when it is &ldquo;yes&rdquo;.
          </p>
        </div>
        <div className="shrink-0 text-right">
          {account ? (
            <a className="num text-[14px] underline underline-offset-2" href={explorerAddress(account)} target="_blank" rel="noreferrer">
              {shortAddress(account)}
            </a>
          ) : (
            <Button
              className="!h-10 !w-auto text-[14px]"
              onClick={() => {
                setWalletError(null);
                connect().then(setAccount, (err: Error) => setWalletError(injected() ? walletMessage(err) : "No wallet found in this browser."));
              }}
            >
              Connect wallet
            </Button>
          )}
          {walletError && (
            <p role="alert" className="mt-1 text-[13px] text-stop">
              {walletError}
            </p>
          )}
        </div>
      </header>

      <dl className="mt-6 grid grid-cols-3 gap-3 border-y border-line py-4">
        <Headline value={usd(balance)} label="Total in vault" />
        <Headline value={percent(locked, balance)} label="In use" />
        <Headline value={signed(big(vault.netEarned))} label="Net earned" />
      </dl>

      <section className="mt-5">
        <div className="relative h-3 overflow-hidden rounded-full bg-line" role="img" aria-label={`${lockedShare}% of the vault is locked`}>
          <div className="h-full bg-ink" style={{ width: `${Math.min(lockedShare, 100)}%` }} />
          {/* The pricing service's ceiling. */}
          <div className="absolute top-0 h-full w-[3px] bg-stop" style={{ left: `${vault.maxLockedBps / 100}%` }} />
        </div>
        <p className="num mt-2 text-[14px]">
          {usd(locked)} locked · {usd(free)} available
        </p>
        <p className="mt-1 text-[14px] text-ink/60">
          A promo&apos;s full payout is locked when it is created. One promo&apos;s risk (its payout less its premium) may be at most{" "}
          {vault.maxExposureBps / 100}% of what is available, and no new promo is priced once {vault.maxLockedBps / 100}% of the vault would
          be locked (the red mark).
        </p>
      </section>

      <Trade vault={vault} account={account} held={held} onDone={reload} onConnect={setAccount} />

      <section className="mt-8">
        <h2 className="label mb-2">Open promos</h2>
        {open.length === 0 ? (
          <Empty>No promo is open. Nothing is locked.</Empty>
        ) : (
          <Table head={["Promo", "Locked", "Premium", "Break-even", "State"]}>
            {open.map((p) => (
              <Row key={p.promoId} id={p.promoId} name={promoName(p)}>
                <Cell label="Locked">{usd(p.locked)}</Cell>
                <Cell label="Premium">{usd(p.premium)}</Cell>
                {/* The chance of "yes" at which the premium exactly pays for the payout. */}
                <Cell label="Break-even">{percent(big(p.premium), big(p.maxPayout))}</Cell>
                <Cell label="State">{openState(p, now)}</Cell>
              </Row>
            ))}
          </Table>
        )}
      </section>

      <section className="mt-8">
        <h2 className="label mb-2">Settled</h2>
        {settled.length === 0 ? (
          <Empty>No promo has a final result yet.</Empty>
        ) : (
          <Table head={["Promo", "Result", "Premium", "Paid out", "Net"]}>
            {settled.map((p) => {
              const net = big(p.net ?? "0");
              const premium = big(p.premium);
              return (
                <Row key={p.promoId} id={p.promoId} name={promoName(p)}>
                  <Cell label="Result">{p.status === "Voided" ? "Voided" : p.outcomeYes ? "Yes" : "No"}</Cell>
                  <Cell label="Premium">{p.status === "Voided" ? "Refunded" : usd(premium)}</Cell>
                  <Cell label="Paid out">{p.status === "Voided" ? usd(0n) : usd(premium - net)}</Cell>
                  <Cell label="Net">{signed(net)}</Cell>
                </Row>
              );
            })}
          </Table>
        )}
      </section>

      <section className="mt-8">
        <h2 className="label mb-2">Risk</h2>
        <ul className="list-disc space-y-1.5 rounded-[10px] border border-line bg-card py-4 pl-9 pr-4 text-[14px]">
          <li>
            Results are posted by one keeper key, from the outcome Gemini publishes for the market. A result becomes final{" "}
            {duration(vault.disputeWindow)} later; until then the vault&apos;s owner can veto it.
          </li>
          <li>Withdrawals are priced on the available balance, so they can never reach locked funds.</li>
          <li>
            Leaving while promos are open gives up your part of their locks: if those promos end &ldquo;no&rdquo;, the released money goes
            to the providers who stayed.
          </li>
          <li>
            The {vault.maxExposureBps / 100}% limit is per promo and is in the contract. The {vault.maxLockedBps / 100}% ceiling across promos
            is enforced by the pricing service, not by the contract.
          </li>
          <li>Nothing is hedged: every promo is the vault&apos;s direct position against the outcome.</li>
          <li>This is Arc testnet. The USDC here is test money.</li>
        </ul>
        <p className="num mt-2 break-all text-[12px] text-ink/60">
          Vault{" "}
          <a className="underline underline-offset-2" href={explorerAddress(vault.vault)} target="_blank" rel="noreferrer">
            {vault.vault}
          </a>{" "}
          · read at block {vault.block}
        </p>
      </section>

      <Activity events={vault.events} />
    </Frame>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <>
      <main className="mx-auto w-full max-w-[760px] flex-1 px-4 pt-6">{children}</main>
      <SiteFooter />
    </>
  );
}

function Headline({ value, label }: { value: string; label: string }) {
  return (
    <div>
      <dd className="num text-[22px] font-semibold leading-7">{value}</dd>
      <dt className="label mt-1">{label}</dt>
    </div>
  );
}

const Empty = ({ children }: { children: React.ReactNode }) => (
  <p className="rounded-[10px] border border-line bg-card px-4 py-3 text-[15px] text-ink/60">{children}</p>
);

const COLUMNS = "md:grid md:grid-cols-[minmax(0,1fr)_96px_96px_96px_150px] md:items-baseline md:gap-3";

/** A table on a wide screen; under 768px each row is a small card with its labels. */
function Table({ head, children }: { head: string[]; children: React.ReactNode }) {
  return (
    <div className="divide-y divide-line rounded-[10px] border border-line bg-card">
      <div className={`hidden px-4 py-2 ${COLUMNS}`}>
        {head.map((title) => (
          <span key={title} className="label">
            {title}
          </span>
        ))}
      </div>
      {children}
    </div>
  );
}

function Row({ id, name, children }: { id: string; name: string; children: React.ReactNode }) {
  return (
    <div className={`px-4 py-3 text-[15px] ${COLUMNS}`}>
      <Link className="block truncate font-medium underline underline-offset-2 md:font-normal" href={`/promo/${id}`}>
        {name}
      </Link>
      <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 md:contents">{children}</dl>
    </div>
  );
}

function Cell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-2 md:block">
      <dt className="label md:hidden">{label}</dt>
      <dd className="num text-[14px]">{children}</dd>
    </div>
  );
}

function duration(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600} hour${seconds === 3600 ? "" : "s"}`;
  if (seconds % 60 === 0) return `${seconds / 60} minute${seconds === 60 ? "" : "s"}`;
  return `${seconds} seconds`;
}

function openState(p: VaultPromo, now: number): string {
  switch (p.status) {
    case "Open":
      return now !== 0 && now >= p.claimDeadline ? "Awaiting result" : `Open, ${p.claimCount} of ${p.maxClaims}`;
    case "Settled":
      return p.outcomeYes ? "Yes posted" : "No posted";
    case "Vetoed":
      return "Under review";
    case "FinalizedYes":
      return "Paying";
    default:
      return p.status;
  }
}

function walletMessage(err: unknown): string {
  const e = err as { code?: number; shortMessage?: string; message?: string; cause?: { code?: number } };
  // 4001: the person said no in the wallet.
  if (e.code === 4001 || e.cause?.code === 4001 || /rejected|denied/i.test(e.message ?? "")) return "Cancelled in the wallet.";
  return e.shortMessage ?? e.message?.split("\n")[0] ?? "Something went wrong. Try again.";
}

/** Deposit and withdraw. Both prices are shown, because they differ whenever a promo is open. */
function Trade({
  vault,
  account,
  held,
  onDone,
  onConnect,
}: {
  vault: Vault;
  account: Address | null;
  held: Position | null;
  onDone: () => Promise<void>;
  onConnect: (account: Address) => void;
}) {
  const [tab, setTab] = useState<"deposit" | "withdraw">("deposit");
  const [text, setText] = useState("");
  const [step, setStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ what: string; hash: string } | null>(null);

  const totalShares = big(vault.totalShares);
  const free = big(vault.free);
  const pending = big(vault.pending);
  const basis = big(vault.depositBasis);
  const shares = held?.shares ?? 0n;
  // What the position is worth today, and what it leaves in open promos if it is taken out today.
  const withdrawable = totalShares === 0n ? 0n : (shares * free) / totalShares;
  const inLocks = totalShares === 0n ? 0n : (shares * pending) / totalShares;

  const amount = parseDollars(text);
  const minted = amount === null ? 0n : totalShares === 0n ? amount - DEAD_SHARES : basis === 0n ? 0n : (amount * totalShares) / basis;
  // Shares to burn for `amount`, rounded up so the wallet receives at least what was typed. Amounts are
  // typed in cents, so one that is every whole cent of what can be withdrawn burns all the shares:
  // "Max" must not leave a fraction of a cent behind as shares.
  const wholeCents = (withdrawable / 10_000n) * 10_000n;
  const burned = amount === null || free === 0n ? 0n : amount >= wholeCents ? shares : (amount * totalShares + free - 1n) / free;
  const received = totalShares === 0n ? 0n : (burned * free) / totalShares;
  const leftBehind = totalShares === 0n ? 0n : (burned * pending) / totalShares;

  const spendable = held ? (held.balance > FEE_BUFFER ? held.balance - FEE_BUFFER : 0n) : 0n;
  const problem =
    amount === null
      ? null
      : tab === "deposit"
        ? vault.paused
          ? "Deposits are paused."
          : held && amount > spendable
            ? `This wallet has ${usd(held.balance)}; it also pays the network fee from it.`
            : minted <= 0n
              ? "That is too small to buy a share."
              : null
        : shares === 0n
          ? "This wallet has no shares."
          : amount > withdrawable
            ? `${usd(withdrawable)} can be withdrawn now.`
            : null;

  async function run() {
    if (!account || amount === null) return;
    setError(null);
    setDone(null);
    try {
      const hash =
        tab === "deposit" ? await deposit(account, vault.vault, amount, setStep) : await withdraw(account, vault.vault, burned, setStep);
      setDone({ what: tab === "deposit" ? `Deposited ${usd(amount)}` : `Withdrew ${usd(received)}`, hash });
      setText("");
      await onDone();
    } catch (err) {
      setError(walletMessage(err));
    } finally {
      setStep(null);
    }
  }

  return (
    <section className="mt-6 rounded-[10px] border border-line bg-card">
      <div className="flex border-b border-line" role="tablist">
        {(["deposit", "withdraw"] as const).map((name) => (
          <button
            key={name}
            role="tab"
            aria-selected={tab === name}
            className={`h-11 flex-1 text-[15px] font-medium capitalize ${tab === name ? "border-b-2 border-ink" : "text-ink/60"}`}
            onClick={() => {
              setTab(name);
              setText("");
              setError(null);
            }}
          >
            {name}
          </button>
        ))}
      </div>

      <div className="space-y-4 p-4">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
          <Fact label="Your shares" value={held ? shareCount(shares) : "–"} />
          <Fact label="Share of vault" value={held ? percent(shares, totalShares) : "–"} />
          <Fact label="Withdrawable now" value={held ? usd(withdrawable) : "–"} />
          <Fact label="Your part of locks" value={held ? usd(inLocks) : "–"} />
        </dl>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 border-t border-line pt-3">
          <Fact label="Deposit price" value={`${sharePrice(basis, totalShares)} USDC`} note="per share: available plus the locks of promos still running" />
          <Fact label="Withdraw price" value={`${sharePrice(free, totalShares)} USDC`} note="per share: available only" />
        </dl>

        <div>
          <label className="label mb-1 block" htmlFor="lp-amount">
            {tab === "deposit" ? "Amount to deposit (USDC)" : "Amount to receive (USDC)"}
          </label>
          <div className="flex gap-2">
            <Input
              id="lp-amount"
              inputMode="decimal"
              placeholder="0.00"
              value={text}
              className="num"
              onChange={(e) => {
                setText(e.target.value);
                setDone(null);
              }}
            />
            <Button
              variant="secondary"
              className="!w-auto shrink-0 text-[14px]"
              disabled={!held}
              onClick={() => setText((Number(tab === "deposit" ? spendable / 10_000n : withdrawable / 10_000n) / 100).toFixed(2))}
            >
              Max
            </Button>
          </div>
          {amount !== null && !problem && (
            <p className="num mt-2 text-[14px] text-ink/60">
              {tab === "deposit"
                ? `You get ${shareCount(minted)} shares.`
                : `You burn ${shareCount(burned)} shares and receive ${usd(received)}.${leftBehind > 0n ? ` ${usd(leftBehind)} stays behind in open promos.` : ""}`}
            </p>
          )}
          {problem && (
            <p role="alert" className="mt-2 text-[14px] text-stop">
              {problem}
            </p>
          )}
        </div>

        {account ? (
          <Button disabled={amount === null || problem !== null || step !== null} onClick={run}>
            {step ?? (tab === "deposit" ? "Deposit" : "Withdraw")}
          </Button>
        ) : (
          <Button onClick={() => connect().then(onConnect, (err: Error) => setError(injected() ? walletMessage(err) : "No wallet found in this browser."))}>
            Connect wallet
          </Button>
        )}
        {tab === "withdraw" && pending > 0n && (
          <p className="text-[14px] text-ink/60">Locked funds free up when their promos end. Shares that stay keep their part of them.</p>
        )}
        {error && (
          <p role="alert" className="text-[14px] text-stop">
            {error}
          </p>
        )}
        {done && (
          <p className="text-[14px]" role="status">
            {done.what}.{" "}
            <a className="num underline underline-offset-2" href={explorerTx(done.hash)} target="_blank" rel="noreferrer">
              Arc tx
            </a>
          </p>
        )}
      </div>
    </section>
  );
}

function Fact({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div>
      <dt className="label">{label}</dt>
      <dd className="num text-[16px]">{value}</dd>
      {note && <dd className="text-[12px] text-ink/60">{note}</dd>}
    </div>
  );
}

type ActivityLine = { id: string; at: number; text: string; amount: bigint | null; hash: string; via: "stream" | "rpc" };

/** The vault's money events, newest first. Payouts sent in one transaction are one line. */
function activityLines(events: FeedEvent[]): ActivityLine[] {
  const lines: ActivityLine[] = [];
  for (const e of events) {
    const amount = e.amount === undefined ? 0n : big(e.amount);
    const promo = `Promo ${e.promoId}`;
    const last = lines.at(-1);
    switch (e.event) {
      case "Deposited":
        lines.push({ id: e.id, at: e.at, text: "Deposit", amount, hash: e.hash, via: e.via });
        break;
      case "Withdrawn":
        lines.push({ id: e.id, at: e.at, text: "Withdrawal", amount: -amount, hash: e.hash, via: e.via });
        break;
      case "PromoCreated":
        lines.push({ id: e.id, at: e.at, text: `${promo} created, premium in`, amount, hash: e.hash, via: e.via });
        break;
      case "Settled":
        lines.push({ id: e.id, at: e.at, text: `${promo}: result posted, ${e.outcomeYes ? "yes" : "no"}`, amount: null, hash: e.hash, via: e.via });
        break;
      case "Finalized":
        lines.push({
          id: e.id,
          at: e.at,
          text: e.outcomeYes ? `${promo} final: yes` : `${promo} final: no, ${usd(amount)} unlocked`,
          amount: null,
          hash: e.hash,
          via: e.via,
        });
        break;
      case "Paid":
        if (last && last.hash === e.hash && last.text.startsWith(`${promo} paid`)) {
          const count = Number(/paid (\d+)/.exec(last.text)?.[1] ?? 1) + 1;
          last.text = `${promo} paid ${count} customers`;
          last.amount = (last.amount ?? 0n) - amount;
        } else {
          lines.push({ id: e.id, at: e.at, text: `${promo} paid 1 customer`, amount: -amount, hash: e.hash, via: e.via });
        }
        break;
      case "Voided":
        lines.push({ id: e.id, at: e.at, text: `${promo} voided, premium refunded`, amount: -amount, hash: e.hash, via: e.via });
        break;
      case "PayoutFailed":
        lines.push({ id: e.id, at: e.at, text: `${promo}: a payout failed and waits`, amount: null, hash: e.hash, via: e.via });
        break;
      default:
        break;
    }
  }
  return lines.reverse();
}

function Activity({ events }: { events: FeedEvent[] }) {
  const lines = activityLines(events);
  return (
    <section className="mt-8">
      <h2 className="label mb-2">Activity</h2>
      {lines.length === 0 ? (
        <Empty>Nothing has happened on the vault yet.</Empty>
      ) : (
        <ul className="divide-y divide-line rounded-[10px] border border-line bg-card">
          {lines.map((line) => (
            <li key={line.id} className="fade-in flex items-baseline gap-3 px-4 py-2.5 text-[14px]">
              <span className="num w-[104px] shrink-0 text-[12px] text-ink/60">{dayTime(line.at)}</span>
              <span className="min-w-0 flex-1">
                {line.text}
                <span className="num block text-[12px] text-ink/60">{line.via === "stream" ? "QuickNode Stream" : "RPC"}</span>
              </span>
              <span className="num shrink-0">{line.amount === null ? "" : signed(line.amount)}</span>
              <a className="num shrink-0 text-[12px] underline underline-offset-2" href={explorerTx(line.hash)} target="_blank" rel="noreferrer">
                tx
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

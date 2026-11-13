"use client";

// /card/[promoId]#<key>: a claim card, scanned. The key is after "#", so it reached no server; the page
// reads it here, works out the card's address, and asks the keeper about that address and Arc for its
// balance. Nobody logs in to look. To collect, the holder logs in by email (the same login as everywhere
// else) and this browser sends the card's balance, less its processing fee, to their FreeIf account.
//
// The key is never sent anywhere, logged or stored: only the card's address leaves this page.
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { CashOut } from "@/components/cash-out";
import { EmailStep } from "@/components/email-step";
import { SiteFooter } from "@/components/mechanics";
import { RuleText } from "@/components/rule-text";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { usdcBalance } from "@/lib/balance";
import { addressOf, CARD_DUST, collect, CollectError, keyFromHash } from "@/lib/cards";
import { capitalize, dayTime, usd } from "@/lib/format";
import type { Promo } from "@/lib/keeper";
import { useNow } from "@/lib/use-now";
import { usePromo } from "@/lib/use-promo";
import { useWallet, type Session } from "@/lib/wallet";

// The part of the address after "#". It changes when another card is scanned into the same tab.
function subscribeHash(notify: () => void) {
  window.addEventListener("hashchange", notify);
  return () => window.removeEventListener("hashchange", notify);
}
/** Null on the server and on the first render, before the browser has said. */
const useHash = () =>
  useSyncExternalStore(
    subscribeHash,
    () => window.location.hash,
    () => null,
  );

type Phase = { name: "idle"; error?: string } | { name: "collecting" } | { name: "done"; amount: bigint; to: `0x${string}` };

/** What the card says, from the promo and the card's own balance. */
type Face = {
  badge: string;
  tone: "go" | "plain" | "grey";
  headline: string;
  line: string | null;
  collectable: boolean;
};

function face(promo: Promo, balance: bigint, now: number): Face {
  const each = usd(promo.payoutPerClaim);
  const condition = promo.condition ?? "it happens";
  const subject = capitalize(promo.subject ?? "");
  const number = promo.customer?.number ?? null;
  const owed = BigInt(promo.customer?.owed ?? "0");
  // Money on the card is its holder's, whatever brought it there.
  if (balance >= CARD_DUST) {
    return { badge: "✓ READY TO COLLECT", tone: "go", headline: `This card is worth ${usd(balance)}`, line: "Collect it into your FreeIf account. It takes a minute.", collectable: true };
  }
  if (promo.status === "Voided") {
    return { badge: "CANCELLED", tone: "grey", headline: "This card is cancelled", line: "The game was cancelled, so this promo is off.", collectable: false };
  }
  if (number === null) {
    return {
      badge: "NOT ACTIVE",
      tone: "grey",
      headline: "This card isn't active",
      line: promo.status === "Open" && now < promo.claimDeadline ? "If you just got it, give it a minute and scan it again." : "Ask where you got it.",
      collectable: false,
    };
  }
  if (owed > 0n) {
    return { badge: subject ? `${subject.toUpperCase()} WON` : "IT HAPPENED", tone: "go", headline: "Your team won", line: `Your ${usd(owed)} is set aside. We're sending it again.`, collectable: false };
  }
  switch (promo.status) {
    case "Open": {
      const due = promo.eventStartTime
        ? `Kickoff ${dayTime(promo.eventStartTime)}. The result is usually in about three hours later: scan this card again then.`
        : "Scan this card again once the result is in.";
      return { badge: "IN PLAY", tone: "go", headline: `This card is worth ${each} if ${condition}`, line: due, collectable: false };
    }
    case "Settled":
    case "FinalizedYes":
      if (promo.outcomeYes) {
        return { badge: subject ? `${subject.toUpperCase()} WON` : "IT HAPPENED", tone: "go", headline: subject ? "Your team won" : "It happened", line: `${each} is on its way to this card. Keep this page open.`, collectable: false };
      }
      return { badge: "NOT THIS TIME", tone: "grey", headline: "This card didn't win", line: subject ? `${subject} lost. Nothing to collect.` : "It didn't happen. Nothing to collect.", collectable: false };
    case "FinalizedNo":
      return { badge: "NOT THIS TIME", tone: "grey", headline: "This card didn't win", line: subject ? `${subject} lost. Nothing to collect.` : "It didn't happen. Nothing to collect.", collectable: false };
    case "Vetoed":
      return { badge: "CHECKING", tone: "plain", headline: `This card is worth ${each} if ${condition}`, line: "The result is being checked. Scan this card again later.", collectable: false };
    case "PaidOut":
      return promo.customer?.paid
        ? { badge: "COLLECTED", tone: "grey", headline: "Already collected", line: `This card's ${each} has been collected.`, collectable: false }
        : { badge: subject ? `${subject.toUpperCase()} WON` : "IT HAPPENED", tone: "go", headline: subject ? "Your team won" : "It happened", line: `${each} is on its way to this card.`, collectable: false };
  }
}

export function CardView({ promoId }: { promoId: string }) {
  const wallet = useWallet();
  const hash = useHash();
  const key = useMemo(() => (hash === null ? null : keyFromHash(hash)), [hash]);
  const address = useMemo(() => (key === null ? null : addressOf(key)), [key]);
  const { promo, missing, unreachable } = usePromo(promoId, address);
  const now = Math.floor(useNow(5000) / 1000);
  const [balance, setBalance] = useState<{ of: string; value: bigint } | null>(null);
  const [phase, setPhase] = useState<Phase>({ name: "idle" });
  const [details, setDetails] = useState(false);
  const [cashOut, setCashOut] = useState(false);
  // Counts the times money has moved, so balances are read again after each.
  const [moves, setMoves] = useState(0);

  // The card's balance: read when the card is known and again whenever its promo moves on.
  const status = promo?.status;
  const paid = promo?.customer?.paid;
  useEffect(() => {
    if (!address) return;
    let live = true;
    usdcBalance(address).then(
      (value) => live && setBalance({ of: address, value }),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [address, status, paid, moves]);

  const run = useCallback(
    async (session: Session) => {
      if (!key) return;
      setPhase({ name: "collecting" });
      try {
        const { amount } = await collect(key, session.address);
        setPhase({ name: "done", amount, to: session.address });
      } catch (err) {
        setPhase({ name: "idle", error: err instanceof CollectError ? err.message : "That didn't go through. Try again in a moment." });
      } finally {
        setMoves((n) => n + 1);
      }
    },
    [key],
  );

  if (hash !== null && key === null) {
    return <Note>This card can&apos;t be read. Scan the code on the card again.</Note>;
  }
  if (missing) return <Note>We couldn&apos;t find this card&apos;s promo. Check you scanned the whole code.</Note>;
  if (unreachable) return <Note>We can&apos;t reach FreeIf right now. Keep this page open: it keeps trying.</Note>;
  const cardBalance = balance !== null && balance.of === address ? balance.value : null;
  if (!promo || now === 0 || key === null || cardBalance === null) {
    return (
      <Frame>
        <div className="h-[260px] animate-pulse rounded-[10px] border border-line bg-card" aria-label="Loading" />
      </Frame>
    );
  }

  if (phase.name === "done") {
    return (
      <Frame>
        <Collected amount={phase.amount} to={phase.to} moves={moves} onCashOut={() => setCashOut(true)} />
        <CashOut open={cashOut} onClose={() => setCashOut(false)} address={phase.to} onSent={() => setMoves((n) => n + 1)} />
      </Frame>
    );
  }

  const f = face(promo, cardBalance, now);
  const tone = f.tone === "go" ? "text-go" : f.tone === "grey" ? "text-ink/60" : "text-ink";
  const session = wallet.session;
  return (
    <Frame>
      <div className={`overflow-hidden rounded-[10px] border border-line bg-card ${f.tone === "grey" ? "text-ink/60" : ""}`}>
        <div className="px-5 pt-4">
          <div className="flex items-center justify-between gap-3">
            <span className="label truncate">{promo.business?.trim() || "Your place"}</span>
            <span className={`num shrink-0 text-[12px] font-medium tracking-[0.08em] ${tone}`}>{f.badge}</span>
          </div>
          <div className="mt-4 flex items-baseline justify-between gap-4">
            <span className="min-w-0 truncate text-[22px] font-semibold leading-7">{promo.item?.trim() || "Your purchase"}</span>
            <span className="num shrink-0 text-[22px] leading-7">{usd(promo.payoutPerClaim)}</span>
          </div>
          <p className="mt-1 text-[13px] font-semibold uppercase tracking-[0.06em]">Free if {promo.condition ?? "it happens"}</p>
        </div>
        <div className="relative my-4 h-[18px]">
          <span className="absolute -left-[10px] top-0 size-[18px] rounded-full border border-line bg-paper" />
          <span className="absolute -right-[10px] top-0 size-[18px] rounded-full border border-line bg-paper" />
          <span className="absolute left-4 right-4 top-1/2 border-t border-dashed border-line" />
        </div>
        <div className="space-y-1.5 px-5 pb-4 text-[15px]">
          <p>{promo.game ?? promo.eventTitle ?? "Event"}</p>
          {promo.customer?.number != null && (
            <p className="num text-[13px] text-ink/60">
              Card {promo.customer.number} of {promo.maxClaims}
            </p>
          )}
          <button className="pt-1 text-[14px] underline underline-offset-2" onClick={() => setDetails(true)}>
            Details ›
          </button>
        </div>
      </div>

      <div className="mt-6 space-y-3">
        <h1 className="text-[22px] font-semibold leading-tight">{f.headline}</h1>
        {f.line && <p className="text-[16px] text-ink/60">{f.line}</p>}
        {f.collectable &&
          (phase.name === "collecting" ? (
            <p className="flex items-center gap-3 text-[16px]" role="status">
              <span className="size-4 animate-spin rounded-full border-2 border-line border-t-ink" />
              Collecting
            </p>
          ) : session ? (
            <>
              <Button onClick={() => void run(session)}>Collect {usd(cardBalance)}</Button>
              <p className="text-[14px] text-ink/60">
                Into the account of {session.email}.{" "}
                <button className="underline underline-offset-2" onClick={wallet.logout}>
                  Use another email
                </button>
              </p>
            </>
          ) : (
            <EmailStep cta={`Collect ${usd(cardBalance)}`} hint="We email you a code. The money goes into your FreeIf account." onDone={(s) => void run(s)} />
          ))}
        {phase.name === "idle" && phase.error && (
          <p role="alert" className="text-[15px] text-stop">
            {phase.error}
          </p>
        )}
      </div>

      <Sheet open={details} onClose={() => setDetails(false)} title="Details">
        <div className="space-y-4 text-[15px]">
          <p>
            You got this card with {promo.item?.toLowerCase() ?? "your purchase"}. If {promo.condition ?? "it happens"}, it is worth{" "}
            <span className="num">{usd(promo.payoutPerClaim)}</span>. Whoever holds the card can collect it, so keep it like cash.
          </p>
          {promo.rule && (
            <div>
              <p className="label mb-1">The rule</p>
              <p className="text-[14px] text-ink/60">
                <RuleText text={promo.rule} />
              </p>
            </div>
          )}
          <p className="text-ink/60">A fraction of a cent stays on the card for the processing fee.</p>
          <Link className="block underline underline-offset-2" href={`/promo/${promoId}`}>
            See this promo&apos;s public page ›
          </Link>
        </div>
      </Sheet>
    </Frame>
  );
}

/** After collecting: what arrived, the account's balance, and Cash out. */
function Collected({ amount, to, moves, onCashOut }: { amount: bigint; to: `0x${string}`; moves: number; onCashOut: () => void }) {
  const [balance, setBalance] = useState<bigint | null>(null);
  useEffect(() => {
    let live = true;
    usdcBalance(to).then(
      (value) => live && setBalance(value),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [to, moves]);
  return (
    <div className="space-y-3">
      <div className="flex flex-col items-center rounded-[10px] border border-go/30 bg-go-tint px-5 py-8 text-center">
        <span className="num text-[12px] font-medium tracking-[0.08em] text-go">✓ COLLECTED</span>
        <span className="num mt-4 text-[44px] font-semibold leading-none">{usd(amount)}</span>
        <span className="mt-3 text-[15px]">is in your FreeIf account</span>
      </div>
      <div className="flex items-baseline justify-between rounded-[10px] border border-line bg-card px-4 py-3">
        <span className="text-[16px]">Your balance</span>
        <span className="num text-[18px]">{balance === null ? usd(amount) : usd(balance)}</span>
      </div>
      <Button onClick={onCashOut}>Cash out</Button>
      <p className="text-[14px] text-ink/60">Your money stays in your FreeIf account, under your email, until you cash out.</p>
    </div>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <Frame>
      <p className="rounded-[10px] border border-line bg-card p-5 text-[16px]">{children}</p>
    </Frame>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <>
      <main className="mx-auto w-full max-w-[440px] flex-1 px-4 pt-6">{children}</main>
      <SiteFooter />
    </>
  );
}

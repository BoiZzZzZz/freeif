"use client";

// /claim/[promoId] (prep/WIREFRAMES.md section 8): a customer at the counter scans, types an email and
// a code, and sees Covered. The card is above the email field, so they see the offer before being
// asked for anything. The relayer registers them; the customer sees nothing about it.
import Link from "next/link";
import { useEffect, useState } from "react";
import { EmailStep } from "@/components/email-step";
import { SiteFooter } from "@/components/mechanics";
import { ReceiptCard, type CardState } from "@/components/receipt-card";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { usdcBalance } from "@/lib/balance";
import { usd } from "@/lib/format";
import { keeper, KeeperError, type Promo } from "@/lib/keeper";
import { KEYS, NO_CLAIMS, readLocal, saveLocal, useLocal } from "@/lib/local";
import { coveredState, takingCustomers } from "@/lib/promo";
import { useNow } from "@/lib/use-now";
import { usePromo } from "@/lib/use-promo";
import { useWallet, type Session } from "@/lib/wallet";

// The keeper's answers when the login is no good: Circle does not know the token (it lasts an hour),
// or the account in this browser is not that login's.
const LOGIN_AGAIN = new Set(["login", "not-your-wallet"]);

function refusal(err: unknown, promo: Promo | null): string {
  if (err instanceof KeeperError) {
    if (err.code === "full") return `All ${promo?.maxClaims ?? ""} spots are taken.`.replace("  ", " ");
    if (err.code === "closed") return "This promo has stopped accepting customers.";
    if (err.code === "already-claimed") return "This email is already covered on this promo.";
    if (LOGIN_AGAIN.has(err.code)) return "Your login ran out. Enter your email again to get covered.";
    return err.message;
  }
  return "Something went wrong. Try again in a moment.";
}

export function ClaimView({ promoId }: { promoId: string }) {
  const wallet = useWallet();
  const claims = useLocal<Record<string, string>>(KEYS.claims, NO_CLAIMS);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState(false);
  const now = Math.floor(useNow(5000) / 1000);

  // The address to look for on the promo: the one this browser was covered with, or the login's.
  const address = claims[promoId] ?? wallet.session?.address ?? null;

  // The page stays open through the game: the result and the payout arrive here by themselves, the
  // moment the keeper has them.
  const { promo, missing, show } = usePromo(promoId, address);

  useEffect(() => wallet.warm(), [wallet]);

  async function register(session: Session) {
    setSaving(true);
    setError(null);
    try {
      // The login token goes with the claim: the keeper asks Circle whose it is before it covers anyone.
      await keeper.claim({ promoId, customer: session.address, userToken: session.userToken });
      saveLocal(KEYS.claims, { ...readLocal<Record<string, string>>(KEYS.claims, NO_CLAIMS), [promoId]: session.address });
      show(await keeper.promo(promoId, session.address));
    } catch (err) {
      // A login the keeper refuses is forgotten, so the email field is there again.
      if (err instanceof KeeperError && LOGIN_AGAIN.has(err.code)) wallet.logout();
      setError(refusal(err, promo));
    } finally {
      setSaving(false);
    }
  }

  if (missing) {
    return (
      <Frame>
        <p className="rounded-[10px] border border-line bg-card p-5 text-[16px]">We couldn&apos;t find this promo. Ask at the counter for the code to scan.</p>
      </Frame>
    );
  }
  if (!promo || now === 0) {
    return (
      <Frame>
        <div className="h-[260px] animate-pulse rounded-[10px] border border-line bg-card" aria-label="Loading" />
      </Frame>
    );
  }

  const covered = promo.customer !== null && promo.customer.number !== null;
  const taking = takingCustomers(promo, now);
  const state: CardState = covered
    ? coveredState(promo, now)
    : promo.status === "Voided"
      ? "cancelled"
      : taking === "yes"
        ? "open"
        : taking;
  const each = usd(promo.payoutPerClaim);
  // When this customer's payout was sent: the time of their own Paid event.
  const mine = promo.customer?.address.toLowerCase();
  const paidAt = promo.events.findLast((e) => e.event === "Paid" && e.customer?.toLowerCase() === mine)?.at ?? null;
  const item = promo.item?.toLowerCase();

  return (
    <Frame>
      <ReceiptCard
        state={state}
        business={promo.business}
        item={promo.item ?? "Your purchase"}
        amount={promo.payoutPerClaim}
        condition={promo.condition}
        subject={promo.subject}
        game={promo.game ?? promo.eventTitle}
        startTime={promo.eventStartTime}
        claimCount={promo.claimCount}
        maxClaims={promo.maxClaims}
        customerNumber={promo.customer?.number}
        paidAt={paidAt}
        onDetails={() => setDetails(true)}
      />

      <div className="mt-6 space-y-3">
        {saving ? (
          <p className="flex items-center gap-3 text-[16px]" role="status">
            <span className="size-4 animate-spin rounded-full border-2 border-line border-t-ink" />
            Saving your spot
          </p>
        ) : covered ? (
          <Covered promo={promo} state={state} address={promo.customer!.address} />
        ) : taking === "yes" ? (
          <>
            <h1 className="text-[22px] font-semibold leading-tight">{item ? `Bought ${item}? Get covered.` : "Made your purchase? Get covered."}</h1>
            <p className="text-[16px] text-ink/60">
              If {promo.condition ?? "it happens"}, you get <span className="num">{each}</span> back.
            </p>
            {wallet.session ? (
              <>
                <Button onClick={() => register(wallet.session!)}>Get covered</Button>
                <p className="text-[14px] text-ink/60">
                  As {wallet.session.email}.{" "}
                  <button className="underline underline-offset-2" onClick={wallet.logout}>
                    Use another email
                  </button>
                </p>
              </>
            ) : (
              <EmailStep cta="Get covered" hint="No app. No password. We email you a code." onDone={register} />
            )}
          </>
        ) : (
          <p className="rounded-[10px] border border-line bg-card p-4 text-[16px]">
            {promo.status === "Voided"
              ? "The game was cancelled. This promo is off."
              : taking === "full"
                ? `All ${promo.maxClaims} spots are taken.`
                : "This promo has stopped accepting customers."}
          </p>
        )}
        {error && (
          <p role="alert" className="text-[15px] text-stop">
            {error}
          </p>
        )}
      </div>

      <Sheet open={details} onClose={() => setDetails(false)} title="Details">
        <div className="space-y-4 text-[15px]">
          <p>
            You paid for {item ?? "your purchase"} at the counter. If {promo.condition ?? "it happens"}, you get{" "}
            <span className="num">{each}</span> back here.
          </p>
          {promo.rule && (
            <div>
              <p className="label mb-1">The rule</p>
              <p className="text-[14px] text-ink/60">{promo.rule}</p>
            </div>
          )}
          {covered && wallet.session && <p className="text-ink/60">Covered under {wallet.session.email}.</p>}
          <Link className="block underline underline-offset-2" href={`/promo/${promoId}`}>
            See this promo&apos;s public page ›
          </Link>
        </div>
      </Sheet>
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

/** Under the card of a covered customer: what to do (nothing), and after a payout, the balance. */
function Covered({ promo, state, address }: { promo: Promo; state: CardState; address: string }) {
  const [balance, setBalance] = useState<bigint | null>(null);
  const [cashOut, setCashOut] = useState(false);
  const paid = state === "paid";

  useEffect(() => {
    if (!paid) return;
    let live = true;
    usdcBalance(address as `0x${string}`).then(
      (value) => live && setBalance(value),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [paid, address]);

  if (paid) {
    return (
      <>
        <div className="flex items-baseline justify-between rounded-[10px] border border-line bg-card px-4 py-3">
          <span className="text-[16px]">Your balance</span>
          <span className="num text-[18px]">{balance === null ? usd(promo.payoutPerClaim) : usd(balance)}</span>
        </div>
        <Button onClick={() => setCashOut(true)}>Cash out</Button>
        <Sheet open={cashOut} onClose={() => setCashOut(false)} title="Cash out">
          <div className="space-y-3 text-[15px]">
            <p>Cash out to a bank or card is coming. This demo pays in test dollars.</p>
            <p className="text-ink/60">Your money is in your FreeIf account, under the email you used here.</p>
          </div>
        </Sheet>
      </>
    );
  }
  if (state === "covered" || state === "game-on") {
    return (
      <>
        <h1 className="text-[22px] font-semibold leading-tight">You&apos;re covered. Keep this page.</h1>
        <p className="text-[16px] text-ink/60">The result shows up here after the game, usually within three hours of kickoff.</p>
      </>
    );
  }
  if (state === "won") {
    return <p className="text-[16px]">You&apos;ll see {usd(promo.payoutPerClaim)} here in a moment. Nothing to do.</p>;
  }
  return null;
}

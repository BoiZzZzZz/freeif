"use client";

// /promo/[id]/cards: the merchant's claim cards. Right after Pay, this browser makes one card per customer
// the promo takes, keeps them here, and sends the keeper the cards' addresses with the merchant's login.
// The keeper registers each card on the promo; the page shows how many are ready and the sheet to print.
// The cards' keys stay in this browser and on paper: FreeIf never sees them.
import Link from "next/link";
import { QRCodeSVG } from "qrcode.react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { EmailStep } from "@/components/email-step";
import { SiteFooter } from "@/components/mechanics";
import { Button } from "@/components/ui/button";
import { addressOf, cardUrl, loadCards, makeKeys, saveCards, type CardSet } from "@/lib/cards";
import { dayTime, usd } from "@/lib/format";
import { keeper, KeeperError, type Promo } from "@/lib/keeper";
import { cardsKey, KEYS, NO_PROMOS, useLocal, type MyPromo } from "@/lib/local";
import { promoTitle } from "@/lib/promo";
import { useNow } from "@/lib/use-now";
import { usePromo } from "@/lib/use-promo";
import { useWallet, type Session } from "@/lib/wallet";

/** How long the page waits before it sends cards again that the keeper has not registered. */
const RESEND_MS = 20_000;
/** The keeper takes up to 500 cards a request. */
const PER_REQUEST = 500;
/** Cards shown on the screen; every one of them prints. */
const ON_SCREEN = 4;
/** The storage key read while the promo's vault is not known yet: nothing is ever stored under it. */
const NO_CARDS_KEY = "freeif.cards.none";
const LOGIN_AGAIN = new Set(["login", "not-your-promo"]);

const noop = () => () => {};
const useOrigin = () =>
  useSyncExternalStore(
    noop,
    () => window.location.origin,
    () => "",
  );

export function CardsView({ id }: { id: string }) {
  const wallet = useWallet();
  const session = wallet.session;
  const mine = useLocal<MyPromo[]>(KEYS.promos, NO_PROMOS);
  const { promo, missing, unreachable, show } = usePromo(id);
  const vault = promo?.vault ?? null;
  const set = useLocal<CardSet | null>(vault ? cardsKey(vault, id) : NO_CARDS_KEY, null);
  const now = Math.floor(useNow(5000) / 1000);
  const origin = useOrigin();
  const [sending, setSending] = useState(false);
  // A refusal that sending again would not change ("closed", "full"). The page stops sending.
  const [refusal, setRefusal] = useState<string | null>(null);
  const [loginNote, setLoginNote] = useState<string | null>(null);
  const [cannotKeep, setCannotKeep] = useState(false);
  const sentAt = useRef(0);

  const paidHere = mine.some((p) => p.id === id);
  const merchant = paidHere || (session !== null && promo !== null && session.address.toLowerCase() === promo.merchant.toLowerCase());
  const open = promo !== null && promo.status === "Open" && now > 0 && now < promo.claimDeadline;
  const addresses = useMemo(() => set?.keys.map(addressOf) ?? [], [set]);
  const registered = useMemo(() => new Set((promo?.cardProgress?.registered ?? []).map((a) => a.toLowerCase())), [promo]);
  const unsent = addresses.filter((a) => !registered.has(a.toLowerCase()));
  const unsentKey = unsent.join(",");
  const queued = promo?.cardProgress?.queued ?? 0;
  const ready = addresses.length - unsent.length;

  /** Makes this promo's cards and keeps them in this browser, before any address leaves it. */
  const make = useCallback(
    (p: Promo, v: string) => {
      // Another tab, or an earlier pass of this effect, may have made them already.
      if (loadCards(v, id) !== null) return;
      if (!saveCards(v, id, { keys: makeKeys(p.maxClaims), at: Date.now(), printedAt: null })) setCannotKeep(true);
    },
    [id],
  );

  // The browser that paid makes the cards by itself, once, while the promo takes customers and has none.
  const autoMake = promo !== null && promo.cards === true && vault !== null && set === null && paidHere && promo.claimCount === 0 && open && !cannotKeep;
  useEffect(() => {
    if (!autoMake || !promo || !vault) return;
    const timer = window.setTimeout(() => make(promo, vault), 0);
    return () => window.clearTimeout(timer);
  }, [autoMake, promo, vault, make]);

  const send = useCallback(
    async (who: Session, list: string[]) => {
      setSending(true);
      sentAt.current = Date.now();
      try {
        for (let i = 0; i < list.length; i += PER_REQUEST) {
          await keeper.sendCards(id, list.slice(i, i + PER_REQUEST), who.userToken);
        }
        setLoginNote(null);
        // The keeper answers before it registers anything: read how many it has in its line.
        await keeper.promo(id).then(show, () => undefined);
      } catch (err) {
        if (err instanceof KeeperError && LOGIN_AGAIN.has(err.code)) {
          // A login the keeper refuses is forgotten, so the email field is there again.
          wallet.logout();
          setLoginNote(err.code === "not-your-promo" ? err.message : "Your login ran out. Enter your email again to get your cards ready.");
        } else if (err instanceof KeeperError && err.status >= 400 && err.status < 500 && err.status !== 429) {
          setRefusal(err.message);
        }
        // Anything else is the keeper or the connection: the page sends again after a pause.
      } finally {
        setSending(false);
      }
    },
    [id, show, wallet],
  );

  // Cards this browser holds that the keeper has neither registered nor in its line are sent, and sent
  // again after a pause while that is still so: after a failure, or a restart of the keeper.
  const due = promo?.cards === true && set !== null && open && unsentKey !== "" && queued === 0 && !sending && refusal === null;
  useEffect(() => {
    if (!due || !session) return;
    const wait = Math.max(0, sentAt.current + RESEND_MS - Date.now());
    const timer = window.setTimeout(() => void send(session, unsentKey.split(",")), wait);
    return () => window.clearTimeout(timer);
  }, [due, session, unsentKey, send]);

  if (missing) return <Note>We couldn&apos;t find this promo.</Note>;
  if (unreachable) return <Note>We can&apos;t reach FreeIf right now. This page keeps trying.</Note>;
  if (!promo || now === 0) {
    return (
      <Frame>
        <div className="h-[220px] animate-pulse rounded-[10px] border border-line bg-card" aria-label="Loading" />
      </Frame>
    );
  }

  const back = (
    <Link className="mt-3 block text-[15px] underline underline-offset-2" href={`/promo/${id}`}>
      See the promo ›
    </Link>
  );
  if (!promo.cards) {
    return (
      <Note>
        This promo doesn&apos;t use cards. Customers get covered by scanning its counter sign.
        {back}
      </Note>
    );
  }

  if (set === null) {
    if (promo.claimCount > 0) {
      return (
        <Note>
          These cards were made on another device. Open this page in the browser you made them in to print them again.
          {back}
        </Note>
      );
    }
    if (!open) return <Note>This promo stopped taking customers before its cards were made.{back}</Note>;
    if (!merchant) return <Note>Only the shop that paid for this promo can make its cards.{back}</Note>;
    if (cannotKeep) {
      return <Note>This browser can&apos;t keep your cards. Open this page in a normal window, not a private one, on the device you paid from.</Note>;
    }
    if (!paidHere) {
      return (
        <Frame>
          <div className="space-y-3 rounded-[10px] border border-line bg-card p-5 text-[16px]">
            <p>Your cards are made in the browser you paid from. Open this page there to make and print them.</p>
            <p className="text-[14px] text-ink/60">Only make them here if you haven&apos;t made them anywhere else.</p>
            <Button variant="secondary" onClick={() => vault && make(promo, vault)}>
              Make the cards here
            </Button>
          </div>
        </Frame>
      );
    }
    return (
      <Frame>
        <p className="flex items-center gap-3 text-[16px]" role="status">
          <span className="size-4 animate-spin rounded-full border-2 border-line border-t-ink" />
          Making your cards
        </p>
      </Frame>
    );
  }

  const total = set.keys.length;
  const each = usd(promo.payoutPerClaim);
  const condition = promo.condition ?? "it happens";
  const item = promo.item?.trim() || "your purchase";
  const allReady = unsent.length === 0;

  function print() {
    if (!vault || !set) return;
    saveCards(vault, id, { ...set, printedAt: Date.now() });
    window.print();
  }

  return (
    <Frame wide>
      <div className="print:hidden">
        <Link href={`/promo/${id}`} className="mb-4 inline-block text-[14px] underline underline-offset-2">
          ‹ The promo
        </Link>
        <p className="label">Your cards</p>
        <h1 className="mt-1 text-[26px] font-semibold leading-tight tracking-tight">{promoTitle(promo.item, promo.condition)}</h1>
        <p className="mt-1 text-[15px] text-ink/60">
          Hand one card to each customer who buys {item.toLowerCase()}. If {condition}, each card is worth {each}.
        </p>

        <section className="mt-6 rounded-[10px] border border-line bg-card p-4">
          <div className="flex items-baseline justify-between">
            <span className="text-[17px] font-medium">
              <span className="num">
                {ready} of {total}
              </span>{" "}
              cards ready
            </span>
            {allReady && <span className="num text-[12px] font-medium tracking-[0.08em] text-go">✓ READY</span>}
          </div>
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-line" aria-hidden>
            <div className="h-full rounded-full bg-go transition-[width]" style={{ width: `${total === 0 ? 0 : (ready / total) * 100}%` }} />
          </div>
          <div className="mt-4 space-y-3">
            {allReady ? (
              <p className="text-[15px]">All {total} cards are ready. Print them and keep them at the counter.</p>
            ) : refusal ? (
              <p role="alert" className="text-[15px] text-stop">
                {refusal}
              </p>
            ) : !open ? (
              <p role="alert" className="text-[15px] text-stop">
                This promo stopped taking customers before {unsent.length} of these cards were ready. Those cards will not be paid.
              </p>
            ) : !session ? (
              <>
                <p className="text-[15px]">{loginNote ?? "Log in with the email you paid with to get your cards ready."}</p>
                <EmailStep cta="Get my cards ready" hint="We email you a code." onDone={() => undefined} />
              </>
            ) : (
              <p className="flex items-center gap-3 text-[15px]" role="status">
                <span className="size-4 animate-spin rounded-full border-2 border-line border-t-ink" />
                Getting your cards ready. Keep this page open.
              </p>
            )}
          </div>
        </section>

        <section className="mt-4 space-y-3">
          {set.printedAt === null ? (
            <p className="rounded-[10px] border border-stop/30 bg-stop-tint px-4 py-3 text-[15px]">
              These cards live only in this browser until you print them. Print them now. Keep them like cash: whoever holds a card can
              collect it.
            </p>
          ) : (
            <p className="text-[14px] text-ink/60">
              Printed <span className="num">{dayTime(Math.floor(set.printedAt / 1000))}</span>. You can print them again from this browser any time.
            </p>
          )}
          <Button onClick={print} disabled={origin === ""}>
            Print {total} cards
          </Button>
          <p className="text-[14px] text-ink/60">
            Cards you don&apos;t hand out are yours. If {condition}, scan them like a customer would to collect.
          </p>
        </section>

        <p className="label mb-2 mt-8">
          The sheet{total > ON_SCREEN ? ` · ${ON_SCREEN} of ${total} shown, all ${total} print` : ""}
        </p>
      </div>

      <section className="card-sheet grid gap-3 sm:grid-cols-2 print:grid-cols-2 print:gap-0">
        {origin !== "" &&
          set.keys.map((key, i) => (
            <PrintedCard
              key={key}
              hidden={i >= ON_SCREEN}
              url={cardUrl(origin, id, key)}
              number={i + 1}
              total={total}
              promo={promo}
            />
          ))}
      </section>
    </Frame>
  );
}

/** One card on the sheet: its QR code (with its key), what is free, the condition, the shop. */
function PrintedCard({ url, number, total, promo, hidden }: { url: string; number: number; total: number; promo: Promo; hidden: boolean }) {
  const condition = promo.condition ?? "it happens";
  // A game has an end to wait for. A test market has a result.
  const after = promo.subject ? "the game" : "the result";
  return (
    <div
      className={`${hidden ? "hidden print:flex" : "flex"} printed-card items-center gap-4 rounded-[10px] border border-dashed border-ink/30 bg-white p-4 text-black print:rounded-none`}
    >
      <QRCodeSVG value={url} size={116} marginSize={0} level="M" className="shrink-0" />
      <div className="min-w-0 space-y-0.5">
        <p className="label truncate !text-black/70">{promo.business?.trim() || "Your place"}</p>
        <p className="text-[20px] font-semibold leading-6">{promo.item?.trim() || "Your purchase"}</p>
        <p className="text-[12px] font-semibold uppercase leading-4 tracking-[0.06em]">Free if {condition}</p>
        <p className="pt-1 text-[13px] leading-4">
          Worth <span className="num">{usd(promo.payoutPerClaim)}</span> if {condition}.
        </p>
        <p className="text-[13px] leading-4">Scan after {after} to collect.</p>
        <p className="num pt-1 text-[10px] text-black/50">
          Card {number} of {total}
        </p>
      </div>
    </div>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <Frame>
      <div className="rounded-[10px] border border-line bg-card p-5 text-[16px]">{children}</div>
    </Frame>
  );
}

function Frame({ children, wide = false }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <>
      <main className={`mx-auto w-full flex-1 px-4 pt-6 print:max-w-none print:p-0 ${wide ? "max-w-[760px]" : "max-w-[440px]"}`}>{children}</main>
      <SiteFooter />
    </>
  );
}

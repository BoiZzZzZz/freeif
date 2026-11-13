"use client";

// /promo/[id] (prep/WIREFRAMES.md section 9): the merchant's dashboard on game night, the public status
// page, and the proof page. One page; the counter kit shows only to the promo's merchant.
import Link from "next/link";
import { QRCodeCanvas, QRCodeSVG } from "qrcode.react";
import { useRef, useState, useSyncExternalStore } from "react";
import { SiteFooter, useMechanics } from "@/components/mechanics";
import { OddsChart } from "@/components/odds-chart";
import { RuleText } from "@/components/rule-text";
import { Button } from "@/components/ui/button";
import { explorerAddress, explorerTx, KEEPER_URL } from "@/lib/config";
import { dayTime, timeOf, usd } from "@/lib/format";
import type { Promo } from "@/lib/keeper";
import { KEYS, NO_PROMOS, useLocal, type MyPromo } from "@/lib/local";
import { feedLines, statusLine, takingCustomers, timeline, titleOf, type TimelineStep } from "@/lib/promo";
import { useNow } from "@/lib/use-now";
import { useOdds } from "@/lib/use-odds";
import { usePromo } from "@/lib/use-promo";
import { useWallet } from "@/lib/wallet";

const noop = () => () => {};
/** This site's address, for the QR and the link. Empty until the page is in a browser. */
const useOrigin = () =>
  useSyncExternalStore(
    noop,
    () => window.location.origin,
    () => "",
  );

/** "0.8 s": how long after its block the keeper had an event. */
const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

export function PromoView({ id }: { id: string }) {
  const wallet = useWallet();
  const mine = useLocal<MyPromo[]>(KEYS.promos, NO_PROMOS);
  const mechanics = useMechanics();
  const { promo, missing, unreachable, reconnecting } = usePromo(id);
  // The chance is read again while the promo has no result. Until the promo is known, nothing is polled.
  const odds = useOdds(id, promo?.status === "Open");
  const now = Math.floor(useNow(5000) / 1000);

  if (missing) {
    return (
      <Frame>
        <p className="rounded-[10px] border border-line bg-card p-5 text-[16px]">We couldn&apos;t find this promo.</p>
      </Frame>
    );
  }
  if (unreachable) {
    return (
      <Frame>
        <p className="rounded-[10px] border border-line bg-card p-5 text-[16px]" role="status">
          We can&apos;t reach FreeIf right now. This page keeps trying, and nothing about the promo changes meanwhile.
        </p>
      </Frame>
    );
  }
  if (!promo || now === 0) {
    return (
      <Frame>
        <div className="h-[220px] animate-pulse rounded-[10px] border border-line bg-card" aria-label="Loading" />
      </Frame>
    );
  }

  const created = mine.find((p) => p.id === id);
  const merchant = created !== undefined || wallet.session?.address.toLowerCase() === promo.merchant.toLowerCase();
  const status = statusLine(promo, now, merchant);
  // A cover pays the business itself: nobody is covered at the counter, so there is no code to scan.
  const cover = promo.hedgeMode;
  const taking = !cover && takingCustomers(promo, now) === "yes";
  const feed = feedLines(promo, merchant);
  const steps = timeline(promo, merchant);
  // How the newest event reached the keeper: the QuickNode Stream's delivery, or its own read of the chain.
  const transport = feed[0]?.via === "stream" ? "QuickNode Stream" : "RPC";
  const started = promo.events.some((e) => e.event === "PromoCreated");
  const condition = promo.condition ?? "it happens";
  const tone = status.tone === "go" ? "text-go" : status.tone === "grey" ? "text-ink/60" : "text-ink";

  return (
    <Frame>
      {merchant && (
        <Link href="/merchant" className="mb-4 inline-block text-[14px] underline underline-offset-2">
          ‹ Your promos
        </Link>
      )}

      <div className="flex items-center justify-between">
        <span className={`num flex items-center gap-1.5 text-[12px] font-medium tracking-[0.08em] ${tone}`}>
          {status.tone === "go" && <span className="size-2 rounded-full bg-go" />}
          {status.badge}
        </span>
        {reconnecting ? (
          // The page still reads the promo every few seconds; only the instant updates are down.
          <span className="num flex items-center gap-1.5 text-[12px] text-ink/60" role="status">
            <span className="size-2 rounded-full border border-ink/40" />
            Reconnecting
          </span>
        ) : (
          <span className="num flex items-center gap-1.5 text-[12px] text-ink/60">
            <span className="size-2 rounded-full bg-go" />
            {mechanics ? `Live · ${transport}` : "Live"}
          </span>
        )}
      </div>
      <h1 className="mt-2 text-[26px] font-semibold leading-tight tracking-tight">{titleOf(promo)}</h1>
      <p className="mt-1 text-[15px] text-ink/60">
        {promo.business ? `${promo.business} · ` : ""}
        {promo.game ?? promo.eventTitle ?? "Event"}
        {/* A game has a kickoff. A day's high has a date, which is already in its name. */}
        {!cover && promo.eventStartTime ? <span className="num"> · {dayTime(promo.eventStartTime)}</span> : null}
      </p>
      <p className="mt-4 text-[17px]">{status.sentence}</p>

      {cover ? (
        <dl className="mt-6 grid grid-cols-2 gap-3 border-y border-line py-4">
          <Number value={usd(promo.payoutPerClaim)} label={`${merchant ? "You get" : "Paid out"} if it happens`} />
          <Number value={usd(promo.premiumPaid)} label={merchant ? "You paid" : "The business paid"} />
        </dl>
      ) : (
        <dl className="mt-6 grid grid-cols-3 gap-3 border-y border-line py-4">
          <Number value={`${promo.claimCount} of ${promo.maxClaims}`} label="Customers covered" />
          <Number value={usd(promo.premiumPaid)} label={merchant ? "You paid" : "The shop paid"} />
          <Number value={usd(BigInt(promo.payoutPerClaim) * BigInt(promo.claimCount))} label={`Customers get if ${condition}`} />
        </dl>
      )}

      {merchant && taking && <CounterKit id={id} promo={promo} />}
      {steps && <Timeline steps={steps} />}
      {!merchant && taking && (
        <Link
          href={`/claim/${id}`}
          className="mt-6 flex h-12 items-center justify-center rounded-[10px] bg-ink px-5 font-medium text-white hover:bg-ink/85"
        >
          {promo.item ? `Bought ${promo.item.toLowerCase()}? Get covered` : "Get covered"}
        </Link>
      )}

      <section className="mt-8">
        <h2 className="label mb-2">What&apos;s happening</h2>
        <ul className="divide-y divide-line rounded-[10px] border border-line bg-card">
          {feed.map((line) => (
            <li key={line.id} className="fade-in flex items-baseline gap-4 px-4 py-2.5 text-[15px]">
              <span className="num w-[72px] shrink-0 text-[13px] text-ink/60">{timeOf(line.at)}</span>
              <span className="min-w-0 flex-1">
                {line.text}
                {mechanics && (
                  <span className="num block text-[12px] text-ink/60">
                    {line.via === "stream" ? "QuickNode Stream" : "RPC"}
                    {line.lagMs !== null && ` · ${seconds(line.lagMs)} after the block`}
                  </span>
                )}
              </span>
              {mechanics && (
                <a className="num shrink-0 text-[12px] underline underline-offset-2" href={explorerTx(line.hash)} target="_blank" rel="noreferrer">
                  Arc tx
                </a>
              )}
            </li>
          ))}
          {/* Until the promo's first event has reached the keeper, a second or two after Pay. */}
          {!started && (
            <li className="flex items-baseline gap-4 px-4 py-2.5 text-[15px]">
              <span className="num w-[72px] shrink-0 text-[13px] text-ink/60">{created ? timeOf(created.at) : ""}</span>
              <span className="min-w-0 flex-1">
                {cover ? "Cover" : "Promo"} started. {merchant ? "You" : cover ? "The business" : "The shop"} paid {usd(promo.premiumPaid)}.
              </span>
              {mechanics && created?.tx && (
                <a className="num shrink-0 text-[12px] underline underline-offset-2" href={explorerTx(created.tx)} target="_blank" rel="noreferrer">
                  Arc tx
                </a>
              )}
            </li>
          )}
        </ul>
      </section>

      <OddsChart promo={promo} odds={odds} merchant={merchant} mechanics={mechanics} />

      <Proof promo={promo} open={mechanics} />
    </Frame>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <>
      <main className="mx-auto w-full max-w-[640px] flex-1 px-4 pt-6">{children}</main>
      <SiteFooter />
    </>
  );
}

function Number({ value, label }: { value: string; label: string }) {
  return (
    <div>
      <dd className="num text-[20px] font-semibold leading-7">{value}</dd>
      <dt className="label mt-1">{label}</dt>
    </div>
  );
}

/** Once there is a result: the promo's three steps, each with the time it happened. */
function Timeline({ steps }: { steps: TimelineStep[] }) {
  return (
    <section className="mt-8">
      <h2 className="label mb-2">Timeline</h2>
      <ol className="rounded-[10px] border border-line bg-card px-4 py-3">
        {steps.map((step, i) => {
          const done = step.at !== null;
          return (
            <li key={step.label} className="relative flex items-baseline gap-3 pb-4 last:pb-0">
              {/* The line down to the next step. */}
              {i < steps.length - 1 && <span className="absolute bottom-0 left-[4.5px] top-[14px] w-px bg-line" aria-hidden />}
              <span
                className={`relative mt-[7px] size-2.5 shrink-0 self-start rounded-full ${done ? (step.paid ? "bg-go" : "bg-ink") : "border border-ink/40 bg-card"}`}
                aria-hidden
              />
              <span className={`min-w-0 flex-1 text-[15px] ${done ? "" : "text-ink/60"}`}>{step.label}</span>
              <span className="num shrink-0 text-[13px] text-ink/60">{done ? dayTime(step.at!) : "Not yet"}</span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/** The merchant's counter kit: the QR customers scan after they buy, to print, save or share. */
function CounterKit({ id, promo }: { id: string; promo: Promo }) {
  const origin = useOrigin();
  const canvas = useRef<HTMLCanvasElement>(null);
  const [copied, setCopied] = useState(false);
  const link = `${origin}/claim/${id}`;

  function save() {
    const url = canvas.current?.toDataURL("image/png");
    if (!url) return;
    const a = document.createElement("a");
    a.href = url;
    a.download = `freeif-promo-${id}.png`;
    a.click();
  }

  return (
    <section className="mt-8">
      <h2 className="label mb-2">At the counter</h2>
      <div className="flex flex-col gap-4 rounded-[10px] border border-line bg-card p-4 sm:flex-row">
        <div className="shrink-0 self-center rounded-[6px] bg-white p-2">
          {origin !== "" && <QRCodeSVG value={link} size={148} marginSize={0} />}
        </div>
        <div className="min-w-0 flex-1 space-y-3">
          <p className="text-[15px]">
            Customers scan this after they buy. Stops accepting at <span className="num">{timeOf(promo.claimDeadline)}</span>.
          </p>
          <div className="grid gap-2 sm:grid-cols-3">
            <Link
              href={`/promo/${id}/print`}
              target="_blank"
              className="flex h-10 items-center justify-center rounded-[10px] bg-ink px-3 text-[14px] font-medium text-white hover:bg-ink/85"
            >
              Print counter sign
            </Link>
            <Button variant="secondary" className="!h-10 text-[14px]" onClick={save}>
              Save QR
            </Button>
            <Button
              variant="secondary"
              className="!h-10 text-[14px]"
              onClick={() => {
                void navigator.clipboard.writeText(link).then(() => setCopied(true));
              }}
            >
              {copied ? "Copied" : "Copy link"}
            </Button>
          </div>
        </div>
      </div>
      {/* Drawn off screen at print size, for "Save QR". */}
      <div className="hidden">{origin !== "" && <QRCodeCanvas ref={canvas} value={link} size={1024} marginSize={4} />}</div>
    </section>
  );
}

/** Proof (section 11): closed for a merchant, open in the mechanics view. Readable in under a minute. */
function Proof({ promo, open }: { promo: Promo; open: boolean }) {
  const settle = promo.events.findLast((e) => e.event === "Settled");
  // One line for each transaction, with the events it emitted: three payouts in one are "Paid ×3".
  const txs: { hash: string; names: string[] }[] = [];
  for (const e of promo.events) {
    const last = txs.at(-1);
    if (last?.hash === e.hash) last.names.push(e.event);
    else txs.push({ hash: e.hash, names: [e.event] });
  }
  const byStream = promo.events.filter((e) => e.via === "stream").length;
  const lastDelivery = promo.stream.lastDeliveryAt;
  const eventUrl = promo.eventTicker ? `https://api.gemini.com/v1/prediction-markets/events/${promo.eventTicker}` : null;
  return (
    <details className="mt-8 rounded-[10px] border border-line bg-card" open={open}>
      <summary className="cursor-pointer px-4 py-3 text-[15px] font-medium">Proof</summary>
      <dl className="space-y-4 border-t border-line px-4 py-4 text-[14px]">
        <ProofRow label="The rule">
          {promo.rule ? <RuleText text={promo.rule} /> : "Gemini's rule for this result is on the event."}
          {eventUrl && (
            <>
              {" "}
              <a className="underline underline-offset-2" href={eventUrl} target="_blank" rel="noreferrer">
                Gemini event
              </a>
            </>
          )}
        </ProofRow>
        <ProofRow label="The result">
          {promo.settledAt > 0
            ? `Gemini settled this result "${promo.outcomeYes ? "yes" : "no"}". Posted to Arc ${dayTime(promo.settledAt)}.`
            : promo.hedgeMode
              ? "Not in yet. The keeper posts Gemini's result once Gemini has it."
              : "Not in yet. The keeper posts Gemini's result once the promo stops taking customers."}
          {settle && (
            <>
              {" "}
              <a className="underline underline-offset-2" href={explorerTx(settle.hash)} target="_blank" rel="noreferrer">
                Settlement on Arc
              </a>
            </>
          )}
        </ProofRow>
        <ProofRow label="The money">
          {usd(promo.collateralLocked)} is locked in the vault for this promo.{" "}
          <a className="underline underline-offset-2" href={explorerAddress(promo.merchant)} target="_blank" rel="noreferrer">
            Merchant account
          </a>
          {" · "}
          <a className="underline underline-offset-2" href={`${KEEPER_URL}/promos/${promo.promoId}`} target="_blank" rel="noreferrer">
            Promo {promo.promoId} as the chain has it
          </a>
          {txs.length > 0 && (
            <span className="num mt-2 block space-y-1 text-[12px]">
              {txs.map((t) => (
                <a key={t.hash} className="block truncate underline underline-offset-2" href={explorerTx(t.hash)} target="_blank" rel="noreferrer">
                  {eventNames(t.names)} · {t.hash}
                </a>
              ))}
            </span>
          )}
        </ProofRow>
        {/* The hedge is mechanics: it shows only in the mechanics view. */}
        {open && promo.hedge && (
          <ProofRow label="The hedge">
            {promo.hedge.kind === "sandbox"
              ? `The keeper placed order ${promo.hedge.orderId} on Gemini's sandbox exchange: buy ${promo.hedge.quantity} "yes" of ${promo.hedge.symbol} at ${promo.hedge.price} or better (${promo.hedge.status ?? "open"}). One contract pays $1 on a "yes", so these pay what the vault would owe. It is a sandbox order: it shows the trade and moves no money.`
              : `Simulated: on Gemini the keeper would buy ${promo.hedge.quantity} "yes" of ${promo.hedge.symbol} at ${promo.hedge.price} or better, one contract for every dollar this promo can pay. ${promo.hedge.reason ?? ""}`}
          </ProofRow>
        )}
        <ProofRow label="The feed">
          {byStream > 0
            ? byStream === promo.events.length
              ? `Delivered by QuickNode Streams: all ${byStream} of this promo's events came from a Stream on Arc Testnet that watches the vault's logs and posts them to the keeper.`
              : `Delivered by QuickNode Streams: ${byStream} of this promo's ${promo.events.length} events came from a Stream on Arc Testnet that watches the vault's logs and posts them to the keeper. The keeper read the rest from the chain.`
            :"RPC fallback: the keeper read this promo's events from the chain. A QuickNode Stream on Arc Testnet posts the vault's events to the keeper as they happen; none of this promo's came that way."}
          {lastDelivery !== null && ` Last Stream delivery ${dayTime(lastDelivery)}.`}{" "}
          <a className="underline underline-offset-2" href={`${KEEPER_URL}/feed`} target="_blank" rel="noreferrer">
            The feed as the keeper has it
          </a>
        </ProofRow>
        <p className="num break-words text-[12px] text-ink/60">
          Event: {promo.eventTicker ?? "?"} Contract: {promo.contractLabel ?? "?"} Instrument: {promo.instrumentSymbol ?? "?"}
        </p>
      </dl>
    </details>
  );
}

/** The events of one transaction: "Paid ×3" for three of a kind, "PromoCreated + ClaimRegistered" for two kinds. */
function eventNames(names: string[]): string {
  const kinds = [...new Set(names)];
  return kinds.map((kind) => {
    const n = names.filter((name) => name === kind).length;
    return n > 1 ? `${kind} ×${n}` : kind;
  }).join(" + ");
}

function ProofRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="label mb-1">{label}</dt>
      <dd className="break-words">{children}</dd>
    </div>
  );
}

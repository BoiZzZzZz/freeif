"use client";

// /promo/[id]/print (prep/WIREFRAMES.md section 9.5): the letter-size counter sign, kept at the
// register. Not a window poster: a QR in the window would let people claim without buying. A card promo's
// sign is an ad instead: its QR opens the promo's public page, which has nothing to claim, and customers
// ask for a card when they buy.
import { QRCodeSVG } from "qrcode.react";
import { useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { timeOf, usd } from "@/lib/format";
import { usePromo } from "@/lib/use-promo";

const noop = () => () => {};

export function PrintView({ id }: { id: string }) {
  const { promo, missing, unreachable } = usePromo(id);
  const origin = useSyncExternalStore(
    noop,
    () => window.location.origin,
    () => "",
  );

  if (missing) return <p className="p-8 text-[16px]">We couldn&apos;t find this promo.</p>;
  if (unreachable) return <p className="p-8 text-[16px]">We can&apos;t reach FreeIf right now. This page keeps trying.</p>;
  if (!promo || origin === "") return null;

  const item = promo.item ?? "Your purchase";
  const plural = /[^s]s$/i.test(item);
  const condition = promo.condition ?? "it happens";
  if (promo.cards) {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-[720px] flex-col items-center bg-white px-8 py-12 text-center text-black">
        <div className="no-print mb-8 w-full max-w-[280px]">
          <Button onClick={() => window.print()}>Print this sign</Button>
        </div>
        <p className="num text-[20px] uppercase tracking-[0.2em]">{promo.business ?? "Tonight only"}</p>
        <h1 className="mt-10 text-[64px] font-semibold uppercase leading-[1.05] tracking-tight">
          Free if {condition}
        </h1>
        <p className="mt-6 text-[32px] font-semibold">Ask for your card</p>
        <div className="my-12">
          <QRCodeSVG value={`${origin}/promo/${id}`} size={240} marginSize={0} />
        </div>
        <div className="space-y-2 text-[24px] leading-snug">
          <p>
            Buy {item.toLowerCase()} and get a card. If {condition}, your card is worth{" "}
            <span className="num">{usd(promo.payoutPerClaim)}</span>.
          </p>
          <p>Scan your card after the game to collect.</p>
          <p>
            {promo.maxClaims} card{promo.maxClaims === 1 ? "" : "s"}. While they last.
          </p>
        </div>
        <p className="num mt-auto self-end pt-12 text-[16px]">{origin.replace(/^https?:\/\//, "")}</p>
      </main>
    );
  }
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-[720px] flex-col items-center bg-white px-8 py-12 text-center text-black">
      <div className="no-print mb-8 w-full max-w-[280px]">
        <Button onClick={() => window.print()}>Print this sign</Button>
      </div>
      <p className="num text-[20px] uppercase tracking-[0.2em]">{promo.business ?? "Tonight only"}</p>
      <h1 className="mt-10 text-[64px] font-semibold uppercase leading-[1.05] tracking-tight">
        {item} {plural ? "are" : "is"} free
        <br />
        if {condition}
      </h1>
      <div className="my-12">
        <QRCodeSVG value={`${origin}/claim/${id}`} size={300} marginSize={0} />
      </div>
      <div className="space-y-2 text-[24px] leading-snug">
        <p>
          Buy {item.toLowerCase()} tonight. Scan before <span className="num">{timeOf(promo.claimDeadline)}</span>.
        </p>
        <p>
          If {condition}, you get your <span className="num">{usd(promo.payoutPerClaim)}</span> back.
        </p>
        <p>
          First {promo.maxClaims} customer{promo.maxClaims === 1 ? "" : "s"}. One per customer.
        </p>
      </div>
      <p className="num mt-auto self-end pt-12 text-[16px]">{origin.replace(/^https?:\/\//, "")}</p>
    </main>
  );
}

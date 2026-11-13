"use client";

// /promo/[id]/print (prep/WIREFRAMES.md section 9.5): the letter-size counter sign, kept at the
// register. Not a window poster: a QR in the window would let people claim without buying.
import { QRCodeSVG } from "qrcode.react";
import { useSyncExternalStore } from "react";
import { usePromo } from "@/components/promo-view";
import { Button } from "@/components/ui/button";
import { timeOf, usd } from "@/lib/format";

const noop = () => () => {};

export function PrintView({ id }: { id: string }) {
  const { promo, missing } = usePromo(id);
  const origin = useSyncExternalStore(
    noop,
    () => window.location.origin,
    () => "",
  );

  if (missing) return <p className="p-8 text-[16px]">We couldn&apos;t find this promo.</p>;
  if (!promo || origin === "") return null;

  const item = promo.item ?? "Your purchase";
  const plural = /[^s]s$/i.test(item);
  const condition = promo.condition ?? "it happens";
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

// A printed voucher: what a customer is handed on the night. The bar honors it itself; its code opens
// `/voucher`, which reads the game's result from the exchange, so the customer and the bartender see the
// same answer. Eight to a letter page, like the claim cards.
import { QRCodeSVG } from "qrcode.react";
import { memo } from "react";
import { dateOf, usd } from "@/lib/format";
import { voucherUrl, type Voucher } from "@/lib/plan";

export type VoucherWords = {
  business: string;
  item: string;
  /** What one is worth, in base units. */
  value: bigint | null;
  /** "Knicks". */
  team: string;
  /** "Heat at Knicks". */
  game: string;
  startTime: number;
  /** The last moment a winning voucher is good, unix seconds; 0 for the night of the game only. */
  until: number;
};

/** What a winner does with it: come back by a day, or show it the same night. */
export const redeemLine = (team: string, until: number): string =>
  until > 0 ? `If the ${team} win, bring this back by ${dateOf(until)}.` : `If the ${team} win, show this before you leave.`;

type SlipProps = VoucherWords & { url: string; number: number; total: number; hidden?: boolean };

export function VoucherSlip({ url, business, item, value, team, game, startTime, until, number, total, hidden = false }: SlipProps) {
  return (
    <div
      className={`${hidden ? "hidden print:flex" : "flex"} printed-card items-center gap-4 rounded-[10px] border border-dashed border-ink/30 bg-white p-4 text-black print:rounded-none`}
    >
      {url ? <QRCodeSVG value={url} size={112} marginSize={0} level="L" className="shrink-0" /> : <span className="size-[112px] shrink-0 rounded bg-line" />}
      <div className="min-w-0 space-y-0.5">
        <p className="label truncate !text-black/70">{business.trim() || "Your place"}</p>
        <p className="truncate text-[20px] font-semibold leading-6">{item.trim() || "Your item"}</p>
        <p className="text-[12px] font-semibold uppercase leading-4 tracking-[0.06em]">Free if the {team} win</p>
        <p className="pt-1 text-[13px] leading-4">
          {game} · <span className="num">{dateOf(startTime)}</span>
        </p>
        <p className="text-[13px] leading-4">{redeemLine(team, until)}</p>
        <p className="num pt-1 text-[10px] text-black/50">
          No. {number} of {total}
          {value !== null && ` · worth ${usd(value)}`} · one per customer
        </p>
      </div>
    </div>
  );
}

type SheetProps = VoucherWords & { ticker: string; origin: string; total: number };

/** Every voucher of a night, for the printer only. */
export const VoucherSheet = memo(function VoucherSheet({ ticker, origin, total, ...words }: SheetProps) {
  if (origin === "" || total < 1) return null;
  const base: Omit<Voucher, "number"> = { ticker, item: words.item.trim(), business: words.business.trim(), of: total, until: words.until };
  return (
    <section className="hidden print:grid print:grid-cols-2">
      {Array.from({ length: total }, (_, i) => (
        <VoucherSlip key={i} {...words} url={voucherUrl(origin, { ...base, number: i + 1 })} number={i + 1} total={total} />
      ))}
    </section>
  );
});

import Link from "next/link";
import { SiteFooter } from "@/components/mechanics";
import { ReceiptCard } from "@/components/receipt-card";

const STEPS = [
  ["Pick a game and a team", "Tonight's games, each team with its chance of winning."],
  ["Say what's free", "Wings, dessert, a drink. Set how many customers, and see your one fixed cost."],
  ["Put the code on the counter", "Customers scan after they buy. If the team wins, they are paid back automatically."],
];

export default function Home() {
  return (
    <>
      <main className="mx-auto w-full max-w-[1000px] flex-1 px-4">
        <header className="flex h-14 items-center">
          <span className="text-[18px] font-semibold tracking-tight">FreeIf</span>
        </header>

        <div className="grid gap-10 py-8 md:grid-cols-[minmax(0,1fr)_380px] md:items-center md:py-16">
          <div>
            <h1 className="text-[40px] font-semibold leading-[1.05] tracking-tight md:text-[52px]">
              &ldquo;Free if they win.&rdquo;
              <br />
              For any shop, tonight.
            </h1>
            <p className="mt-5 max-w-[520px] text-[18px] text-ink/60">
              Your customers get it free if the team wins. You pay one fixed cost today, and nothing more, win or lose.
            </p>
            <Link
              href="/merchant"
              className="mt-8 inline-flex h-12 items-center justify-center rounded-[10px] bg-ink px-6 font-medium text-white hover:bg-ink/85"
            >
              Run a promo
            </Link>
          </div>
          <ReceiptCard
            state="covered"
            business="Tony's Pizza"
            item="Wings"
            amount={8_000_000n}
            condition="the Lions win"
            subject="the Lions"
            game="Lions at Bears"
            customerNumber={7}
            maxClaims={12}
          />
        </div>

        <ol className="grid gap-6 border-t border-line py-10 md:grid-cols-3">
          {STEPS.map(([title, text], i) => (
            <li key={title}>
              <span className="label">{i + 1}</span>
              <h2 className="mt-2 text-[18px] font-semibold">{title}</h2>
              <p className="mt-1 text-[15px] text-ink/60">{text}</p>
            </li>
          ))}
        </ol>
      </main>
      <SiteFooter />
    </>
  );
}

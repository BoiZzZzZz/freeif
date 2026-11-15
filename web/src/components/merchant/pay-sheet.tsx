"use client";

// Pay (prep/WIREFRAMES.md section 7.3): one sheet that walks the steps and skips any already done.
// Email and code, the shop's name (first time), a balance check, the price held for 90 seconds, then
// the payment itself.
//
// The payment is one transaction from the merchant's account: the account signs a USDC permit for
// exactly the cost, and `createPromoWithPermit` spends it. No standing approval is left behind. In
// Circle's window that is two screens: confirm, then pay.
//
// A new account holds nothing. When the keeper gives starter test dollars (its `/health` says so), the
// balance step offers them first, once per email, and moves on to Pay by itself once they arrive.
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { EmailStep } from "@/components/email-step";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet } from "@/components/ui/sheet";
import { usdcBalance } from "@/lib/balance";
import { FEE_BUFFER } from "@/lib/config";
import { pct, usd } from "@/lib/format";
import { keeper, KeeperError, type PriceRequest, type Quoted, type StarterInfo } from "@/lib/keeper";
import { KEYS, NO_PROMOS, NO_STARTER, readLocal, saveLocal, useLocal, type MyPromo } from "@/lib/local";
import { coverTitle } from "@/lib/promo";
import { useWallet, WalletError, type Words } from "@/lib/wallet";

/** What the merchant asked for when they tapped Pay. Fixed for the life of the sheet. */
export type Order = {
  request: PriceRequest;
  /** What is free: "Wings". */
  item: string;
  /** "Wings are free if the Lions win", for Circle's payment screen. */
  title: string;
  /**
   * Set when the business itself gets paid (a cover): what has to happen. The headline is then made here,
   * "$250.00 to Tony's Pizza if ...", because the business's name may only be given inside this sheet.
   */
  cover?: { condition: string };
  /** The cost and the chance the form was showing, to tell the merchant if either has moved. */
  shownCost: string;
  shownChance: number;
};

type Phase =
  | { name: "checking"; note?: string }
  | { name: "short"; balance: bigint; cost: bigint }
  | { name: "confirm"; quoted: Quoted; note?: string; /** How long the price is still held. */ seconds: number }
  | { name: "paying"; line: string }
  | { name: "error"; message: string };

type TxState = { state: "pending" | "done" | "failed"; promoId?: string; txHash?: string; message?: string };

const NOT_CHARGED = "The payment didn't go through. You were not charged.";
const EXPIRED = "That price expired. Here is the current one.";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// The keeper's answers when the login is no good: the email step comes back, as on the claim page.
const LOGIN_AGAIN = new Set(["login", "not-your-wallet"]);
const DOLLAR = 1_000_000n;

/** The keeper's starter test dollars: undefined while it is being asked, null when it gives none (or is too old to). */
type Starter = StarterInfo | null | undefined;

/**
 * Our words on Circle's two screens. What cannot be changed: the signing screen keeps the lead-in
 * "You are signing:", so the sentence is written to follow it, and the payment screen shows a
 * shortened address under "To" and cuts a long "From" value in the middle.
 */
function words(cost: string, title: string, cover: boolean): Words {
  const thing = cover ? "cover" : "promotion";
  return {
    common: { sign: "Continue", confirm: "Pay" },
    signatureRequest: {
      title: `Confirm your ${thing}`,
      contractName: "FreeIf",
      contractUrl: "https://freeif.app",
      description: `Step 1 of 2. A payment of ${cost} from your FreeIf balance for this ${thing}. Nothing else is charged.`,
    },
    contractInteraction: {
      title: `Start your ${thing}`,
      subtitle: title,
      mainCurrency: { amount: cost.replace("$", ""), symbol: "USD" },
      fromLabel: "From",
      from: "Balance",
      contractAddressLabel: "To",
      contractInfo: ["FreeIf"],
      networkFeeLabel: "Processing fee",
      networkFeeTip: "About one cent",
      totalLabel: "Total",
      total: [cost],
      dataDetails: { dataDetailsLabel: "Details", callData: { callDataLabel: "Reference", data: cover ? "Cover payment" : "Promotion payment" } },
    },
  };
}

export function PaySheet({ order, onClose }: { order: Order; onClose: () => void }) {
  const wallet = useWallet();
  const router = useRouter();
  const session = wallet.session;
  const business = useLocal<string>(KEYS.business, "");
  const [phase, setPhase] = useState<Phase>({ name: "checking" });
  const address = session?.address ?? null;
  const ready = address !== null && business !== "";
  const cover = order.cover !== undefined;
  const title = order.cover ? coverTitle(order.request.payoutPerClaim, business, order.cover.condition) : order.title;
  const thing = cover ? "cover" : "promo";
  const [starter, setStarter] = useState<Starter>(undefined);

  // Whether the keeper gives starter test dollars, asked once per sheet so the answer is there by the time
  // a balance turns out short. A keeper that is slow, unreachable or older than them gives none.
  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 8000);
    keeper
      .health(controller.signal)
      .then(
        (health) => setStarter(health.starter ?? null),
        () => setStarter(null),
      )
      .finally(() => window.clearTimeout(timer));
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, []);

  /** The balance, then a fresh signed price. Ends in "short", "confirm" or "error". */
  const prepare = useCallback(
    async (note?: string) => {
      if (!address) return;
      try {
        const balance = await usdcBalance(address);
        const shown = BigInt(order.shownCost);
        if (balance < shown + FEE_BUFFER) {
          setPhase({ name: "short", balance, cost: shown });
          return;
        }
        const quoted = await keeper.quote({ ...order.request, merchant: address, item: order.item, business, hedgeMode: cover });
        const cost = BigInt(quoted.quote.premium);
        if (balance < cost + FEE_BUFFER) setPhase({ name: "short", balance, cost });
        else {
          const seconds = Math.max(quoted.quote.expiry - Math.floor(Date.now() / 1000), 1);
          setPhase({ name: "confirm", quoted, note, seconds });
        }
      } catch (err) {
        const message =
          err instanceof KeeperError && err.status === 422 ? err.message : "We can't get a live price right now. Try again in a moment.";
        setPhase({ name: "error", message });
      }
    },
    [address, business, order, cover],
  );

  // Once the merchant is logged in and the shop has a name, the sheet moves on by itself.
  // Started on a timer so that a sheet which is opened and closed at once asks for no price: a signed
  // price holds room in the vault for 90 seconds.
  useEffect(() => {
    if (!ready) return;
    const timer = window.setTimeout(() => void prepare(), 0);
    return () => window.clearTimeout(timer);
  }, [ready, prepare]);

  // A held price that runs out is replaced, with a line saying so.
  const held = phase.name === "confirm" ? phase.quoted.quote : null;
  useEffect(() => {
    if (!held) return;
    const left = held.expiry * 1000 - Date.now() - 4000;
    const timer = window.setTimeout(() => {
      setPhase({ name: "checking", note: EXPIRED });
      void prepare(EXPIRED);
    }, Math.max(left, 0));
    return () => window.clearTimeout(timer);
  }, [held, prepare]);

  function again(note?: string) {
    setPhase({ name: "checking", note });
    void prepare(note);
  }

  async function pay(quoted: Quoted) {
    const cost = usd(quoted.quote.premium);
    const screens = words(cost, title, cover);
    setPhase({ name: "paying", line: "Paying" });
    try {
      const permit = await wallet.call<{ challengeId: string; deadline: number }>("permit", { value: quoted.quote.premium });
      const permitSignature = await wallet.confirm(permit.challengeId, screens);
      if (!permitSignature) throw new WalletError("failed", NOT_CHARGED);

      const send = await wallet.call<{ challengeId: string }>("create-promo", {
        quote: quoted.quote,
        signature: quoted.signature,
        permitSignature,
        permitDeadline: permit.deadline,
      });
      await wallet.confirm(send.challengeId, screens);

      setPhase({ name: "paying", line: `Starting your ${thing}` });
      for (let i = 0; i < 60; i++) {
        const tx = await wallet.call<TxState>("tx", { challengeId: send.challengeId });
        if (tx.state === "failed") throw new WalletError("failed", tx.message ?? NOT_CHARGED);
        if (tx.state === "done" && tx.promoId) {
          const mine: MyPromo = { id: tx.promoId, tx: tx.txHash ?? "", at: Math.floor(Date.now() / 1000) };
          saveLocal(KEYS.promos, [mine, ...readLocal<MyPromo[]>(KEYS.promos, NO_PROMOS)].slice(0, 50));
          setPhase({ name: "paying", line: cover ? "You're covered" : "Promo is live" });
          // A promo sold with claim cards goes on to its cards; the keeper says which kind it is.
          const next = await keeper.promo(tx.promoId).then(
            (p) => (p.cards ? `/promo/${tx.promoId}/cards` : `/promo/${tx.promoId}`),
            () => `/promo/${tx.promoId}`,
          );
          router.push(next);
          return;
        }
        await sleep(1500);
      }
      // Not "you were not charged": the payment was sent and may still land.
      setPhase({
        name: "error",
        message: "This is taking longer than usual. Wait a minute and reload this page before you pay again.",
      });
    } catch (err) {
      const code = err instanceof WalletError ? err.code : "failed";
      // Closing Circle's window is a change of mind, not a failure: back to the price.
      if (code === "cancelled") again();
      else if (code === "expired") again(EXPIRED);
      // The hour ran out: the email step is showing again, and the sheet picks up after it.
      else if (code === "login") setPhase({ name: "checking" });
      else setPhase({ name: "error", message: err instanceof WalletError && err.message ? err.message : NOT_CHARGED });
    }
  }

  const busy = phase.name === "paying";
  return (
    <Sheet open onClose={busy ? () => undefined : onClose} title={busy ? `Starting your ${thing}` : `Pay and start the ${thing}`}>
      {!session ? (
        <div className="space-y-3">
          <p className="text-[15px]">Enter your email. We&apos;ll send a 6-digit code.</p>
          <EmailStep cta="Continue" hint="No password. Your promos are kept under this email." onDone={() => undefined} />
        </div>
      ) : business === "" ? (
        <BusinessStep cover={cover} />
      ) : (
        <Steps
          phase={phase}
          order={order}
          title={title}
          address={session.address}
          starter={starter}
          onPay={pay}
          onAgain={() => again()}
          onClose={onClose}
        />
      )}
    </Sheet>
  );
}

function BusinessStep({ cover }: { cover: boolean }) {
  const [name, setName] = useState("");
  function submit(event: FormEvent) {
    event.preventDefault();
    if (name.trim() !== "") saveLocal(KEYS.business, name.trim().slice(0, 40));
  }
  return (
    <form onSubmit={submit} className="space-y-3">
      <p className="text-[15px]">
        What&apos;s your place called? {cover ? "It goes on your cover." : "Your customers see this on their card."}
      </p>
      <Input autoFocus maxLength={40} placeholder="Tony's Pizza" aria-label="Your place's name" value={name} onChange={(e) => setName(e.target.value)} />
      <Button type="submit" disabled={name.trim() === ""}>
        Continue
      </Button>
    </form>
  );
}

type StepsProps = {
  phase: Phase;
  order: Order;
  /** The headline: what is free, or what the business gets. */
  title: string;
  address: string;
  starter: Starter;
  onPay: (quoted: Quoted) => void;
  onAgain: () => void;
  onClose: () => void;
};

function Steps({ phase, order, title, address, starter, onPay, onAgain, onClose }: StepsProps) {
  const cover = order.cover !== undefined;
  if (phase.name === "checking") {
    return (
      <div className="space-y-2">
        {phase.note && <p className="text-[15px]">{phase.note}</p>}
        <p className="text-[15px] text-ink/60">Checking the price…</p>
      </div>
    );
  }

  if (phase.name === "short") {
    return (
      <AddMoney balance={phase.balance} cost={phase.cost} address={address} order={order} starter={starter} onAgain={onAgain} onClose={onClose} />
    );
  }

  if (phase.name === "confirm") {
    const { quoted, note, seconds } = phase;
    const cost = usd(quoted.quote.premium);
    const moved = quoted.breakdown.cost !== order.shownCost;
    const chanceMoved = Math.round(quoted.breakdown.chance * 100) !== Math.round(order.shownChance * 100);
    return (
      <div className="space-y-4">
        {note && <p className="text-[15px]">{note}</p>}
        <p className="text-[17px] font-medium">{title}</p>
        {moved ? (
          <p className="text-[15px]">
            {chanceMoved
              ? `The chance changed from ${pct(order.shownChance)} to ${pct(quoted.breakdown.chance)}, so the cost is now ${cost}.`
              : `The price moved. The cost is now ${cost}.`}
          </p>
        ) : (
          <p className="text-[15px]">
            Pay <span className="num">{cost}</span>. Price held for 90 seconds.
          </p>
        )}
        {/* The bar runs down with the time the price is held for. */}
        <div className="h-1 overflow-hidden rounded-full bg-line">
          <div
            key={quoted.quote.nonce}
            className="h-full origin-left bg-ink"
            style={{ animation: `run-down ${seconds}s linear 1 both` }}
          />
        </div>
        <Button onClick={() => onPay(quoted)}>Pay {cost}</Button>
        {moved && (
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
        )}
        <p className="text-[14px] text-ink/60">
          This is all you pay, {cover ? "whatever happens" : "win or lose"}. You&apos;ll confirm it on the next two screens.
        </p>
      </div>
    );
  }

  if (phase.name === "paying") {
    return (
      <div className="flex items-center gap-3 py-4" role="status">
        <span className="size-4 animate-spin rounded-full border-2 border-line border-t-ink" />
        <span className="text-[16px]">{phase.line}</span>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p role="alert" className="text-[15px]">
        {phase.message}
      </p>
      <Button onClick={onAgain}>Try again</Button>
    </div>
  );
}

type AddMoneyProps = {
  balance: bigint;
  /** What this promo or cover costs. */
  cost: bigint;
  address: string;
  order: Order;
  starter: Starter;
  /** Reads the balance again, and moves on to Pay when it is enough. */
  onAgain: () => void;
  /** Closes the sheet, back to the form. */
  onClose: () => void;
};

/**
 * The balance is short. With starter test dollars on offer (and not had yet by this account), that comes
 * first; otherwise how to add money, and, once the starter dollars were had, what to change so it fits.
 */
function AddMoney({ balance, cost, address, order, starter, onAgain, onClose }: AddMoneyProps) {
  const wallet = useWallet();
  const had = useLocal<Record<string, true>>(KEYS.starter, NO_STARTER)[address.toLowerCase()] === true;
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [asking, setAsking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const cover = order.cover !== undefined;
  const thing = cover ? "cover" : "promo";
  const missing = cost + FEE_BUFFER - balance;

  async function getStarter() {
    const session = wallet.session;
    if (!session) return;
    const remember = () =>
      saveLocal(KEYS.starter, { ...readLocal<Record<string, true>>(KEYS.starter, NO_STARTER), [session.address.toLowerCase()]: true });
    setAsking(true);
    try {
      // The login token goes with it: the keeper asks Circle whose account this is, as for a claim.
      await keeper.starter(session.address, session.userToken);
      remember();
      onAgain();
    } catch (err) {
      setAsking(false);
      if (err instanceof KeeperError && LOGIN_AGAIN.has(err.code)) {
        // Forgotten, so the email step is there again; the sheet picks up after it.
        wallet.logout();
        return;
      }
      if (err instanceof KeeperError && err.code === "already") remember();
      setMessage(err instanceof KeeperError ? err.message : "Something went wrong. Try again in a moment.");
    }
  }

  // Asked once per sheet; it is almost always back before the balance is.
  if (starter === undefined) return <p className="text-[15px] text-ink/60">Checking the price…</p>;

  if (asking) {
    return (
      <div className="flex items-center gap-3 py-4" role="status">
        <span className="size-4 animate-spin rounded-full border-2 border-line border-t-ink" />
        <span className="text-[16px]">Getting your test dollars</span>
      </div>
    );
  }

  if (starter !== null && starter.left > 0 && !had && message === null && balance < BigInt(starter.amount)) {
    const amount = usd(starter.amount);
    return (
      <div className="space-y-4">
        <p className="text-[15px]">This demo runs on test dollars. You can get {amount} to try it, once per email.</p>
        <Button onClick={() => void getStarter()}>Get {amount} in test dollars</Button>
      </div>
    );
  }

  // Once the starter dollars were had and still fall short: what to change on the form so it fits. The
  // cost grows about in step with the size, so the balance's share of it is the size that fits.
  const spendable = balance > FEE_BUFFER ? balance - FEE_BUFFER : 0n;
  let advice: string | null = null;
  if (had && cost > 0n) {
    if (cover) {
      const fits = (spendable * BigInt(order.request.payoutPerClaim)) / cost;
      advice =
        fits >= DOLLAR
          ? `Your balance covers about ${usd(fits)}. Lower the amount and try again.`
          : "Your balance is too low for this amount. Lower it and try again.";
    } else {
      const fits = Number((spendable * BigInt(order.request.maxClaims)) / cost);
      advice =
        fits > 0
          ? `Your balance covers about ${fits} customer${fits === 1 ? "" : "s"}. Lower the number of customers to ${fits} and try again.`
          : "Your balance doesn't cover one customer. Lower the item's price, or pick the other team.";
    }
  }

  return (
    <div className="space-y-4">
      {message && (
        <p role="alert" className="text-[15px]">
          {message}
        </p>
      )}
      <p className="text-[15px]">
        Your balance is <span className="num">{usd(balance)}</span>. Add <span className="num">{usd(missing)}</span> to start this {thing}.
      </p>
      {advice && (
        <>
          <p className="text-[15px]">{advice}</p>
          <Button onClick={onClose}>{cover ? "Change the amount" : "Change the promo"}</Button>
        </>
      )}
      {!open ? (
        <Button variant={advice ? "secondary" : "primary"} onClick={() => setOpen(true)}>
          Add money
        </Button>
      ) : (
        <div className="space-y-3 rounded-[10px] border border-line bg-card p-4 text-[15px]">
          <p>Card payments are coming. For this demo, send test dollars to your account&apos;s address:</p>
          <p className="num break-all text-[13px]">{address}</p>
          <Button
            variant="secondary"
            onClick={() => {
              void navigator.clipboard.writeText(address).then(() => setCopied(true));
            }}
          >
            {copied ? "Copied" : "Copy address"}
          </Button>
        </div>
      )}
      <Button variant={open && !advice ? "primary" : "secondary"} onClick={onAgain}>
        Check again
      </Button>
    </div>
  );
}

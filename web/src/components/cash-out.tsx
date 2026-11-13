"use client";

// Cash out (prep/WIREFRAMES.md section 8): a sheet that sends the account's balance to an address the
// person types. It is the only place a customer can meet an address, and only if they ask. Paying out
// to a bank or a card is not built; this demo pays in test dollars.
import { useEffect, useState, type FormEvent } from "react";
import { EmailStep } from "@/components/email-step";
import { useMechanics } from "@/components/mechanics";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet } from "@/components/ui/sheet";
import { usdcBalance } from "@/lib/balance";
import { explorerTx, FEE_BUFFER } from "@/lib/config";
import { shortAddress, usd } from "@/lib/format";
import { useWallet, WalletError, type Words } from "@/lib/wallet";

type Props = {
  open: boolean;
  onClose: () => void;
  /** The account that holds the money: the one a customer was covered with, or a merchant's own. */
  address: string;
  /** Called after money has left, so the page can read the balance again. */
  onSent?: () => void;
};

type Phase =
  | { name: "form"; error?: string }
  | { name: "sending"; line: string }
  | { name: "sent"; amount: bigint; to: string; txHash?: string };

type TxState = { state: "pending" | "done" | "failed"; txHash?: string; message?: string };

const NOT_SENT = "That didn't go through. Nothing was sent.";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Our words on Circle's confirmation screen. The address it shows by itself is the dollar token's. */
function words(amount: string, to: string): Words {
  return {
    common: { confirm: "Send" },
    contractInteraction: {
      title: "Cash out",
      subtitle: `Send ${amount} to ${shortAddress(to)}`,
      mainCurrency: { amount: amount.replace("$", ""), symbol: "USD" },
      fromLabel: "From",
      from: "Balance",
      contractAddressLabel: "Sent as",
      contractInfo: ["Test dollars"],
      networkFeeLabel: "Processing fee",
      networkFeeTip: "About one cent",
      totalLabel: "Total",
      total: [amount],
      dataDetails: { dataDetailsLabel: "Details", callData: { callDataLabel: "To", data: to } },
    },
  };
}

export function CashOut({ open, onClose, address, onSent }: Props) {
  const wallet = useWallet();
  const mechanics = useMechanics();
  const session = wallet.session;
  const [balance, setBalance] = useState<bigint | null>(null);
  const [to, setTo] = useState("");
  const [phase, setPhase] = useState<Phase>({ name: "form" });
  // The login that holds this money. Another email is another account.
  const mine = session !== null && session.address.toLowerCase() === address.toLowerCase();
  const sent = phase.name === "sent" ? phase.amount : null;

  useEffect(() => {
    if (!open) return;
    let live = true;
    usdcBalance(address as `0x${string}`).then(
      (value) => live && setBalance(value),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [open, address, sent]);

  // A few cents stay behind: the account pays its own processing fee from the same balance.
  const sendable = balance !== null && balance > FEE_BUFFER ? balance - FEE_BUFFER : 0n;

  async function send(event: FormEvent) {
    event.preventDefault();
    const amount = sendable;
    if (amount === 0n) return;
    setPhase({ name: "sending", line: "Getting it ready" });
    try {
      const made = await wallet.call<{ challengeId: string; to: string }>("cash-out", { to: to.trim(), amount: amount.toString() });
      await wallet.confirm(made.challengeId, words(usd(amount), made.to));
      setPhase({ name: "sending", line: "Sending" });
      for (let i = 0; i < 40; i++) {
        const tx = await wallet.call<TxState>("tx", { challengeId: made.challengeId, kind: "transfer" });
        if (tx.state === "failed") throw new WalletError("failed", NOT_SENT);
        if (tx.state === "done") {
          setPhase({ name: "sent", amount, to: made.to, txHash: tx.txHash });
          onSent?.();
          return;
        }
        await sleep(1500);
      }
      // Not "nothing was sent": it was sent and may still land.
      setPhase({ name: "form", error: "This is taking longer than usual. Check your balance in a minute before you send again." });
    } catch (err) {
      const code = err instanceof WalletError ? err.code : "failed";
      // Closing Circle's window is a change of mind. A login that ran out puts the email step back.
      if (code === "cancelled" || code === "login") setPhase({ name: "form" });
      else setPhase({ name: "form", error: err instanceof WalletError && err.message ? err.message : NOT_SENT });
    }
  }

  const busy = phase.name === "sending";
  return (
    <Sheet open={open} onClose={busy ? () => undefined : onClose} title="Cash out">
      {phase.name === "sent" ? (
        <div className="space-y-3 text-[15px]">
          <p className="text-[17px] font-medium">
            Sent <span className="num">{usd(phase.amount)}</span>.
          </p>
          <p className="text-ink/60">
            It is on its way to <span className="num">{shortAddress(phase.to)}</span> and arrives within seconds.
          </p>
          {mechanics && phase.txHash && (
            <a className="num block text-[13px] underline underline-offset-2" href={explorerTx(phase.txHash)} target="_blank" rel="noreferrer">
              Arc tx
            </a>
          )}
          <Button variant="secondary" onClick={onClose}>
            Done
          </Button>
        </div>
      ) : busy ? (
        <div className="flex items-center gap-3 py-4" role="status">
          <span className="size-4 animate-spin rounded-full border-2 border-line border-t-ink" />
          <span className="text-[16px]">{phase.line}</span>
        </div>
      ) : !mine ? (
        <div className="space-y-3">
          <p className="text-[15px]">
            {session ? "This money is under another email. Log in with the email you used here." : "Enter the email you used here. We'll send a 6-digit code."}
          </p>
          {session ? (
            <Button variant="secondary" onClick={wallet.logout}>
              Use another email
            </Button>
          ) : (
            <EmailStep cta="Continue" hint="No password." onDone={() => undefined} />
          )}
        </div>
      ) : (
        <form onSubmit={send} className="space-y-3 text-[15px]">
          {sendable > 0n ? (
            <p>
              Send <span className="num">{usd(sendable)}</span> to an address.
            </p>
          ) : (
            <p>{balance === null ? "Checking your balance…" : "There is nothing to send right now."}</p>
          )}
          <Input
            className="num"
            placeholder="0x…"
            aria-label="The address to send to"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
          {phase.error && (
            <p role="alert" className="text-stop">
              {phase.error}
            </p>
          )}
          <Button type="submit" disabled={sendable === 0n || to.trim() === ""}>
            {sendable > 0n ? `Send ${usd(sendable)}` : "Send"}
          </Button>
          <p className="text-[14px] text-ink/60">
            A few cents stay in your account for the processing fee. Cash out to a bank or card is coming. This demo pays in test dollars.
          </p>
        </form>
      )}
    </Sheet>
  );
}

"use client";

// The login, the same for a merchant about to pay and a customer at the counter: an email, then a
// 6-digit code typed into Circle's window. No password, no app.
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useWallet, WalletError, type Session } from "@/lib/wallet";

type Props = {
  /** The button: "Get covered", "Continue". */
  cta: string;
  /** The small line under the button. */
  hint?: string;
  onDone: (session: Session) => void;
};

export function EmailStep({ cta, hint, onDone }: Props) {
  const wallet = useWallet();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      onDone(await wallet.login(email));
    } catch (err) {
      // Closing the code window is not an error: the form is simply there again.
      const cancelled = err instanceof WalletError && err.code === "cancelled";
      if (!cancelled) setError(err instanceof WalletError ? err.message : "Something went wrong. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <Input
        type="email"
        inputMode="email"
        autoComplete="email"
        placeholder="Email"
        aria-label="Email"
        required
        value={email}
        disabled={busy}
        onChange={(e) => setEmail(e.target.value)}
        onFocus={wallet.warm}
      />
      <Button type="submit" disabled={busy || email.trim() === ""}>
        {busy ? "Check your email for the code…" : cta}
      </Button>
      {error ? (
        <p role="alert" className="text-[14px] text-stop">
          {error}
        </p>
      ) : (
        hint && <p className="text-[14px] text-ink/60">{hint}</p>
      )}
    </form>
  );
}

"use client";

// How money gets into an account in this demo: test dollars sent to the account's address. The one place
// a merchant can meet an address, and only if they ask to add money.
import { useState } from "react";
import { Button } from "@/components/ui/button";

export function AddressBox({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);
  return (
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
  );
}

import type { Metadata } from "next";
import { LpView } from "@/components/lp-view";

export const metadata: Metadata = { title: "Vault · FreeIf" };

export default function LpPage() {
  return <LpView />;
}

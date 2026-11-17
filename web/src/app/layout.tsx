import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { MechanicsBar } from "@/components/mechanics";
import { WalletProvider } from "@/lib/wallet";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

const description = "Run a \"free if they win\" promo. Your customers get it free if the team wins. You pay one fixed cost today.";

// The link preview (Discord, iMessage, Slack, X) is the same on every page: the picture is
// `opengraph-image.png` and `twitter-image.png` beside this file, which Next adds by itself.
export const metadata: Metadata = {
  metadataBase: new URL("https://freeif.app"),
  title: "FreeIf",
  description,
  openGraph: { type: "website", siteName: "FreeIf", title: "FreeIf: free if the home team wins", description },
  twitter: { card: "summary_large_image", title: "FreeIf: free if the home team wins", description },
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#faf7f0" };

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col">
        <WalletProvider>
          <MechanicsBar />
          {children}
        </WalletProvider>
      </body>
    </html>
  );
}

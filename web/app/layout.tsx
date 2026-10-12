import type { Metadata } from "next";
import "./globals.css";
import Nav from "@/components/Nav";
import AccountStrip from "@/components/AccountStrip";

export const metadata: Metadata = {
  title: {
    // "/" is the live dashboard now; the research lives under /docs
    default: "NQ Scalping Dashboard",
    template: "%s · Scalping Playbook",
  },
  description:
    "Live NQ order-flow dashboard (profiles, footprint imbalances, reversal checklist) plus the research behind it: evidence, tool stack, strategies, checklist and sources.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="scroll-smooth">
      <body className="min-h-screen bg-zinc-950 text-zinc-200 antialiased">
        <Nav />
        <AccountStrip />
        <main className="w-full">
          {children}
        </main>
        <footer className="border-t border-zinc-800/80 py-8 text-center text-xs text-zinc-500">
          <p>
            Educational research only — not financial advice. Backtests cited are third-party; fee
            models vary by market.{" "}
            <a href="/docs" className="text-zinc-400 hover:text-zinc-200">
              Read the documentation
            </a>
            .
          </p>
        </footer>
      </body>
    </html>
  );
}

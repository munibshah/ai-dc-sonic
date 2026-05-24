import "./globals.css";
import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "AIDC Lab",
  description: "AI Data Center lab — fabric, telemetry, and collective ops",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <header className="border-b border-white/10 bg-[#0b1020]">
          <div className="mx-auto max-w-7xl px-4 py-3 flex items-center gap-6">
            <Link href="/" className="text-white font-semibold tracking-wide">
              AIDC Lab
            </Link>
            <nav className="text-sm text-white/70 flex gap-4">
              <Link href="/" className="hover:text-white">Devices</Link>
              <span className="text-white/30">|</span>
              <Link href="/topology" className="hover:text-white">Topology</Link>
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-7xl px-4 py-6">{children}</main>
      </body>
    </html>
  );
}

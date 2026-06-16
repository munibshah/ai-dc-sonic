import "./globals.css";
import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { ToastsProvider } from "@/components/Toast";
import ThemeToggle from "@/components/ThemeToggle";
import AccountControl from "@/components/AccountControl";

export const metadata: Metadata = {
  title: "AI DC Training Course",
  description: "AI Data Center lab — fabric, telemetry, and collective ops",
  icons: {
    icon: [
      { url: "/lion_16x16.png", sizes: "16x16", type: "image/png" },
      { url: "/lion-logo.png", sizes: "512x512", type: "image/png" },
    ],
    apple: "/lion-logo.png",
  },
};

// Runs synchronously in <head> before the body paints — reads the stored
// theme preference and stamps it onto <html data-theme=...> so the chrome
// renders in the correct palette on first frame instead of flashing dark
// then swapping to Vesper on hydration.
const NO_FLASH_THEME = `
(function(){
  try {
    var t = localStorage.getItem("aidc-theme");
    if (t === "vesper" || t === "default") {
      document.documentElement.setAttribute("data-theme", t);
    } else {
      document.documentElement.setAttribute("data-theme", "default");
    }
  } catch (e) {
    document.documentElement.setAttribute("data-theme", "default");
  }
})();
`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        <script dangerouslySetInnerHTML={{ __html: NO_FLASH_THEME }} />
      </head>
      <body>
        <ToastsProvider>
          <header className="border-b border-white/10 bg-[#0b1020] sticky top-0 z-40 backdrop-blur-sm">
            <div className="mx-auto max-w-7xl px-4 py-3 flex items-center gap-6">
              <Link
                href="/"
                className="flex items-center gap-2.5 text-white font-semibold tracking-wide group"
              >
                <Image
                  src="/lion-logo.png"
                  alt="AI DC Training Course"
                  width={36}
                  height={36}
                  priority
                  className="theme-logo-dark rounded-md ring-1 ring-purple-400/30 group-hover:ring-purple-400/60 transition"
                />
                <Image
                  src="/lion-transparent.png"
                  alt="AI DC Training Course"
                  width={36}
                  height={36}
                  className="theme-logo-light rounded-md ring-1 ring-purple-400/30 group-hover:ring-purple-400/60 transition"
                />
                <span className="leading-tight">
                  <span className="block text-sm font-semibold text-white">AI DC</span>
                  <span className="block text-[10px] uppercase tracking-[0.18em] text-[var(--accent-brand)]">
                    Training Course
                  </span>
                </span>
              </Link>
              <nav className="text-sm text-white/70 flex gap-5">
                <Link href="/" className="hover:text-white transition-colors">Labs</Link>
                <a href="/portal" className="hover:text-white transition-colors">Book a slot</a>
              </nav>
              <div className="ml-auto flex items-center gap-4">
                <AccountControl />
                <ThemeToggle />
              </div>
            </div>
          </header>
          {/* No max-width here — pages that want a constrained reading width
              (labs index, devices, topology) wrap their own content in an
              `mx-auto max-w-7xl` div. Pages that benefit from full width
              (workbench at /labs/[id], single-device console) omit it. */}
          <main className="px-4 py-6">{children}</main>
        </ToastsProvider>
      </body>
    </html>
  );
}

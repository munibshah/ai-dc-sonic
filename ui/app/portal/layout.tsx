import RequireAuth from "@/components/RequireAuth";

// Everything under /portal/* requires a signed-in session. RequireAuth redirects
// anonymous visitors to /login; the API layer enforces auth for real.
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <RequireAuth>{children}</RequireAuth>;
}

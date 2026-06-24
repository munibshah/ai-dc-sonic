"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { getMe, type Me } from "@/lib/auth";
import { adminBookings, BookingError, type AdminBookings } from "@/lib/booking";
import { ArrowLeft, Calendar, Lock } from "@/components/icons";

function fmt(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

type Phase =
  | { kind: "loading" }
  | { kind: "anon" }
  | { kind: "forbidden"; email: string }
  | { kind: "ready"; me: Me; data: AdminBookings }
  | { kind: "error"; detail: string };

export default function AdminBookingsPage() {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });

  useEffect(() => {
    let alive = true;
    (async () => {
      const me = await getMe();
      if (!alive) return;
      if (!me) return setPhase({ kind: "anon" });
      if (!me.is_admin) return setPhase({ kind: "forbidden", email: me.email });
      try {
        const data = await adminBookings();
        if (alive) setPhase({ kind: "ready", me, data });
      } catch (e) {
        const detail = e instanceof BookingError ? e.message : String(e);
        if (alive) setPhase({ kind: "error", detail });
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-5">
        <Link
          href="/portal"
          className="inline-flex items-center gap-1.5 text-sm text-white/55 hover:text-white transition-colors"
        >
          <ArrowLeft className="w-3.5 h-3.5" /> Back to your launcher
        </Link>
      </div>

      <div className="flex items-center gap-2 mb-1">
        <Lock className="w-4 h-4 text-[var(--accent-brand)]" />
        <span className="eyebrow">Instructor only</span>
      </div>
      <h1 className="text-2xl font-semibold text-white">Bookings</h1>

      {phase.kind === "loading" && <p className="text-white/60 mt-6 text-sm">Loading…</p>}

      {phase.kind === "anon" && (
        <Gate
          title="Sign in required"
          body="This page is restricted to the instructor account."
          cta={{ href: "/login?next=/portal/admin", label: "Sign in" }}
        />
      )}

      {phase.kind === "forbidden" && (
        <Gate
          title="Not authorized"
          body={`You're signed in as ${phase.email}, which isn't the instructor account. Only the instructor can view bookings.`}
        />
      )}

      {phase.kind === "error" && (
        <Gate title="Couldn't load bookings" body={phase.detail} />
      )}

      {phase.kind === "ready" && <Ledger data={phase.data} />}
    </div>
  );
}

function Gate({
  title,
  body,
  cta,
}: {
  title: string;
  body: string;
  cta?: { href: string; label: string };
}) {
  return (
    <div className="brand-hero rounded-2xl p-6 md:p-7 mt-6">
      <h2 className="text-lg font-semibold text-white">{title}</h2>
      <p className="text-sm text-white/70 mt-2 max-w-prose">{body}</p>
      {cta && (
        <Link href={cta.href} className="btn btn-primary mt-4 inline-flex">
          {cta.label}
        </Link>
      )}
    </div>
  );
}

function Ledger({ data }: { data: AdminBookings }) {
  const { summary, lab_bookings, training_signups } = data;
  const now = Date.now();

  return (
    <div className="mt-6 space-y-8">
      {/* Summary stats */}
      <div className="grid grid-cols-3 gap-3">
        <Stat label="Lab bookings" value={summary.lab_total} />
        <Stat label="Upcoming" value={summary.lab_upcoming} />
        <Stat label="Training signups" value={summary.training_signups} />
      </div>

      {/* Lab bookings */}
      <section>
        <div className="flex items-center gap-2 mb-3">
          <Calendar className="w-4 h-4 text-[var(--accent-brand)]" />
          <h2 className="text-base font-semibold text-white">Fabric reservations</h2>
        </div>
        {lab_bookings.length === 0 ? (
          <Empty>No lab bookings yet.</Empty>
        ) : (
          <Table head={["Learner", "Starts", "Ends", "Booked", ""]}>
            {lab_bookings.map((b) => {
              const upcoming = new Date(b.ends_at).getTime() > now;
              return (
                <tr key={b.id} className="border-t border-[var(--line)]">
                  <Td strong>{b.holder_email ?? "—"}</Td>
                  <Td>{fmt(b.starts_at)}</Td>
                  <Td>{fmt(b.ends_at)}</Td>
                  <Td muted>{fmt(b.created_at)}</Td>
                  <Td>
                    <span
                      className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-medium ${
                        upcoming
                          ? "bg-[var(--accent-brand-soft)] text-[var(--accent-brand)]"
                          : "bg-white/5 text-white/45"
                      }`}
                    >
                      {upcoming ? "Upcoming" : "Past"}
                    </span>
                  </Td>
                </tr>
              );
            })}
          </Table>
        )}
      </section>

      {/* Training roster */}
      <section>
        <div className="flex items-center gap-2 mb-3">
          <Calendar className="w-4 h-4 text-[var(--accent-brand)]" />
          <h2 className="text-base font-semibold text-white">Instructor-led training roster</h2>
        </div>
        {training_signups.length === 0 ? (
          <Empty>No training signups yet.</Empty>
        ) : (
          <Table head={["Learner", "Name", "Session", "Session date", "Signed up"]}>
            {training_signups.map((s) => (
              <tr key={s.id} className="border-t border-[var(--line)]">
                <Td strong>{s.email}</Td>
                <Td>{s.name ?? "—"}</Td>
                <Td>{s.session_title}</Td>
                <Td>{fmt(s.session_starts_at)}</Td>
                <Td muted>{fmt(s.created_at)}</Td>
              </tr>
            ))}
          </Table>
        )}
      </section>

      <p className="text-xs text-white/40">Generated {fmt(data.generated_at)} · times shown in your local zone.</p>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-[var(--line)] bg-black/20 p-4">
      <div className="text-2xl font-semibold text-white tabular-nums">{value}</div>
      <div className="text-xs text-white/55 mt-0.5">{label}</div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-[var(--line)] bg-black/20 p-5 text-sm text-white/55">
      {children}
    </div>
  );
}

function Table({ head, children }: { head: string[]; children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-[var(--line)]">
      <table className="w-full text-sm text-left">
        <thead>
          <tr className="text-[11px] uppercase tracking-wider text-white/40">
            {head.map((h, i) => (
              <th key={i} className="px-4 py-2.5 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function Td({
  children,
  strong,
  muted,
}: {
  children: React.ReactNode;
  strong?: boolean;
  muted?: boolean;
}) {
  return (
    <td
      className={`px-4 py-3 align-middle ${
        strong ? "text-white font-medium" : muted ? "text-white/45" : "text-white/70"
      } ${muted ? "tabular-nums" : ""}`}
    >
      {children}
    </td>
  );
}

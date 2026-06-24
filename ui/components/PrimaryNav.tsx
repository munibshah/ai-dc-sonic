"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { getMe, type Me } from "@/lib/auth";

/** Header nav. Signed-in learners get their app links; anonymous visitors get
 * none (the marketing CTAs live in the page body, sign-in via AccountControl).
 * The instructor additionally gets an Admin link to the bookings ledger. */
export default function PrimaryNav() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const pathname = usePathname();

  useEffect(() => {
    let alive = true;
    getMe().then((m) => alive && setMe(m));
    return () => {
      alive = false;
    };
  }, []);

  if (!me) return null;

  const link = (href: string, label: string) => (
    <Link
      href={href}
      className={`transition-colors ${pathname === href ? "text-white" : "text-white/70 hover:text-white"}`}
    >
      {label}
    </Link>
  );

  return (
    <nav className="text-sm flex gap-5">
      {link("/portal", "My labs")}
      {link("/portal/book", "Book")}
      {me.is_admin && link("/portal/admin", "Admin")}
    </nav>
  );
}

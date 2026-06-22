"use client";

import Link from "next/link";
import BookingPanel from "@/components/BookingPanel";
import { ArrowLeft } from "@/components/icons";

export default function BookPage() {
  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-5">
        <Link href="/portal" className="inline-flex items-center gap-1.5 text-sm text-white/55 hover:text-white transition-colors">
          <ArrowLeft className="w-3.5 h-3.5" /> Back to your launcher
        </Link>
      </div>
      <BookingPanel />
    </div>
  );
}

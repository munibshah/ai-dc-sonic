import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "@/components/icons";

export const metadata: Metadata = {
  title: "Terms of Service — AIDC Labs",
  description: "The terms that govern your use of the AIDC Labs training platform.",
};

const UPDATED = "June 17, 2026";

export default function TermsPage() {
  return (
    <article className="mx-auto max-w-3xl py-4">
      <Link
        href="/"
        className="inline-flex items-center gap-1.5 text-sm text-[var(--text-dim)] hover:text-[var(--text-strong)] transition-colors mb-6"
      >
        <ArrowLeft className="w-4 h-4" /> Back to labs
      </Link>

      <h1 className="text-3xl font-semibold text-[var(--text-strong)]">Terms of Service</h1>
      <p className="mt-2 text-sm text-[var(--text-dim)]">Last updated: {UPDATED}</p>

      <div className="mt-8 space-y-2 text-[var(--text-body)] leading-relaxed">
        <p>
          These Terms of Service (&ldquo;Terms&rdquo;) govern your access to and use of the AIDC Labs
          platform at <span className="font-mono text-[0.95em]">lab.munibshah.com</span> and its
          related labs, consoles, and booking features (the &ldquo;Service&rdquo;), operated by AIDC
          Labs (&ldquo;we&rdquo;, &ldquo;us&rdquo;). By creating an account or using the Service, you
          agree to these Terms. If you do not agree, do not use the Service.
        </p>
      </div>

      <Section title="1. The Service">
        AIDC Labs is an educational platform for learning AI data-center networking. It provides
        guided labs that boot virtual SONiC/FRR switches in a CLOS topology, in-browser consoles into
        those lab environments, and a system for booking lab time. The Service is provided for
        personal, non-commercial learning.
      </Section>

      <Section title="2. Eligibility &amp; accounts">
        You must be at least 16 years old to use the Service. You sign in with your email address via
        a one-time link; you are responsible for keeping access to that email secure and for all
        activity under your account. Provide accurate information and notify us promptly of any
        unauthorized use.
      </Section>

      <Section title="3. Beta &amp; free access">
        The Service is currently offered free of charge during a beta period. It is provided on an
        &ldquo;as available&rdquo; basis without any service-level guarantee, and features, labs, and
        availability may change, be interrupted, or be discontinued at any time. We may introduce paid
        plans in the future; anything you book during the beta remains free, and we will give notice
        before any charges apply.
      </Section>

      <Section title="4. Booking &amp; fair use">
        Lab capacity is shared among many learners. When you book a slot, the lab environment and its
        consoles are reserved for your sitting. Please use booked time reasonably, release slots you no
        longer need, and do not attempt to monopolize shared infrastructure, circumvent the booking
        gate, or access environments reserved for others.
      </Section>

      <Section title="5. Acceptable use">
        <p className="mb-2">The in-browser consoles connect to real, sandboxed network devices. You agree not to:</p>
        <ul className="list-disc pl-6 space-y-1">
          <li>use the Service or its lab infrastructure to attack, scan, or disrupt any system, network, or party outside your own lab environment;</li>
          <li>attempt to break out of the lab sandbox, access other users&rsquo; data or sessions, or interfere with the platform&rsquo;s operation or security;</li>
          <li>use the Service for any unlawful purpose or in violation of any applicable law or regulation;</li>
          <li>resell, redistribute, or commercially exploit the Service or its content without our written permission.</li>
        </ul>
      </Section>

      <Section title="6. Intellectual property">
        The Service, including its lab guides, content, software, and branding, is owned by AIDC Labs
        and its licensors and is protected by intellectual-property laws. We grant you a limited,
        non-exclusive, non-transferable license to access and use the content for your personal
        learning. All rights not expressly granted are reserved.
      </Section>

      <Section title="7. Disclaimers">
        The Service is provided &ldquo;as is&rdquo; and &ldquo;as available,&rdquo; for educational
        purposes only, without warranties of any kind, whether express or implied, including
        merchantability, fitness for a particular purpose, and non-infringement. We do not warrant that
        the Service will be uninterrupted, error-free, or secure. Lab environments are emulations and
        may differ from production hardware.
      </Section>

      <Section title="8. Limitation of liability">
        To the maximum extent permitted by law, AIDC Labs will not be liable for any indirect,
        incidental, special, consequential, or punitive damages, or any loss of data, arising out of or
        relating to your use of the Service. Because the Service is provided free of charge during the
        beta, our total liability for any claim relating to the Service is limited to the amount you
        paid us for it, if any.
      </Section>

      <Section title="9. Termination">
        You may stop using the Service and request deletion of your account at any time. We may suspend
        or terminate access if you violate these Terms or to protect the Service or other users.
        Provisions that by their nature should survive termination (such as intellectual property,
        disclaimers, and limitation of liability) will survive.
      </Section>

      <Section title="10. Changes to these Terms">
        We may update these Terms from time to time. When we do, we will revise the &ldquo;last
        updated&rdquo; date above, and material changes will be reflected on this page. Your continued
        use of the Service after changes take effect constitutes acceptance of the revised Terms.
      </Section>

      <Section title="11. Contact">
        Questions about these Terms? Reach us at{" "}
        <a className="text-[var(--accent-brand)] hover:underline" href="mailto:labs@munibshah.com">
          labs@munibshah.com
        </a>
        .
      </Section>

      <p className="mt-10 text-sm text-[var(--text-dim)]">
        See also our{" "}
        <Link className="text-[var(--accent-brand)] hover:underline" href="/privacy">
          Privacy Policy
        </Link>
        .
      </p>
    </article>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="text-lg font-semibold text-[var(--text-strong)] mb-2">{title}</h2>
      <div className="text-[var(--text-body)] leading-relaxed">{children}</div>
    </section>
  );
}

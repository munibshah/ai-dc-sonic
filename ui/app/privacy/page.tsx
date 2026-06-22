import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "@/components/icons";

export const metadata: Metadata = {
  title: "Privacy Policy — AIDC Labs",
  description: "How AIDC Labs collects, uses, and protects your information.",
};

const UPDATED = "June 17, 2026";

export default function PrivacyPage() {
  return (
    <article className="mx-auto max-w-3xl py-4">
      <Link
        href="/"
        className="inline-flex items-center gap-1.5 text-sm text-[var(--text-dim)] hover:text-[var(--text-strong)] transition-colors mb-6"
      >
        <ArrowLeft className="w-4 h-4" /> Back to labs
      </Link>

      <h1 className="text-3xl font-semibold text-[var(--text-strong)]">Privacy Policy</h1>
      <p className="mt-2 text-sm text-[var(--text-dim)]">Last updated: {UPDATED}</p>

      <div className="mt-8 text-[var(--text-body)] leading-relaxed">
        <p>
          This Privacy Policy explains how AIDC Labs (&ldquo;we&rdquo;, &ldquo;us&rdquo;) collects,
          uses, and protects your information when you use the platform at{" "}
          <span className="font-mono text-[0.95em]">lab.munibshah.com</span> (the
          &ldquo;Service&rdquo;). We keep the data we collect to the minimum needed to run a learning
          platform.
        </p>
      </div>

      <Section title="1. Information we collect">
        <ul className="list-disc pl-6 space-y-1">
          <li>
            <strong>Account email.</strong> When you sign in, we collect your email address to create
            your account and send one-time sign-in links.
          </li>
          <li>
            <strong>Booking details.</strong> The lab slots you reserve, including the times and
            related scheduling information.
          </li>
          <li>
            <strong>Lab progress.</strong> Which labs you have started, reset, or completed, so the
            Service can track your journey.
          </li>
          <li>
            <strong>Technical and usage data.</strong> Basic server and security logs such as IP
            address, browser/user-agent, and timestamps, generated automatically when you use the
            Service.
          </li>
        </ul>
        <p className="mt-2">
          We do not intentionally collect sensitive personal information, and we do not ask for payment
          details during the free beta.
        </p>
      </Section>

      <Section title="2. How we use your information">
        <ul className="list-disc pl-6 space-y-1">
          <li>to authenticate you and provide access to labs and consoles;</li>
          <li>to schedule, confirm, and manage your lab bookings (including sending booking and sign-in emails);</li>
          <li>to operate, maintain, secure, and improve the Service;</li>
          <li>to communicate with you about the Service, such as important changes or support requests;</li>
          <li>to comply with legal obligations and enforce our Terms.</li>
        </ul>
        <p className="mt-2">
          We do not sell your personal information, and we do not use it for third-party advertising.
        </p>
      </Section>

      <Section title="3. Cookies &amp; sessions">
        We use a session cookie to keep you signed in after you use a magic link. This cookie is
        necessary for the Service to function; without it we cannot maintain an authenticated session.
        We do not use advertising or cross-site tracking cookies.
      </Section>

      <Section title="4. Service providers">
        We rely on a small number of infrastructure providers to run the Service, including Cloudflare
        (hosting, network access, and security) and an email delivery provider used to send sign-in and
        booking messages. These providers process data on our behalf and only as needed to provide
        their services. We do not otherwise share your information except to comply with the law,
        enforce our Terms, or protect the rights, safety, and security of our users and the Service.
      </Section>

      <Section title="5. Data retention">
        We keep your account and booking information for as long as your account is active or as needed
        to provide the Service. Security and server logs are retained for a limited period for
        operational and security purposes. When you delete your account, we remove or anonymize your
        personal information unless we are required to retain it by law.
      </Section>

      <Section title="6. Security">
        We use reasonable technical and organizational measures — including encrypted connections,
        access controls behind Cloudflare, and single-use sign-in links — to protect your information.
        No method of transmission or storage is completely secure, so we cannot guarantee absolute
        security.
      </Section>

      <Section title="7. Your rights">
        You may request access to, correction of, or deletion of your personal information, and you may
        withdraw consent or object to certain processing. To make a request, email us at{" "}
        <a className="text-[var(--accent-brand)] hover:underline" href="mailto:labs@munibshah.com">
          labs@munibshah.com
        </a>
        . Depending on where you live, you may have additional rights under laws such as the GDPR or
        CCPA.
      </Section>

      <Section title="8. Children">
        The Service is not directed to children under 16, and we do not knowingly collect personal
        information from them. If you believe a child has provided us information, contact us and we
        will delete it.
      </Section>

      <Section title="9. Changes to this policy">
        We may update this Privacy Policy from time to time. When we do, we will revise the &ldquo;last
        updated&rdquo; date above, and material changes will be reflected on this page.
      </Section>

      <Section title="10. Contact">
        Questions about your privacy? Reach us at{" "}
        <a className="text-[var(--accent-brand)] hover:underline" href="mailto:labs@munibshah.com">
          labs@munibshah.com
        </a>
        .
      </Section>

      <p className="mt-10 text-sm text-[var(--text-dim)]">
        See also our{" "}
        <Link className="text-[var(--accent-brand)] hover:underline" href="/terms">
          Terms of Service
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

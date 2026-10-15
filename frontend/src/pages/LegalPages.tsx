// LegalPages.tsx — 공개(비로그인 접근 가능) 가격·약관·개인정보·환불 페이지.
// Paddle 도메인 심사용. 결제는 Paddle(Merchant of Record)이 처리한다.
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import styles from './LegalPages.module.css';

export const LEGAL = {
  product: 'Trendar',
  legalName: 'Appflow (앱플로우)',
  owner: 'Seunggyo Jeong',
  country: 'Republic of Korea',
  email: 'mangg363@gmail.com',
  site: 'https://trendar.org',
  updated: 'October 15, 2026',
};

function Shell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <article className={styles.page}>
      <Link to="/" className={styles.back}>◎ Trendar</Link>
      <h1 className={styles.title}>{title}</h1>
      <p className={styles.meta}>Last updated: {LEGAL.updated}</p>
      <div className={styles.body}>{children}</div>
    </article>
  );
}

export function PricingPage() {
  return (
    <article className={styles.page}>
      <Link to="/" className={styles.back}>◎ Trendar</Link>
      <h1 className={styles.title}>Pricing</h1>
      <p className={styles.lead}>
        Trendar is a GitHub trend radar. It tracks fast-rising open-source repositories for the
        keywords, topics and languages you care about, and shows star growth over time.
      </p>
      <div className={styles.plans}>
        <section className={`panel ${styles.plan}`}>
          <h2>Free</h2>
          <div className={styles.price}>$0</div>
          <ul>
            <li>Rising repositories dashboard</li>
            <li>Saved search queries (keywords, topics, languages)</li>
            <li>Star history charts</li>
            <li>Bookmarks</li>
          </ul>
          <a href="/api/auth/github" className="btn">Start free with GitHub</a>
        </section>
        <section className={`panel ${styles.plan} ${styles.featured}`}>
          <h2>Trendar Pro</h2>
          <div className={styles.price}>$9.99<span> / month</span></div>
          <ul>
            <li>Everything in Free</li>
            <li>More saved queries and higher collection limits</li>
            <li>Email trend digests and rising-repo alerts</li>
            <li>Unlimited snapshot history and CSV export</li>
            <li>Priority support</li>
          </ul>
          <a href="/api/auth/github" className="btn btn--primary">Sign in to upgrade</a>
        </section>
      </div>
      <p className={styles.note}>
        Prices in USD. Taxes may apply depending on your location. Pro renews monthly until
        cancelled; you can cancel anytime. See our <Link to="/refund">Refund Policy</Link>.
        Payments are processed by Paddle.com, our Merchant of Record.
      </p>
    </article>
  );
}

export function TermsPage() {
  const L = LEGAL;
  return (
    <Shell title="Terms of Service">
      <p>
        These Terms govern your use of {L.product} ({L.site}), operated by {L.legalName}, a sole
        proprietorship registered in the {L.country} and owned by {L.owner} ("we", "us"). By using
        {' '}{L.product} you agree to these Terms.
      </p>
      <h2>1. The service</h2>
      <p>
        {L.product} collects public repository data from GitHub and presents trends, rankings and
        charts. Data is provided "as is" and may be delayed or incomplete.
      </p>
      <h2>2. Accounts</h2>
      <p>
        You sign in with your GitHub account. You are responsible for activity under your account
        and must be at least 14 years old.
      </p>
      <h2>3. Subscriptions and payment</h2>
      <p>
        Trendar Pro is a paid subscription billed monthly in advance. Our order process is
        conducted by our online reseller Paddle.com. Paddle.com is the Merchant of Record for all
        our orders. Paddle provides all customer service inquiries and handles returns.
        Subscriptions renew automatically until cancelled; cancellation takes effect at the end of
        the current billing period.
      </p>
      <h2>4. Acceptable use</h2>
      <p>
        Do not abuse, overload, scrape or resell the service, attempt to access other users' data,
        or use it for unlawful purposes. We may suspend accounts that violate these Terms.
      </p>
      <h2>5. Intellectual property</h2>
      <p>
        The {L.product} software and design belong to us. Repository data belongs to its respective
        owners and is shown under GitHub's terms.
      </p>
      <h2>6. Disclaimer and liability</h2>
      <p>
        The service is provided without warranties of any kind. To the extent permitted by law, our
        total liability is limited to the amount you paid us in the 12 months before the claim.
      </p>
      <h2>7. Changes and termination</h2>
      <p>
        We may update these Terms or the service; material changes will be announced on the site.
        You may stop using the service at any time.
      </p>
      <h2>8. Governing law</h2>
      <p>These Terms are governed by the laws of the {L.country}.</p>
      <h2>9. Contact</h2>
      <p>{L.legalName} · <a href={`mailto:${L.email}`}>{L.email}</a></p>
    </Shell>
  );
}

export function PrivacyPage() {
  const L = LEGAL;
  return (
    <Shell title="Privacy Policy">
      <p>
        This policy explains how {L.legalName} ("we") handles personal data in {L.product}.
      </p>
      <h2>Data we collect</h2>
      <ul>
        <li>GitHub account basics provided at sign-in: user ID, username, display name, avatar, email if shared.</li>
        <li>Your saved queries, bookmarks and settings.</li>
        <li>Technical logs (IP address, browser, timestamps) for security and debugging.</li>
        <li>Billing details are collected and processed by Paddle.com as Merchant of Record; we receive only subscription status and basic order information.</li>
      </ul>
      <h2>How we use it</h2>
      <p>To provide and secure the service, send emails you opt into (digests, alerts, receipts), and improve features. We do not sell personal data.</p>
      <h2>Sharing</h2>
      <p>We share data only with processors needed to run the service (hosting, email delivery, Paddle for payments) or when required by law.</p>
      <h2>Retention</h2>
      <p>We keep account data while your account is active and delete it within 30 days after you ask us to delete your account.</p>
      <h2>Your rights</h2>
      <p>You can request access, correction or deletion of your data, or withdraw consent, by emailing us.</p>
      <h2>Cookies</h2>
      <p>We use essential cookies for sign-in sessions and language preference only.</p>
      <h2>Contact</h2>
      <p>{L.legalName} ({L.owner}) · <a href={`mailto:${L.email}`}>{L.email}</a></p>
    </Shell>
  );
}

export function RefundPage() {
  const L = LEGAL;
  return (
    <Shell title="Refund Policy">
      <p>
        We want you to be happy with Trendar Pro. If you are not satisfied, you can request a full
        refund within 14 days of your first payment or of any renewal.
      </p>
      <h2>How to request a refund</h2>
      <p>
        Payments are processed by Paddle.com, our Merchant of Record. Request a refund through the
        link in your Paddle receipt email, at paddle.net, or by emailing us at
        {' '}<a href={`mailto:${L.email}`}>{L.email}</a>. Approved refunds are returned to the
        original payment method.
      </p>
      <h2>Cancellation</h2>
      <p>
        You can cancel anytime. After cancellation you keep Pro access until the end of the current
        billing period and will not be charged again.
      </p>
      <p>{L.legalName}</p>
    </Shell>
  );
}

export function LegalFooter() {
  return (
    <footer className={styles.footer}>
      <nav>
        <Link to="/pricing">Pricing</Link>
        <Link to="/terms">Terms</Link>
        <Link to="/privacy">Privacy</Link>
        <Link to="/refund">Refunds</Link>
        <a href={`mailto:${LEGAL.email}`}>Contact</a>
      </nav>
      <p>© 2026 {LEGAL.legalName} · {LEGAL.email}</p>
    </footer>
  );
}

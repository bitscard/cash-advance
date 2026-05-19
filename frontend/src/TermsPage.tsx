import styles from "./App.module.css";

const TermsPage = () => (
  <main className={styles.page} style={{ maxWidth: "80rem", margin: "0 auto", padding: "4rem 2.4rem 8rem" }}>
    <div style={{ marginBottom: "3.2rem" }}>
      <a href="/" style={{ color: "var(--brand)", fontWeight: 600, fontSize: "1.4rem", textDecoration: "none" }}>← Back to Advance</a>
    </div>
    <h1 style={{ fontSize: "3.2rem", fontWeight: 800, marginBottom: "0.8rem" }}>Terms and Conditions</h1>
    <p style={{ color: "var(--muted)", fontSize: "1.4rem", marginBottom: "4rem" }}>Last Updated: May 19, 2026 · Bits, Inc. · <a href="mailto:usa@getbits.app" style={{ color: "var(--brand)" }}>usa@getbits.app</a></p>

    <p style={{ marginBottom: "2.4rem", lineHeight: 1.7 }}>
      PLEASE READ THESE TERMS AND CONDITIONS CAREFULLY BEFORE USING THE ADVANCE SERVICE. Bits, Inc. ("Advance," "we," "our," or "us") provides you access to our website and cash advance services subject to your compliance with these Terms. By registering for or using the Services, you agree to be bound by these Terms. You may use the Services only if you reside in Georgia or Utah, are 18 or older, and can form a binding contract with us.
    </p>

    <Section title="A. What Advance Is (and Is Not)">
      <p>Advance provides a <strong>wage access service — not a loan</strong>. We allow eligible members to access a portion of wages they have already earned during the current pay period, based on their verified income and deposit history. No interest is charged. We do not use your credit score and we never pull your credit. We do not report your account or repayment history to any credit bureau.</p>
      <p style={{ marginTop: "1.2rem" }}>Advances are limited to a conservative fraction of wages you have demonstrably earned in the current pay period based on your historical deposit pattern. We do not advance against future expected income. Current advances are up to <strong>$25</strong>.</p>
      <p style={{ marginTop: "1.2rem" }}>You may not hold more than one outstanding advance at a time. You may not roll over or refinance an unpaid advance.</p>
    </Section>

    <Section title="B. Delivery Options">
      <p><strong>Standard delivery</strong> (1–3 business days): <strong>Free.</strong> This is always available and never requires a fee.</p>
      <p style={{ marginTop: "0.8rem" }}><strong>Instant delivery</strong> (within minutes): <strong>$1.00 convenience fee.</strong> This fee is for the speed of delivery only, not for the use of the advanced funds.</p>
      <p style={{ marginTop: "0.8rem" }}>We do not solicit tips, donations, or optional payments of any kind beyond the instant delivery fee.</p>
    </Section>

    <Section title="C. Membership and Fees">
      <p>Access requires an active Advance membership at <strong>$1.99/month</strong>, billed monthly and auto-renewed. You may cancel at any time. If you cancel within <strong>7 days</strong> of your initial sign-up and no advance has been disbursed, you are entitled to a full refund of your first membership fee.</p>
      <p style={{ marginTop: "0.8rem" }}>To cancel: email <a href="mailto:usa@getbits.app" style={{ color: "var(--brand)" }}>usa@getbits.app</a> with your name and account email.</p>
      <p style={{ marginTop: "0.8rem" }}>If we charge your payment method in error, contact us within 60 days and we will issue a full refund within 5 business days.</p>
    </Section>

    <Section title="D. Advance Settlement and Repayment">
      <p>We collect settlement of your advance <strong>based on your pay deposit arriving</strong>, not on a fixed calendar date. Once a qualifying deposit is detected — confirming wages have landed — we initiate settlement up to the advance amount.</p>
      <p style={{ marginTop: "0.8rem" }}>When your deposit is detected, we will notify you and give you a <strong>24–48 hour window</strong> to repay manually before any automatic debit. Manual repayment is the default-presented option.</p>
      <p style={{ marginTop: "0.8rem" }}>We will not initiate a debit that would cause your account to go negative based on available balance data. If our debit causes an overdraft fee, contact us and we will reimburse it.</p>
    </Section>

    <Section title="E. ACH Authorization">
      <p>By connecting your bank and accepting an advance, you authorize Advance to initiate a single ACH debit from your connected account upon detection of your wage deposit.</p>
      <p style={{ marginTop: "0.8rem" }}><strong>Right to revoke:</strong> You may revoke this authorization at any time before the debit is initiated by emailing <a href="mailto:usa@getbits.app" style={{ color: "var(--brand)" }}>usa@getbits.app</a>. Revocation does not eliminate your obligation to settle voluntarily; however, we will not pursue involuntary collection.</p>
      <p style={{ marginTop: "0.8rem" }}><strong>Retry limit:</strong> If an ACH debit fails, we may attempt one additional retry. After two failed attempts, all automated debits stop.</p>
      <p style={{ marginTop: "0.8rem" }}><strong>Card fallback:</strong> If ACH fails, we will not automatically charge any card on file. We will notify you and present an in-app option requiring your active consent before any card charge.</p>
    </Section>

    <Section title="F. Non-Recourse Policy — Important">
      <p>If an advance is not settled, we will <strong>not</strong>:</p>
      <ul style={{ marginTop: "0.8rem", paddingLeft: "2rem", lineHeight: 2 }}>
        <li>Refer your account to a debt collection agency</li>
        <li>Sell or assign your balance to a debt buyer</li>
        <li>Report anything to any credit bureau</li>
        <li>Initiate any civil lawsuit or legal proceeding against you</li>
      </ul>
      <p style={{ marginTop: "0.8rem" }}>After two failed settlement attempts and no voluntary repayment, we will write off the advance as a loss. You will be ineligible for future advances based on account history — but we will not pursue you for repayment.</p>
    </Section>

    <Section title="G. Required Disclosures">
      <p><strong>This is not a loan.</strong> The Advance service is a wage access product. No interest is charged.</p>
      <p style={{ marginTop: "0.8rem" }}><strong>Fee summary per advance:</strong></p>
      <table style={{ width: "100%", borderCollapse: "collapse", marginTop: "0.8rem", fontSize: "1.4rem" }}>
        <tbody>
          {[
            ["Standard delivery", "$0.00"],
            ["Instant delivery (if selected)", "$1.00"],
            ["Interest", "$0.00"],
            ["Tips", "$0.00 (we do not accept tips)"],
            ["Amount due at settlement", "Advance amount only"],
          ].map(([label, value]) => (
            <tr key={label} style={{ borderBottom: "1px solid var(--border)" }}>
              <td style={{ padding: "0.8rem 0", color: "var(--ink-2)" }}>{label}</td>
              <td style={{ padding: "0.8rem 0", fontWeight: 600, textAlign: "right" }}>{value}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p style={{ marginTop: "1.2rem" }}>We will not report missed settlements to credit bureaus. We will not pursue collections. We will reimburse overdraft fees caused by our debit.</p>
    </Section>

    <Section title="H. Weekly $300 Raffle">
      <p>Every eligible member in good standing is automatically entered into a <strong>weekly raffle</strong> for a <strong>$300 cash prize</strong>. No additional purchase or action is required. One entry per member per week.</p>
      <p style={{ marginTop: "0.8rem" }}><strong>Eligibility:</strong> Active membership, no overdue advances, 18+, resident of a state where the raffle is legally permissible. Members with missed or late settlements are frozen from eligibility until their account is back in good standing.</p>
      <p style={{ marginTop: "0.8rem" }}><strong>Prize:</strong> $300 USD paid via PayPal, CashApp, Zelle, or bank transfer. Non-transferable. Winner is responsible for applicable taxes. Bits, Inc. will issue a Form 1099 if required by law.</p>
      <p style={{ marginTop: "0.8rem" }}><strong>No purchase necessary:</strong> To enter without a membership, email <a href="mailto:usa@getbits.app" style={{ color: "var(--brand)" }}>usa@getbits.app</a> with subject "Raffle Entry." Limit one free entry per person per week.</p>
      <p style={{ marginTop: "0.8rem" }}>Void where prohibited. Advance reserves the right to modify or discontinue the raffle at any time with reasonable notice.</p>
    </Section>

    <Section title="I. Identity Verification and SSN">
      <p>We collect your full SSN to verify your identity and prevent duplicate accounts from being created with different email addresses to obtain multiple advances. Your SSN is stored encrypted, never sold, and never used to pull your credit. We do not share your SSN with third parties except as required by law.</p>
    </Section>

    <Section title="J. Data Practices">
      <p>We collect identity, financial, and usage data to provide the Service. We do not sell your data. Bank transaction data is used solely for income consistency verification, deposit detection, and overdraft protection — not for marketing or sharing with affiliates.</p>
      <p style={{ marginTop: "0.8rem" }}>We retain data for up to 5 years after account closure as required by law. To request deletion, email <a href="mailto:usa@getbits.app" style={{ color: "var(--brand)" }}>usa@getbits.app</a>. Full details are in our Privacy Policy at <a href="https://www.getbits.app/privacy" style={{ color: "var(--brand)" }}>www.getbits.app/privacy</a>.</p>
    </Section>

    <Section title="K. Servicemember Protections (MLA)">
      <p>If you are an active-duty servicemember or dependent as defined under the Military Lending Act (MLA), we screen for MLA-covered status at the time of your application using the DoD database. If our service would result in a Military APR exceeding 36%, we may be unable to provide the Service in its current form and will notify you at application.</p>
    </Section>

    <Section title="L. No Collections — Ever">
      <p>We do not refer accounts to collections, sell debt, or file lawsuits. This is an unconditional commitment. It applies regardless of the amount owed or how long an advance has been outstanding.</p>
    </Section>

    <Section title="M. Dispute Resolution and Reg E Rights">
      <p>If you believe an ACH debit was unauthorized or in error, you have rights under the Electronic Fund Transfer Act and Regulation E. Contact us at <a href="mailto:usa@getbits.app" style={{ color: "var(--brand)" }}>usa@getbits.app</a> within <strong>60 days</strong> of the statement date. We will acknowledge within 5 business days and resolve within 10 business days.</p>
    </Section>

    <Section title="N. Limitation of Liability">
      <p>THE SERVICES ARE PROVIDED "AS IS." ADVANCE'S TOTAL LIABILITY TO YOU SHALL NOT EXCEED THE TOTAL MEMBERSHIP FEES YOU PAID IN THE 12 MONTHS PRECEDING THE CLAIM. THESE LIMITATIONS DO NOT APPLY TO GROSS NEGLIGENCE, FRAUD, OR INTENTIONAL MISCONDUCT.</p>
    </Section>

    <Section title="O. Governing Law">
      <p>These Terms are governed by the laws of the State of <strong>Georgia</strong>. Disputes shall be resolved in courts located in <strong>Atlanta, Georgia</strong>.</p>
    </Section>

    <Section title="P. Termination">
      <p>You may cancel your membership at any time. We may terminate your account for violations of these Terms. Upon termination, outstanding advance balances remain due voluntarily — we will not pursue involuntary collection. Sections covering non-recourse, limitation of liability, and governing law survive termination.</p>
    </Section>

    <Section title="Q. Modifications">
      <p>We may update these Terms at any time. We will notify you by email at least 30 days before material changes take effect. Continued use after the effective date constitutes acceptance.</p>
    </Section>

    <Section title="R. Contact Us">
      <p>
        <strong>Bits, Inc.</strong><br />
        Email: <a href="mailto:usa@getbits.app" style={{ color: "var(--brand)" }}>usa@getbits.app</a><br />
        Website: <a href="https://www.getbits.app" style={{ color: "var(--brand)" }}>www.getbits.app</a>
      </p>
    </Section>

    <p style={{ marginTop: "4rem", fontSize: "1.3rem", color: "var(--muted)", lineHeight: 1.7, borderTop: "1px solid var(--border)", paddingTop: "2.4rem" }}>
      <strong>Legal notice:</strong> These Terms have not been reviewed by legal counsel and are provided as a framework. Before publishing, have a licensed attorney review this document with attention to Georgia and Utah financial services requirements, Military Lending Act compliance, CFPB EWA guidance, Regulation E, GLBA, and FTC marketing guidelines.
    </p>
  </main>
);

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <section style={{ marginBottom: "3.2rem" }}>
    <h2 style={{ fontSize: "1.8rem", fontWeight: 700, marginBottom: "1.2rem", color: "var(--ink)" }}>{title}</h2>
    <div style={{ fontSize: "1.45rem", lineHeight: 1.75, color: "var(--ink-2)" }}>{children}</div>
  </section>
);

export default TermsPage;

import styles from "./App.module.css";

// State-specific provisions table. Used to render Section O. Each entry
// becomes its own subsection — governing law, venue, regulator name, and
// the standard EWA-provider protections statement.
const STATE_PROVISIONS: { state: string; venue: string; regulator: string }[] = [
  { state: "Alabama", venue: "Birmingham", regulator: "Alabama State Banking Department" },
  { state: "Alaska", venue: "Anchorage", regulator: "Alaska Division of Banking and Securities" },
  { state: "Arizona", venue: "Phoenix", regulator: "Arizona Department of Insurance and Financial Institutions" },
  { state: "Colorado", venue: "Denver", regulator: "Colorado Division of Banking" },
  { state: "Delaware", venue: "Wilmington", regulator: "Delaware Office of the State Bank Commissioner" },
  { state: "Florida", venue: "Miami", regulator: "Florida Office of Financial Regulation" },
  { state: "Georgia", venue: "Atlanta", regulator: "Georgia Department of Banking and Finance" },
  { state: "Hawaii", venue: "Honolulu", regulator: "Hawaii Division of Financial Institutions" },
  { state: "Idaho", venue: "Boise", regulator: "Idaho Department of Finance" },
  { state: "Iowa", venue: "Des Moines", regulator: "Iowa Division of Banking" },
  { state: "Kentucky", venue: "Louisville", regulator: "Kentucky Department of Financial Institutions" },
  { state: "Maine", venue: "Portland", regulator: "Maine Bureau of Consumer Credit Protection" },
  { state: "Michigan", venue: "Detroit", regulator: "Michigan Department of Insurance and Financial Services" },
  { state: "Minnesota", venue: "Minneapolis", regulator: "Minnesota Department of Commerce" },
  { state: "Mississippi", venue: "Jackson", regulator: "Mississippi Department of Banking and Consumer Finance" },
  { state: "Montana", venue: "Billings", regulator: "Montana Division of Banking and Financial Institutions" },
  { state: "Nebraska", venue: "Omaha", regulator: "Nebraska Department of Banking and Finance" },
  { state: "New Hampshire", venue: "Manchester", regulator: "New Hampshire Banking Department" },
  { state: "New Jersey", venue: "Newark", regulator: "New Jersey Department of Banking and Insurance" },
  { state: "New Mexico", venue: "Albuquerque", regulator: "New Mexico Financial Institutions Division" },
  { state: "North Carolina", venue: "Charlotte", regulator: "North Carolina Office of the Commissioner of Banks" },
  { state: "North Dakota", venue: "Fargo", regulator: "North Dakota Department of Financial Institutions" },
  { state: "Ohio", venue: "Columbus", regulator: "Ohio Division of Financial Institutions" },
  { state: "Oklahoma", venue: "Oklahoma City", regulator: "Oklahoma Department of Consumer Credit" },
  { state: "Oregon", venue: "Portland", regulator: "Oregon Division of Financial Regulation" },
  { state: "Pennsylvania", venue: "Philadelphia", regulator: "Pennsylvania Department of Banking and Securities" },
  { state: "Rhode Island", venue: "Providence", regulator: "Rhode Island Department of Business Regulation" },
  { state: "South Dakota", venue: "Sioux Falls", regulator: "South Dakota Division of Banking" },
  { state: "Tennessee", venue: "Nashville", regulator: "Tennessee Department of Financial Institutions" },
  { state: "Texas", venue: "Houston", regulator: "Texas Office of Consumer Credit Commissioner" },
  { state: "Vermont", venue: "Burlington", regulator: "Vermont Department of Financial Regulation" },
  { state: "Virginia", venue: "Richmond", regulator: "Virginia Bureau of Financial Institutions" },
  { state: "Washington", venue: "Seattle", regulator: "Washington Department of Financial Institutions" },
  { state: "West Virginia", venue: "Charleston", regulator: "West Virginia Division of Financial Institutions" },
  { state: "Wyoming", venue: "Cheyenne", regulator: "Wyoming Division of Banking" },
];

const STATE_NAMES_INLINE = STATE_PROVISIONS.map(p => p.state).join(", ").replace(/, ([^,]*)$/, ", or $1");

const TermsPage = () => (
  <main className={styles.page} style={{ maxWidth: "80rem", margin: "0 auto", padding: "4rem 2.4rem 8rem" }}>
    <div style={{ marginBottom: "3.2rem" }}>
      <a href="/" style={{ color: "var(--brand)", fontWeight: 600, fontSize: "1.4rem", textDecoration: "none" }}>← Back to Advance</a>
    </div>
    <h1 style={{ fontSize: "3.2rem", fontWeight: 800, marginBottom: "0.8rem" }}>Terms and Conditions</h1>
    <p style={{ color: "var(--muted)", fontSize: "1.4rem", marginBottom: "4rem" }}>Last Updated: May 25, 2026 · Bits, Inc. · <a href="mailto:usa@getbits.app" style={{ color: "var(--brand)" }}>usa@getbits.app</a></p>

    <p style={{ marginBottom: "2.4rem", lineHeight: 1.7 }}>
      PLEASE READ THESE TERMS AND CONDITIONS CAREFULLY BEFORE USING THE ADVANCE SERVICE. Bits, Inc. ("Advance," "we," "our," or "us") provides you access to our website and cash advance services subject to your compliance with these Terms. By registering for or using the Services, you agree to be bound by these Terms.
    </p>
    <p style={{ marginBottom: "2.4rem", lineHeight: 1.7 }}>
      You may use the Services only if you (a) reside in one of the {STATE_PROVISIONS.length} states in which we currently operate — {STATE_NAMES_INLINE} — (b) are 18 years of age or older, and (c) can form a legally binding contract with us. Residents of states not listed are not eligible at this time and may instead join our waitlist for future expansion. State-specific provisions applicable to your state of residence are set forth in <strong>Section O</strong> below and control over any conflicting provision elsewhere in these Terms.
    </p>

    <Section title="A. What Advance Is (and Is Not)">
      <p>Advance provides a <strong>wage access service — not a loan</strong>. We allow eligible users to access a portion of wages they have already earned during the current pay period, based on their verified income and deposit history. No interest is charged. We do not use your credit score and we never pull your credit. We do not report your account or repayment history to any credit bureau.</p>
      <p style={{ marginTop: "1.2rem" }}>Advances are limited to a conservative fraction of wages you have demonstrably earned in the current pay period based on your historical deposit pattern. We do not advance against future expected income. Maximum advance amounts are determined by your account history and are displayed in-app at the time of your request. The default first advance is $25.00; subsequent advances may grow to a maximum of $200.00 on the schedule set forth in your in-app dashboard, subject to on-time repayment.</p>
      <p style={{ marginTop: "1.2rem" }}>You may not hold more than one outstanding advance at a time. You may not roll over or refinance an unpaid advance.</p>
    </Section>

    <Section title="B. Delivery Options">
      <p><strong>3–5 day delivery</strong> (default): Always free. Funds arrive in your selected payout account within three to five business days. Choose this option and you repay only the advance principal — no additional fees.</p>
      <p style={{ marginTop: "0.8rem" }}><strong>Same-day delivery</strong> (optional): A <strong>$5.00 convenience fee</strong> is added to your repayment amount. Funds are sent to your selected payout account the same day your advance is approved. You are never charged upfront — the fee is collected together with your advance principal on your repayment date. This fee covers the cost of expedited transfer only, not the use of advanced funds.</p>
      <p style={{ marginTop: "0.8rem" }}>We do not solicit tips, donations, or optional payments of any kind beyond the applicable same-day delivery fee.</p>
      <p style={{ marginTop: "0.8rem" }}><strong>Payout method:</strong> You may receive your advance via PayPal, Cash App, or Zelle. You select your preferred payout method during onboarding and confirm the account identifier (email, phone number, or $cashtag) prior to receiving any advance. You are responsible for ensuring the accuracy of the account identifier you provide; funds sent to an incorrect identifier may not be recoverable.</p>
    </Section>

    <Section title="C. Advance Settlement and Repayment">
      <p>We collect settlement of your advance <strong>based on your pay deposit arriving</strong>, not on a fixed calendar date. Once a qualifying deposit is detected — confirming wages have landed — we initiate settlement up to the advance amount.</p>
      <p style={{ marginTop: "0.8rem" }}>When your deposit is detected, we will notify you and give you a <strong>24–48 hour window</strong> to repay manually before any automatic debit. Manual repayment is the default-presented option.</p>
      <p style={{ marginTop: "0.8rem" }}>We will not initiate a debit that would cause your account to go negative based on available balance data. If our debit causes an overdraft fee, contact us and we will reimburse it.</p>
    </Section>

    <Section title="D. ACH Authorization">
      <p>By connecting your bank and accepting an advance, you authorize Advance to initiate a single ACH debit from your connected account upon detection of your wage deposit.</p>
      <p style={{ marginTop: "0.8rem" }}><strong>Right to revoke:</strong> You may revoke this authorization at any time before the debit is initiated by emailing <a href="mailto:usa@getbits.app" style={{ color: "var(--brand)" }}>usa@getbits.app</a>. Revocation does not eliminate your obligation to settle voluntarily; however, we will not pursue involuntary collection.</p>
      <p style={{ marginTop: "0.8rem" }}><strong>Retry limit:</strong> If an ACH debit fails, we may attempt one additional retry. After two failed attempts, all automated debits stop.</p>
      <p style={{ marginTop: "0.8rem" }}><strong>Card fallback:</strong> If ACH fails, we may attempt the backup payment card you provided during onboarding, but only if you affirmatively consented to card-fallback at that time. You may withdraw that consent at any time by emailing us.</p>
    </Section>

    <Section title="E. Non-Recourse Policy — Important">
      <p>If an advance is not settled, we will <strong>not</strong>:</p>
      <ul style={{ marginTop: "0.8rem", paddingLeft: "2rem", lineHeight: 2 }}>
        <li>Refer your account to a debt collection agency</li>
        <li>Sell or assign your balance to a debt buyer</li>
        <li>Report anything to any credit bureau</li>
        <li>Initiate any civil lawsuit or legal proceeding against you</li>
      </ul>
      <p style={{ marginTop: "0.8rem" }}>After two failed settlement attempts and no voluntary repayment, we will write off the advance as a loss. You will be ineligible for future advances based on account history — but we will not pursue you for repayment.</p>
    </Section>

    <Section title="F. Required Disclosures">
      <p><strong>This is not a loan.</strong> The Advance service is a wage access product. No interest is charged. There are no membership fees.</p>
      <p style={{ marginTop: "0.8rem" }}><strong>Fee summary per advance:</strong></p>
      <table style={{ width: "100%", borderCollapse: "collapse", marginTop: "0.8rem", fontSize: "1.4rem" }}>
        <tbody>
          {[
            ["3–5 day delivery (default)", "Free — repay advance principal only"],
            ["Same-day delivery (if selected)", "$5.00 — added to repayment; nothing charged upfront"],
            ["Membership fee", "$0.00 (no subscription required)"],
            ["Interest", "$0.00"],
            ["Tips", "$0.00 (we do not accept tips)"],
            ["Amount due at settlement (3–5 day)", "Advance amount only"],
            ["Amount due at settlement (same-day)", "Advance amount + $5.00"],
          ].map(([label, value]) => (
            <tr key={label} style={{ borderBottom: "1px solid var(--border)" }}>
              <td style={{ padding: "0.8rem 0", color: "var(--ink-2)" }}>{label}</td>
              <td style={{ padding: "0.8rem 0", fontWeight: 600, textAlign: "right" }}>{value}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p style={{ marginTop: "0.8rem" }}>We will not report missed settlements to credit bureaus. We will not pursue collections. We will reimburse overdraft fees caused by our debit.</p>
    </Section>

    <Section title="G. Weekly $300 Raffle">
      <p>Every eligible user in good standing is automatically entered into a <strong>weekly raffle</strong> for a <strong>$300 cash prize</strong>. No purchase or action is required. One entry per person per week.</p>
      <p style={{ marginTop: "0.8rem" }}><strong>Eligibility:</strong> Active account, no overdue advances, 18+, resident of a state where the raffle is legally permissible. Users with missed or late settlements are frozen from eligibility until their account is back in good standing.</p>
      <p style={{ marginTop: "0.8rem" }}><strong>Prize:</strong> $300 USD paid via PayPal, Cash App, or Zelle. Non-transferable. Winner is responsible for applicable taxes. Bits, Inc. will issue a Form 1099 if required by law.</p>
      <p style={{ marginTop: "0.8rem" }}><strong>No purchase necessary:</strong> To enter without an account, email <a href="mailto:usa@getbits.app" style={{ color: "var(--brand)" }}>usa@getbits.app</a> with subject "Raffle Entry." Limit one free entry per person per week.</p>
      <p style={{ marginTop: "0.8rem" }}>Void where prohibited. Advance reserves the right to modify or discontinue the raffle at any time with reasonable notice.</p>
    </Section>

    <Section title="H. Identity Verification and SSN">
      <p>We collect your full SSN to verify your identity and prevent duplicate accounts from being created with different email addresses to obtain multiple advances. Your SSN is stored encrypted, never sold, and never used to pull your credit. We do not share your SSN with third parties except as required by law.</p>
    </Section>

    <Section title="I. Data Practices">
      <p>We collect identity, financial, and usage data to provide the Service. We do not sell your data. Bank transaction data is used solely for income consistency verification, deposit detection, and overdraft protection — not for marketing or sharing with affiliates.</p>
      <p style={{ marginTop: "0.8rem" }}>We retain data for up to 5 years after account closure as required by law. To request deletion, email <a href="mailto:usa@getbits.app" style={{ color: "var(--brand)" }}>usa@getbits.app</a>. Full details are in our Privacy Policy at <a href="https://www.getbits.app/privacy" style={{ color: "var(--brand)" }}>www.getbits.app/privacy</a>.</p>
    </Section>

    <Section title="J. Servicemember Protections (MLA)">
      <p>If you are an active-duty servicemember or dependent as defined under the Military Lending Act (MLA), we screen for MLA-covered status at the time of your application using the DoD database. If our service would result in a Military APR exceeding 36%, we may be unable to provide the Service in its current form and will notify you at application.</p>
    </Section>

    <Section title="K. No Collections — Ever">
      <p>We do not refer accounts to collections, sell debt, or file lawsuits. This is an unconditional commitment. It applies regardless of the amount owed or how long an advance has been outstanding.</p>
    </Section>

    <Section title="L. Dispute Resolution and Reg E Rights">
      <p>If you believe an ACH debit was unauthorized or in error, you have rights under the Electronic Fund Transfer Act and Regulation E. Contact us at <a href="mailto:usa@getbits.app" style={{ color: "var(--brand)" }}>usa@getbits.app</a> within <strong>60 days</strong> of the statement date. We will acknowledge within 5 business days and resolve within 10 business days.</p>
    </Section>

    <Section title="M. Limitation of Liability">
      <p>THE SERVICES ARE PROVIDED "AS IS." ADVANCE'S TOTAL LIABILITY TO YOU SHALL NOT EXCEED THE TOTAL FEES YOU PAID FOR THE SERVICE IN THE 12 MONTHS PRECEDING THE CLAIM. THESE LIMITATIONS DO NOT APPLY TO GROSS NEGLIGENCE, FRAUD, OR INTENTIONAL MISCONDUCT.</p>
    </Section>

    <Section title="N. Governing Law (General)">
      <p>These Terms are governed by the laws of the state in which you reside at the time of registration. State-specific governing law and venue provisions are set forth in <strong>Section O (State-Specific Provisions)</strong> below and control over this general clause.</p>
      <p style={{ marginTop: "0.8rem" }}>Where federal law applies — including but not limited to the Electronic Fund Transfer Act and Regulation E (12 C.F.R. Part 1005), the Military Lending Act and its implementing regulations, the Gramm-Leach-Bliley Act and the Safeguards Rule, the Equal Credit Opportunity Act and Regulation B, applicable Consumer Financial Protection Bureau guidance on earned-wage access products, and FTC marketing guidelines — federal law governs.</p>
      <p style={{ marginTop: "0.8rem" }}>To the extent any provision of these Terms is unenforceable in your state, the remainder of these Terms shall remain in full force and effect, and the unenforceable provision shall be modified to the minimum extent necessary to make it enforceable.</p>
    </Section>

    <Section title="O. State-Specific Provisions">
      <p>The following provisions apply to residents of the listed state and govern in addition to (and where conflicting, in place of) the general terms above. Each subsection sets forth the governing law, exclusive venue for any dispute that survives the alternative-dispute-resolution clause in Section M, the principal state regulator with jurisdiction over Bits, Inc.'s activity in that state, and a residents' protections statement. Additional state-mandated disclosures, where required, are provided to you in-app at or before the time of each advance.</p>
      <p style={{ marginTop: "0.8rem", color: "var(--muted)", fontStyle: "italic" }}>If you reside in a state not listed below, you are not eligible to use the Service at this time. You may join our waitlist for future state expansion at <a href="https://www.getbits.app" style={{ color: "var(--brand)" }}>www.getbits.app</a>.</p>

      {STATE_PROVISIONS.map(({ state, venue, regulator }) => (
        <div key={state} style={{ marginTop: "2.8rem", paddingTop: "1.8rem", borderTop: "1px solid var(--border)" }}>
          <h3 style={{ fontSize: "1.7rem", fontWeight: 700, marginBottom: "1rem", color: "var(--ink)" }}>{state}</h3>
          <p>
            <strong>Governing law:</strong> the laws of the State of {state}, without regard to conflict-of-laws principles.
          </p>
          <p style={{ marginTop: "0.6rem" }}>
            <strong>Venue:</strong> the state and federal courts located in or with jurisdiction over {venue}, {state}.
          </p>
          <p style={{ marginTop: "0.6rem" }}>
            <strong>State regulator:</strong> the {regulator}, or any successor agency designated under {state} law.
          </p>
          <p style={{ marginTop: "0.6rem" }}>
            <strong>Residents' protections:</strong> {state} residents are entitled to all consumer protections available under {state} law, including any disclosures, cooling-off periods, fee caps, or licensing requirements applicable to earned-wage access providers. Bits, Inc. operates as an earned-wage access provider — not a lender — and where {state} law specifically regulates earned-wage access, Bits, Inc. complies with those requirements. Where {state} law does not yet specifically address earned-wage access, Bits, Inc. operates in accordance with applicable federal guidance and analogous state consumer-finance protections. Any state-specific disclosures required for residents of {state} will be provided to you in-app at or before the time of each advance and in any pre-advance email confirmation.
          </p>
          <p style={{ marginTop: "0.6rem" }}>
            <strong>Complaints:</strong> you may file a complaint about Bits, Inc.'s services with the {regulator}, with the federal Consumer Financial Protection Bureau at <a href="https://www.consumerfinance.gov" style={{ color: "var(--brand)" }}>consumerfinance.gov</a>, or with us directly at <a href="mailto:usa@getbits.app" style={{ color: "var(--brand)" }}>usa@getbits.app</a>.
          </p>
        </div>
      ))}
    </Section>

    <Section title="P. Termination">
      <p>You may close your account at any time. We may terminate your account for violations of these Terms. Upon termination, outstanding advance balances remain due voluntarily — we will not pursue involuntary collection. Sections covering non-recourse, limitation of liability, and governing law survive termination.</p>
    </Section>

    <Section title="Q. Modifications">
      <p>We may update these Terms at any time. We will notify you by email at least 30 days before material changes take effect. Continued use after the effective date constitutes acceptance. Changes to the list of eligible states in Section O require email notice but may take effect immediately for new applicants; existing users in states being removed from eligibility will be given at least 30 days' notice and the ability to settle any open advance before account closure.</p>
    </Section>

    <Section title="R. Contact Us">
      <p>
        <strong>Bits, Inc.</strong><br />
        Email: <a href="mailto:usa@getbits.app" style={{ color: "var(--brand)" }}>usa@getbits.app</a><br />
        Website: <a href="https://www.getbits.app" style={{ color: "var(--brand)" }}>www.getbits.app</a>
      </p>
    </Section>

    <p style={{ marginTop: "4rem", fontSize: "1.3rem", color: "var(--muted)", lineHeight: 1.7, borderTop: "1px solid var(--border)", paddingTop: "2.4rem" }}>
      <strong>Legal notice:</strong> These Terms have not been reviewed by legal counsel and are provided as a working framework only. Before publishing this version, retain a licensed attorney to review (a) each of the {STATE_PROVISIONS.length} state-specific subsections in Section O for accuracy as to the named regulator, applicable consumer-finance statutes, and any state-mandated disclosures (Texas Office of Consumer Credit Commissioner registration, Virginia earned-wage access provider registration, Nevada-style EWA frameworks where adopted, etc.); (b) Military Lending Act screening procedures and Section J language; (c) Regulation E procedural requirements in Section L; (d) Gramm-Leach-Bliley Act and state-specific privacy obligations (cross-referenced in the Privacy Policy); (e) FTC marketing guidelines for non-loan financial products including the "this is not a loan" representations throughout; and (f) sweepstakes / raffle compliance in Section G across every listed state. Several listed states may require provider registration, licensure, or a specific EWA-provider notice that is not captured in this framework. Do not rely on these Terms as legal advice.
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

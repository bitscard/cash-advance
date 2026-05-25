import styles from "./App.module.css";

// Eligible states — kept in sync with the backend ELIGIBLE_STATES set
// in node/index.js and the Terms page STATE_PROVISIONS list.
const ELIGIBLE_STATES = [
  "Alabama", "Alaska", "Arizona", "Colorado", "Delaware", "Florida", "Georgia",
  "Hawaii", "Idaho", "Iowa", "Kentucky", "Maine", "Michigan", "Minnesota",
  "Mississippi", "Montana", "Nebraska", "New Hampshire", "New Jersey",
  "New Mexico", "North Carolina", "North Dakota", "Ohio", "Oklahoma", "Oregon",
  "Pennsylvania", "Rhode Island", "South Dakota", "Tennessee", "Texas",
  "Vermont", "Virginia", "Washington", "West Virginia", "Wyoming",
];

const PrivacyPage = () => (
  <main className={styles.page} style={{ maxWidth: "80rem", margin: "0 auto", padding: "4rem 2.4rem 8rem" }}>
    <div style={{ marginBottom: "3.2rem" }}>
      <a href="/" style={{ color: "var(--brand)", fontWeight: 600, fontSize: "1.4rem", textDecoration: "none" }}>← Back to Advance</a>
    </div>
    <h1 style={{ fontSize: "3.2rem", fontWeight: 800, marginBottom: "0.8rem" }}>Privacy Policy</h1>
    <p style={{ color: "var(--muted)", fontSize: "1.4rem", marginBottom: "4rem" }}>
      Last Updated: May 25, 2026 · Bits, Inc. ·{" "}
      <a href="mailto:usa@getbits.app" style={{ color: "var(--brand)" }}>usa@getbits.app</a>
    </p>

    {/* GLBA FACTS Notice */}
    <div style={{ background: "var(--surface, #f8f8f8)", border: "1px solid var(--border)", borderRadius: "8px", padding: "2.4rem", marginBottom: "4rem" }}>
      <p style={{ fontSize: "1.2rem", fontWeight: 700, letterSpacing: "0.1em", color: "var(--muted)", marginBottom: "0.4rem" }}>FACTS</p>
      <h2 style={{ fontSize: "2rem", fontWeight: 800, marginBottom: "2.4rem" }}>What does Advance do with your personal information?</h2>

      <FactsRow
        label="Why?"
        content="Financial companies choose how they share your personal information. Federal law gives consumers the right to limit some but not all sharing. Federal law also requires us to tell you how we collect, share, and protect your personal information. Please read this notice carefully to understand what we do."
      />
      <FactsRow
        label="What?"
        content={
          <>
            <p>The types of personal information we collect and share depend on the product or service you have with us. This information can include:</p>
            <ul style={{ marginTop: "0.8rem", paddingLeft: "2rem", lineHeight: 2 }}>
              <li>Name, address, email address, and phone number</li>
              <li>Social Security number and date of birth</li>
              <li>Employment information, employer name, and pay schedule</li>
              <li>Bank account information, transaction history, and deposit patterns</li>
              <li>Payment card information used for advance repayment</li>
              <li>State of residence</li>
            </ul>
            <p style={{ marginTop: "0.8rem" }}>We do <strong>not</strong> collect or use credit scores and we never pull your credit report.</p>
          </>
        }
      />
      <FactsRow
        label="How?"
        content="All financial companies need to share customers' personal information to run their everyday business. In the section below, we list the reasons financial companies can share their customers' personal information; the reasons Advance chooses to share; and whether you can limit this sharing."
        noBorder
      />

      <table style={{ width: "100%", borderCollapse: "collapse", marginTop: "2rem", fontSize: "1.35rem" }}>
        <thead>
          <tr style={{ background: "var(--border)" }}>
            <th style={{ padding: "1rem", textAlign: "left", fontWeight: 700 }}>Reasons we can share your personal information</th>
            <th style={{ padding: "1rem", textAlign: "center", fontWeight: 700 }}>Does Advance share?</th>
            <th style={{ padding: "1rem", textAlign: "center", fontWeight: 700 }}>Can you limit this sharing?</th>
          </tr>
        </thead>
        <tbody>
          {[
            ["For our everyday business purposes — such as to process your transactions, maintain your account(s), respond to court orders and legal investigations, or report to credit bureaus", "Yes", "No"],
            ["For our marketing purposes — to offer our products and services to you", "No", "We do not share"],
            ["For joint marketing with other financial companies", "No", "We do not share"],
            ["For our affiliates' everyday business purposes — information about your transactions and experiences", "No", "We do not share"],
            ["For our affiliates' everyday business purposes — information about your creditworthiness", "No", "We do not share"],
            ["For nonaffiliates to market to you", "No", "We do not share"],
          ].map(([reason, shares, canLimit]) => (
            <tr key={reason} style={{ borderBottom: "1px solid var(--border)" }}>
              <td style={{ padding: "0.8rem 1rem", color: "var(--ink-2)" }}>{reason}</td>
              <td style={{ padding: "0.8rem 1rem", textAlign: "center", fontWeight: 600 }}>{shares}</td>
              <td style={{ padding: "0.8rem 1rem", textAlign: "center", color: shares === "No" ? "var(--muted)" : "inherit" }}>{canLimit}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>

    <Section title="Who We Are">
      <p><strong>Who is providing this notice?</strong> Bits, Inc., operating the Advance wage access service at <a href="https://www.getbits.app" style={{ color: "var(--brand)" }}>www.getbits.app</a>.</p>
    </Section>

    <Section title="Information We Collect">
      <p>We collect personal information when you:</p>
      <ul style={{ marginTop: "0.8rem", paddingLeft: "2rem", lineHeight: 2 }}>
        <li>Register for an account or apply for an advance</li>
        <li>Connect your bank account through our bank verification partner (Plaid)</li>
        <li>Provide your contact information, employer details, or government-issued ID</li>
        <li>Add a payment method for advance repayment</li>
        <li>Communicate with us via email, chat, or in-app messaging</li>
      </ul>
      <p style={{ marginTop: "1.2rem" }}>We also collect information automatically when you use the Service, including device type, browser, IP address, and usage activity. We do not collect this information for marketing purposes.</p>
      <p style={{ marginTop: "1.2rem" }}><strong>We do not pull your credit report and we do not use credit scores</strong> at any point in the application or advance process.</p>
    </Section>

    <Section title="How We Use Your Information">
      <p>We use your personal information solely to provide and improve the Service, including to:</p>
      <ul style={{ marginTop: "0.8rem", paddingLeft: "2rem", lineHeight: 2 }}>
        <li>Verify your identity and prevent duplicate accounts or fraud</li>
        <li>Assess your eligibility for an advance based on verified wage income</li>
        <li>Detect your pay deposit and initiate or schedule advance settlement</li>
        <li>Process advance repayment and instant delivery fees</li>
        <li>Communicate with you about your account, advances, and repayment</li>
        <li>Comply with applicable laws, regulations, and legal process</li>
      </ul>
      <p style={{ marginTop: "1.2rem" }}>We do not use your information for advertising, behavioral profiling, or sale to third parties. Bank transaction data is used exclusively for income verification, deposit detection, and overdraft protection — never for marketing.</p>
    </Section>

    <Section title="How We Protect Your Information">
      <p>To protect your personal information from unauthorized access and use, we implement security measures that comply with federal law. These include:</p>
      <ul style={{ marginTop: "0.8rem", paddingLeft: "2rem", lineHeight: 2 }}>
        <li>Encryption of sensitive data at rest and in transit (TLS/HTTPS)</li>
        <li>Encrypted storage of your Social Security number — never stored in plain text</li>
        <li>Access controls limiting employee access to personal data to those with a need to know</li>
        <li>Bank connections handled by Plaid, a regulated third-party with its own security program</li>
        <li>Payment processing handled by Stripe, a PCI-DSS-compliant payment processor</li>
      </ul>
    </Section>

    <Section title="How We Share Your Information">
      <p>We share your personal information only as described below and never sell it to third parties:</p>
      <ul style={{ marginTop: "0.8rem", paddingLeft: "2rem", lineHeight: 2 }}>
        <li><strong>Service providers:</strong> Plaid (bank connection and income verification), Stripe (payment processing), and cloud infrastructure providers, solely to operate the Service</li>
        <li><strong>Legal compliance:</strong> When required by law, subpoena, court order, or government authority</li>
        <li><strong>Fraud prevention:</strong> To detect, investigate, or prevent fraudulent or illegal activity</li>
        <li><strong>Business transfer:</strong> In connection with a merger, acquisition, or sale of assets, with prior notice to you</li>
      </ul>
      <p style={{ marginTop: "1.2rem" }}>We do <strong>not</strong> share your information with data brokers, advertisers, or marketing partners. We do not report your account activity to any credit bureau.</p>
    </Section>

    <Section title="Your SSN">
      <p>We collect your full Social Security number solely to verify your identity and prevent duplicate accounts from being opened under different email addresses to obtain multiple advances. Your SSN is stored encrypted, never sold, never used to pull your credit, and never shared with third parties except as required by law.</p>
    </Section>

    <Section title="Data Retention">
      <p>We retain your personal information for up to <strong>5 years</strong> after account closure, as required by applicable financial services regulations. Bank transaction data accessed via Plaid is used in real time for income verification and is not stored beyond what is necessary to service your account.</p>
      <p style={{ marginTop: "0.8rem" }}>To request deletion of your data, email us at <a href="mailto:usa@getbits.app" style={{ color: "var(--brand)" }}>usa@getbits.app</a>. We will honor deletion requests to the extent permitted by law. Note that we may be required to retain certain records for legal or regulatory compliance.</p>
    </Section>

    <Section title="Your Rights and Choices">
      <p>You have the right to:</p>
      <ul style={{ marginTop: "0.8rem", paddingLeft: "2rem", lineHeight: 2 }}>
        <li>Access the personal information we hold about you</li>
        <li>Correct inaccurate information in your account</li>
        <li>Request deletion of your personal information (subject to legal retention requirements)</li>
        <li>Revoke your bank connection authorization at any time by contacting us</li>
        <li>Close your account at any time</li>
      </ul>
      <p style={{ marginTop: "1.2rem" }}>To exercise any of these rights, contact us at <a href="mailto:usa@getbits.app" style={{ color: "var(--brand)" }}>usa@getbits.app</a>. We will respond within 30 days.</p>
    </Section>

    <Section title="Where the Advance Service Is Available">
      <p>Advance is currently available to residents of the following {ELIGIBLE_STATES.length} states: {ELIGIBLE_STATES.slice(0, -1).join(", ")}, and {ELIGIBLE_STATES[ELIGIBLE_STATES.length - 1]}. We comply with applicable state financial services, consumer protection, and data privacy requirements in each of these states. If you reside in any other state, you are not eligible to use the Service at this time; you may join our waitlist for future expansion. The list of eligible states may change over time — see the Terms &amp; Conditions for details on how state changes are noticed.</p>
    </Section>

    <Section title="State-Specific Privacy Rights">
      <p>Residents of every state we operate in are entitled to all consumer privacy protections available under their state law, including those administered by the regulators listed in <strong>Section O</strong> of our <a href="/terms" style={{ color: "var(--brand)" }}>Terms &amp; Conditions</a>. Specific state frameworks called out below supplement the rights described elsewhere in this Policy.</p>

      <p style={{ marginTop: "1.6rem" }}><strong>California (CCPA / CPRA):</strong> Although California is not currently in our eligible-states list, this Policy applies to any California resident who may interact with our website. Under the California Consumer Privacy Act, as amended by the California Privacy Rights Act, you have the right to know what personal information we collect about you, the right to request deletion (subject to legal retention requirements), the right to correct inaccurate information, the right to limit the use of sensitive personal information, and the right to opt out of the sale or sharing of personal information. We do not sell or share personal information for cross-context behavioral advertising. To submit a CCPA/CPRA request, email <a href="mailto:usa@getbits.app" style={{ color: "var(--brand)" }}>usa@getbits.app</a> with the subject "CCPA Request."</p>

      <p style={{ marginTop: "1.2rem" }}><strong>Vermont:</strong> In accordance with Vermont law, we will not share information we collect about Vermont residents with companies outside of Bits, Inc., except as permitted by law. We will not share information about your creditworthiness except with your authorization or consent.</p>

      <p style={{ marginTop: "1.2rem" }}><strong>Virginia (VCDPA):</strong> Under the Virginia Consumer Data Protection Act, Virginia residents have the right to access, correct, delete, or obtain a copy of their personal data; to opt out of targeted advertising, sale of personal data, or profiling for decisions with legal effects; and to appeal a refused request. We do not sell personal data and do not engage in targeted advertising. To exercise any of these rights, email <a href="mailto:usa@getbits.app" style={{ color: "var(--brand)" }}>usa@getbits.app</a> with the subject "VCDPA Request."</p>

      <p style={{ marginTop: "1.2rem" }}><strong>Colorado (CPA):</strong> Colorado residents have rights under the Colorado Privacy Act substantially similar to Virginia residents above, including access, correction, deletion, portability, and the right to opt out of certain processing. Email <a href="mailto:usa@getbits.app" style={{ color: "var(--brand)" }}>usa@getbits.app</a> with the subject "CPA Request."</p>

      <p style={{ marginTop: "1.2rem" }}><strong>Other state privacy laws:</strong> Where you reside in a state that has enacted a comprehensive consumer privacy statute (including but not limited to Texas, Oregon, Tennessee, and Montana), you are entitled to the rights afforded under that statute. To exercise rights under any state privacy law, contact <a href="mailto:usa@getbits.app" style={{ color: "var(--brand)" }}>usa@getbits.app</a> and reference the statute by name in your subject line.</p>

      <p style={{ marginTop: "1.2rem" }}><strong>GLBA:</strong> As a financial institution under the Gramm-Leach-Bliley Act, we provide the FACTS notice at the top of this Policy. Federal law gives you the right to limit some — but not all — sharing of your nonpublic personal information. We have already elected not to share for most categories.</p>
    </Section>

    <Section title="Children's Privacy">
      <p>The Service is not directed to individuals under the age of 18. We do not knowingly collect personal information from minors. If you believe we have inadvertently collected information from a minor, contact us immediately at <a href="mailto:usa@getbits.app" style={{ color: "var(--brand)" }}>usa@getbits.app</a> and we will promptly delete it.</p>
    </Section>

    <Section title="Changes to This Policy">
      <p>We may update this Privacy Policy at any time. We will notify you by email at least <strong>30 days</strong> before material changes take effect. The "Last Updated" date at the top of this page reflects the most recent revision. Continued use of the Service after the effective date constitutes acceptance of the updated policy.</p>
    </Section>

    <Section title="Contact Us">
      <p>
        <strong>Bits, Inc.</strong><br />
        Email: <a href="mailto:usa@getbits.app" style={{ color: "var(--brand)" }}>usa@getbits.app</a><br />
        Website: <a href="https://www.getbits.app" style={{ color: "var(--brand)" }}>www.getbits.app</a>
      </p>
      <p style={{ marginTop: "0.8rem" }}>For privacy-related requests, please include "Privacy Request" in the subject line. We will acknowledge your request within 5 business days and respond fully within 30 days.</p>
    </Section>

    <p style={{ marginTop: "4rem", fontSize: "1.3rem", color: "var(--muted)", lineHeight: 1.7, borderTop: "1px solid var(--border)", paddingTop: "2.4rem" }}>
      <strong>Legal notice:</strong> This Privacy Policy has not been reviewed by legal counsel and is provided as a working framework only. Before publishing, retain a licensed attorney to review with attention to: (a) Gramm-Leach-Bliley Act and the FACTS notice format; (b) the {ELIGIBLE_STATES.length} state-specific privacy frameworks applicable to our eligible-states list, including but not limited to comprehensive privacy statutes in Colorado, Virginia, Texas, Oregon, Tennessee, and Montana, as well as state-specific financial services privacy obligations in each jurisdiction; (c) California CCPA/CPRA in case of cross-state user interactions; (d) CFPB earned-wage access guidance and supervisory expectations; and (e) deletion and retention obligations across overlapping federal and state regimes. Do not rely on this Policy as legal advice.
    </p>
  </main>
);

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <section style={{ marginBottom: "3.2rem" }}>
    <h2 style={{ fontSize: "1.8rem", fontWeight: 700, marginBottom: "1.2rem", color: "var(--ink)" }}>{title}</h2>
    <div style={{ fontSize: "1.45rem", lineHeight: 1.75, color: "var(--ink-2)" }}>{children}</div>
  </section>
);

const FactsRow = ({
  label,
  content,
  noBorder,
}: {
  label: string;
  content: React.ReactNode;
  noBorder?: boolean;
}) => (
  <div style={{
    display: "grid",
    gridTemplateColumns: "12rem 1fr",
    gap: "1.6rem",
    padding: "1.6rem 0",
    borderBottom: noBorder ? "none" : "1px solid var(--border)",
    fontSize: "1.4rem",
    lineHeight: 1.7,
  }}>
    <strong style={{ color: "var(--ink)" }}>{label}</strong>
    <div style={{ color: "var(--ink-2)" }}>{content}</div>
  </div>
);

export default PrivacyPage;

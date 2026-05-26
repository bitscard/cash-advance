import styles from "./App.module.css";

const ConsentPage = () => (
  <main className={styles.page} style={{ maxWidth: "80rem", margin: "0 auto", padding: "4rem 2.4rem 8rem" }}>
    <div style={{ marginBottom: "3.2rem" }}>
      <a href="/" style={{ color: "var(--brand)", fontWeight: 600, fontSize: "1.4rem", textDecoration: "none" }}>← Back to Advance</a>
    </div>
    <h1 style={{ fontSize: "3.2rem", fontWeight: 800, marginBottom: "0.8rem" }}>Consent to the Use of Electronic Documents and Signatures</h1>
    <p style={{ color: "var(--muted)", fontSize: "1.4rem", marginBottom: "4rem" }}>
      Last Updated: May 25, 2026 · Bits Card, Inc. ·{" "}
      <a href="mailto:usa@getbits.app" style={{ color: "var(--brand)" }}>usa@getbits.app</a>
    </p>

    <h2 style={{ fontSize: "2rem", fontWeight: 700, marginBottom: "1.2rem", color: "var(--ink)" }}>
      Consent to Receive Electronic Disclosures
    </h2>

    <p style={{ fontSize: "1.45rem", lineHeight: 1.75, color: "var(--ink-2)", marginBottom: "2.4rem" }}>
      <strong>I must read this consent carefully. If I do not wish to receive Disclosures (as defined below) in electronic format, I should not consent. If I do not consent to receiving electronic disclosures, I cannot move forward with applying for a Bits account.</strong>
    </p>

    <Section title="Definitions">
      <p>In this Consent to Receive Electronic Disclosures:</p>
      <ul style={{ marginTop: "0.8rem", paddingLeft: "2rem", lineHeight: 1.9 }}>
        <li>"I", "me," and "my" refer to each applicant for a revolving credit account.</li>
        <li>"You" and "your" refer to Bits Card, Inc.</li>
        <li>"Disclosures" refer to my revolving credit account application, your decision concerning my application (including, if applicable, adverse action notices under the federal Equal Credit Opportunity Act and the federal Fair Credit Reporting Act), my revolving credit account agreement (including disclosures under the federal Truth in Lending Act and other federal and state laws), and all related servicing communications (including periodic statements and change in terms notices).</li>
      </ul>
    </Section>

    <Section title="My Consent to Receive Electronic Disclosures is Required">
      <p>In order for me to apply for a revolving credit account from you, I must consent to receive Disclosures electronically. In order for you to deliver Disclosures to me in an electronic format, I must first read this Consent to Receive Electronic Disclosures and affirmatively consent to receive the Disclosures electronically.</p>
    </Section>

    <Section title="Withdrawing My Consent to Receive Electronic Disclosures">
      <p>I may withdraw my consent to receive electronic Disclosures by email at <a href="mailto:usa@getbits.app" style={{ color: "var(--brand)" }}>usa@getbits.app</a>. My withdrawal of consent will be effective as soon as possible, but no later than 5 business days after you receive my withdrawal of consent. I understand that if I withdraw my consent before you establish a revolving credit account for me, you will treat that as a withdrawal of my application. If I withdraw my consent after you establish a revolving credit account for me, I understand that my account will be closed and I must pay the entire balance and all other amounts due under the revolving credit account agreement in full.</p>
    </Section>

    <Section title="Hardware and Software Requirements to Receive and Access Disclosures">
      <p>In order to receive, access, and retain Disclosures electronically, I must have the following hardware and software:</p>
      <ul style={{ marginTop: "0.8rem", paddingLeft: "2rem", lineHeight: 1.9 }}>
        <li><strong>Browser</strong> — an internet browser that provides 128-bit encryption and is supported by its publisher, such as the latest versions of Microsoft Internet Explorer or Edge, Google Chrome, Mozilla Firefox, and Apple Safari.</li>
        <li><strong>PDF reader</strong> — a program that reads and displays PDF files (such as Adobe Acrobat Reader).</li>
        <li><strong>Operating System</strong> — an operating system that supports a browser and PDF reader as described above, such as the latest versions of Microsoft Windows and Apple OS for personal computers and iOS, Android, or Windows Phone for mobile devices.</li>
        <li><strong>Personal Computer and Mobile Device</strong> — that can connect to the internet, is able to support an operating system as described above, and has sufficient storage capacity to download and save the Disclosures you send me or the ability to print Disclosures from my device.</li>
        <li><strong>Email</strong> — an active email account.</li>
      </ul>
    </Section>

    <Section title="Hardware and Software Requirements to Retain Disclosures">
      <p>I will also need a printer if I wish to print out and retain Disclosures on paper, and electronic storage if I wish to retain Disclosures in electronic form.</p>
    </Section>

    <Section title="Updating My Information">
      <p>I will keep you informed of any change in my email address by emailing you at <a href="mailto:usa@getbits.app" style={{ color: "var(--brand)" }}>usa@getbits.app</a>.</p>
    </Section>

    <Section title="I hereby:">
      <ol style={{ marginTop: "0.8rem", paddingLeft: "2rem", lineHeight: 1.9 }}>
        <li>agree to be bound by the terms of this Consent to Receive Electronic Disclosures;</li>
        <li>confirm that the Internet access device(s) I am using and will use to complete my online application and to receive the Disclosures meet(s) the hardware and software requirements described above;</li>
        <li>consent to receiving the Disclosures electronically; and</li>
        <li>agree to execute all related credit agreements and documents with an electronic signature.</li>
      </ol>
    </Section>

    <p style={{ marginTop: "4rem", fontSize: "1.3rem", color: "var(--muted)", lineHeight: 1.7, borderTop: "1px solid var(--border)", paddingTop: "2.4rem" }}>
      <strong>Legal notice:</strong> This Consent has not been reviewed by legal counsel and is provided as a working framework only. Before publishing, retain a licensed attorney to verify compliance with the federal Electronic Signatures in Global and National Commerce Act (E-SIGN, 15 U.S.C. §§ 7001 et seq.), the Uniform Electronic Transactions Act as adopted in each applicable state, the Equal Credit Opportunity Act and Regulation B, the Fair Credit Reporting Act, the Truth in Lending Act and Regulation Z, and any state-specific electronic-disclosure requirements applicable to revolving credit accounts. Do not rely on this Consent as legal advice.
    </p>
  </main>
);

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <section style={{ marginBottom: "3.2rem" }}>
    <h2 style={{ fontSize: "1.8rem", fontWeight: 700, marginBottom: "1.2rem", color: "var(--ink)" }}>{title}</h2>
    <div style={{ fontSize: "1.45rem", lineHeight: 1.75, color: "var(--ink-2)" }}>{children}</div>
  </section>
);

export default ConsentPage;

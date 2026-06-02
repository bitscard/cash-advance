import { motion } from "framer-motion";
import styles from "./App.module.css";

const fadeUp = {
  hidden: { opacity: 0, y: 24 },
  visible: { opacity: 1, y: 0, transition: { type: "spring" as const, stiffness: 100, damping: 22 } },
};

const StoryPage = () => {
  return (
    <div className={styles.bldPage}>
      {/* Nav — matches the landing */}
      <header className={styles.bldNav}>
        <div className={styles.bldNavInner}>
          <a className={styles.bldBrand} href="/">
            <span className={styles.bldBrandMark}>✓</span>
            advance<span className={styles.bldBrandDot}>.</span>
          </a>
          <nav className={styles.bldLandNavLinks} aria-label="Main">
            <a href="/#how">How it works</a>
            <a href="/#raffle">Raffle</a>
            <a href="/#faq">FAQ</a>
          </nav>
          <div style={{ display: "inline-flex", gap: 10, alignItems: "center" }}>
            <a href="/loan" className={styles.bldNavLink}>Sign in</a>
            <a href="/" className={styles.bldLandNavCta}>Get cash →</a>
          </div>
        </div>
      </header>

      <main>
        {/* Hero */}
        <section className={styles.bldLandHero}>
          <motion.div
            className={styles.bldLandHeroInner}
            initial="hidden"
            animate="visible"
            variants={fadeUp}
          >
            <p className={styles.bldEyebrow}>From the founders</p>
            <h1 className={styles.bldLandHeroH1}>
              We&apos;re guys from England<br /><em>who built this for you.</em>
            </h1>
            <p className={styles.bldLandHeroSub}>
              We didn&apos;t know much about America when we got off the plane. We&apos;ve learned a lot since. This is how advance happened.
            </p>
          </motion.div>
        </section>

        {/* Chapters */}
        {[
          {
            n: "01",
            title: "We came over to learn.",
            body: [
              "We had an idea: help people bridge to their next paycheck without the trap of fees, interest, or credit checks. But coming from England, we weren't going to pretend we already knew how Americans live between paychecks.",
              "So we decided not to guess.",
            ],
            photo: "/founder-1.jpeg",
            flip: false,
          },
          {
            n: "02",
            title: "We ran focus groups.",
            body: [
              "We sat down with Americans and listened — about pay cycles, the gaps between paydays, and the small emergencies that shouldn't snowball into overdraft fees and missed bills.",
              "What we heard shaped what we built.",
            ],
            photo: "/founder-2.jpeg",
            flip: true,
          },
          {
            n: "03",
            title: "So we built it.",
            body: [
              "Up to $300 before payday, delivered the way you actually use money — Zelle, Cash App, or PayPal. AI-powered approvals so you hear back in minutes, not days. No credit pull. No interest. No collections.",
              "A flat $3.99/month if it's useful to you. Cancel any time — we'll only be a little sad.",
            ],
            photo: "/founder-3.jpg",
            flip: false,
          },
        ].map((chapter, i) => (
          <motion.section
            key={chapter.n}
            className={styles.bldStoryChapter}
            data-flip={chapter.flip ? "true" : "false"}
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true, margin: "-80px" }}
            variants={fadeUp}
            custom={i}
          >
            <div className={styles.bldStoryPhotoWrap}>
              <img src={chapter.photo} alt={`Founder photo ${chapter.n}`} className={styles.bldStoryPhoto} />
              <span className={styles.bldStoryPhotoCaption}>{chapter.n} · Founder</span>
            </div>
            <div className={styles.bldStoryCopy}>
              <p className={styles.bldStoryBigN}>{chapter.n}</p>
              <h2 className={styles.bldStoryH2}>{chapter.title}</h2>
              {chapter.body.map((p, idx) => (
                <p key={idx} className={styles.bldStoryBody}>{p}</p>
              ))}
            </div>
          </motion.section>
        ))}

        {/* Brit corner */}
        <section className={styles.bldLandSection}>
          <p className={styles.bldEyebrow} style={{ marginBottom: 12 }}>One last thing</p>
          <h2 className={styles.bldLandH2}>
            If we got something wrong,<br /><em>tell us off.</em>
          </h2>
          <p className={styles.bldLead} style={{ maxWidth: 600 }}>
            We&apos;re Englishmen. We drink tea, say sorry too much, and still call it football. We probably misunderstood some bit of how America works. If we did — <a className={styles.bldFootLink} href="mailto:usa@getbits.app">email us at usa@getbits.app</a> and tell us. We&apos;ll fix it. Or apologize. Probably both.
          </p>
        </section>

        {/* Final CTA */}
        <section className={styles.bldLandCta}>
          <h2 className={styles.bldLandCtaH2}>
            Ready <em>when you are.</em>
          </h2>
          <p className={styles.bldLead} style={{ marginBottom: 32, maxWidth: 460 }}>
            Get started in 2 minutes. No credit check. Cancel anytime.
          </p>
          <a href="/" className={styles.bldBtn} style={{ width: "auto", paddingLeft: 40, paddingRight: 40, textDecoration: "none" }}>
            Get my cash <span aria-hidden="true">→</span>
          </a>
          <p style={{ marginTop: 16, fontSize: 12, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--bld-text-dim)" }}>
            Invite-only beta — have a referral code ready
          </p>
        </section>
      </main>

      {/* Footer */}
      <footer className={styles.bldLandFooter}>
        <div className={styles.bldLandFooterTop}>
          <div>
            <a className={styles.bldBrand} href="/">
              <span className={styles.bldBrandMark}>✓</span>
              advance<span className={styles.bldBrandDot}>.</span>
            </a>
            <p className={styles.bldLandFooterBlurb}>
              A new product from <strong style={{ color: "var(--bld-text)" }}>Bits Card Inc.</strong> Earned wage access — not a loan.
            </p>
            <p style={{ marginTop: 16, fontSize: 11, fontWeight: 700, letterSpacing: "0.16em", textTransform: "uppercase", color: "var(--bld-accent)" }}>
              🇬🇧 Made in England · Built for America
            </p>
          </div>
          <div className={styles.bldLandFooterCols}>
            <div>
              <p className={styles.bldLandFooterColTitle}>Product</p>
              <ul>
                <li><a href="/#how">How it works</a></li>
                <li><a href="/#raffle">Raffle</a></li>
                <li><a href="/#faq">FAQ</a></li>
              </ul>
            </div>
            <div>
              <p className={styles.bldLandFooterColTitle}>Legal</p>
              <ul>
                <li><a href="/terms">Terms</a></li>
                <li><a href="/privacy">Privacy</a></li>
                <li><a href="#">Disclosures</a></li>
              </ul>
            </div>
            <div>
              <p className={styles.bldLandFooterColTitle}>Support</p>
              <ul>
                <li><a href="mailto:usa@getbits.app">Contact</a></li>
                <li><a href="#">Help center</a></li>
              </ul>
            </div>
          </div>
        </div>
        <div className={styles.bldLandFooterBottom}>
          <span style={{ fontSize: 12, color: "var(--bld-text-dim)" }}>© 2026 Bits Card Inc. All rights reserved.</span>
          <div className={styles.bldLandDisclaimer}>
            <p style={{ margin: "0 0 6px", fontWeight: 700, color: "var(--bld-text-muted)" }}>All accounts are subject to ID verification and approval.</p>
            <p style={{ margin: 0 }}>
              advance is an earned wage access product offered by Bits Card Inc. — it is not a loan. Bits USA is powered by Bits Card Inc which has its principal office at 368 9th Avenue, New York, NY 10001. For support, please email us at <a href="mailto:usa@getbits.app" style={{ color: "var(--bld-text-muted)", textDecoration: "underline" }}>usa@getbits.app</a>. Individual borrowers must be a U.S. Citizen, permanent resident, or non-resident U.S. Alien and at least 18 years old. Valid bank account is required.
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
};

export default StoryPage;

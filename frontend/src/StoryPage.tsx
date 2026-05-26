import styles from "./App.module.css";

const StoryPage = () => {
  return (
    <div className={styles.ldPage}>
      {/* Sticky nav matching the landing's */}
      <header className={styles.ldNav}>
        <div className={styles.ldNavInner}>
          <a className={styles.ldBrand} href="/">
            <span className={styles.ldBrandMark}>
              <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true">
                <circle cx="11" cy="11" r="10" fill="#fff" />
                <path d="M6 13l3 3 7-8" stroke="#0d5234" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
            advance<span className={styles.ldBrandDot}>.</span>
          </a>
          <nav className={styles.ldNavLinks} aria-label="Main">
            <a href="/#how">How it works</a>
            <a href="/#raffle">Raffle</a>
            <a href="/#faq">FAQ</a>
          </nav>
          <div className={styles.ldNavCtas}>
            <a href="/loan" className={styles.ldNavSignin}>Sign in</a>
            <a href="/" className={styles.ldBtnGreen}>Get cash <span aria-hidden="true">→</span></a>
          </div>
        </div>
      </header>

      <main>
        {/* Hero */}
        <section className={styles.ldStoryHero}>
          <div className={styles.ldHeroBgGrid} aria-hidden="true" />
          <div className={styles.ldHeroBgGlow} aria-hidden="true" />
          <div className={styles.ldContainer + " " + styles.ldStoryHeroInner}>
            <span className={styles.ldEyebrow}>
              <span className={styles.ldEyebrowDot} aria-hidden="true" />
              From the founders
            </span>
            <h1 className={styles.ldH1}>
              We&apos;re guys from England<br />
              <span className={styles.ldH1Accent}>who built this for you.</span>
            </h1>
            <p className={styles.ldStoryLead}>
              We didn&apos;t know much about America when we got off the plane. We&apos;ve learned a lot since. This is how advance happened.
            </p>
          </div>
        </section>

        {/* Chapter 1 */}
        <section className={styles.ldStoryChapter}>
          <div className={styles.ldContainer + " " + styles.ldStoryChapterGrid}>
            <div className={styles.ldStoryPhotoWrap}>
              <div className={styles.ldStoryPhotoFrame}>
                <img src="/founder-1.jpeg" alt="One of the founders." className={styles.ldStoryPhoto} />
              </div>
            </div>
            <div className={styles.ldStoryChapterCopy}>
              <p className={styles.ldStoryNumber}>01</p>
              <h2 className={styles.ldH2}>We came over to learn.</h2>
              <p className={styles.ldStoryBody}>
                We had an idea: help people bridge to their next paycheck without the trap of fees, interest, or credit checks. But coming from England, we weren&apos;t going to pretend we already knew how Americans live between paychecks.
              </p>
              <p className={styles.ldStoryBody}>
                So we decided not to guess.
              </p>
            </div>
          </div>
        </section>

        {/* Chapter 2 */}
        <section className={`${styles.ldStoryChapter} ${styles.ldStoryChapterAlt}`}>
          <div className={styles.ldContainer + " " + styles.ldStoryChapterGrid + " " + styles.ldStoryChapterFlip}>
            <div className={styles.ldStoryChapterCopy}>
              <p className={styles.ldStoryNumber}>02</p>
              <h2 className={styles.ldH2}>We ran focus groups.</h2>
              <p className={styles.ldStoryBody}>
                We sat down with Americans and listened — about pay cycles, the gaps between paydays, and the small emergencies that shouldn&apos;t snowball into overdraft fees and missed bills.
              </p>
              <p className={styles.ldStoryBody}>
                What we heard shaped what we built.
              </p>
            </div>
            <div className={styles.ldStoryPhotoWrap}>
              <div className={styles.ldStoryPhotoFrame}>
                <img src="/founder-2.jpeg" alt="One of the founders." className={styles.ldStoryPhoto} />
              </div>
            </div>
          </div>
        </section>

        {/* Chapter 3 */}
        <section className={styles.ldStoryChapter}>
          <div className={styles.ldContainer + " " + styles.ldStoryChapterGrid}>
            <div className={styles.ldStoryPhotoWrap}>
              <div className={styles.ldStoryPhotoFrame}>
                <img src="/founder-3.jpg" alt="One of the founders." className={styles.ldStoryPhoto} />
              </div>
            </div>
            <div className={styles.ldStoryChapterCopy}>
              <p className={styles.ldStoryNumber}>03</p>
              <h2 className={styles.ldH2}>So we built it.</h2>
              <p className={styles.ldStoryBody}>
                Up to $300 before payday, delivered the way you actually use money — Zelle, Cash App, or PayPal. AI-powered approvals so you hear back in minutes, not days. No credit pull. No interest. No collections.
              </p>
              <p className={styles.ldStoryBody}>
                A flat $3.99/month if it&apos;s useful to you. Cancel any time — we&apos;ll only be a little sad.
              </p>
            </div>
          </div>
        </section>

        {/* Brit corner */}
        <section className={styles.ldStoryBrit}>
          <div className={styles.ldContainer}>
            <p className={styles.ldKicker}>One last thing</p>
            <h2 className={styles.ldH2}>If we got something wrong,<br />tell us off.</h2>
            <p className={styles.ldStoryBody} style={{ maxWidth: "640px" }}>
              We&apos;re Englishmen. We drink tea, say sorry too much, and still call it football. We probably misunderstood some bit of how America works. If we did — <a className={styles.ldInlineLink} href="mailto:usa@getbits.app">email us at usa@getbits.app</a> and tell us. We&apos;ll fix it. Or apologize. Probably both.
            </p>
          </div>
        </section>

        {/* CTA */}
        <section className={styles.ldCta}>
          <div className={styles.ldCtaBgGlow} aria-hidden="true" />
          <div className={styles.ldContainer}>
            <h2 className={styles.ldCtaHeadline}>
              Ready when you are.
            </h2>
            <p className={styles.ldCtaSub}>Get started in 2 minutes. No credit check. Cancel anytime.</p>
            <div className={styles.ldCtaBtnRow}>
              <a href="/" className={styles.ldBtnWhiteLg}>Get my cash <span aria-hidden="true">→</span></a>
              <a className={styles.ldCtaGhost} href="/#faq">Read the FAQ</a>
            </div>
            <p className={styles.ldCtaNote}>Invite-only beta — have a referral code ready</p>
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className={styles.ldFooter}>
        <div className={styles.ldContainer}>
          <div className={styles.ldFooterTop}>
            <div className={styles.ldFooterBrand}>
              <a className={styles.ldBrand} href="/">
                advance<span className={styles.ldBrandDot}>.</span>
              </a>
              <p>
                A new product from <strong>Bits Card Inc.</strong><br />
                Earned wage access — not a loan.
              </p>
              <p className={styles.ldFooterMade}>
                <span aria-hidden="true">🇬🇧</span> Made in England · Built for America
              </p>
            </div>
            <div className={styles.ldFooterCols}>
              <div>
                <p className={styles.ldFooterColTitle}>Product</p>
                <ul className={styles.ldFooterLinks}>
                  <li><a href="/#how">How it works</a></li>
                  <li><a href="/#raffle">Raffle</a></li>
                  <li><a href="/#faq">FAQ</a></li>
                </ul>
              </div>
              <div>
                <p className={styles.ldFooterColTitle}>Legal</p>
                <ul className={styles.ldFooterLinks}>
                  <li><a href="/terms">Terms</a></li>
                  <li><a href="/privacy">Privacy</a></li>
                  <li><a href="#">Disclosures</a></li>
                </ul>
              </div>
              <div>
                <p className={styles.ldFooterColTitle}>Support</p>
                <ul className={styles.ldFooterLinks}>
                  <li><a href="mailto:usa@getbits.app">Contact</a></li>
                  <li><a href="#">Help center</a></li>
                </ul>
              </div>
            </div>
          </div>
          <div className={styles.ldFooterBottom}>
            <span>© 2026 Bits Card Inc. All rights reserved.</span>
            <div className={styles.ldDisclaimer}>
              <p className={styles.ldDisclaimerLead}>All accounts are subject to ID verification and approval.</p>
              <p>
                advance is an earned wage access product offered by Bits Card Inc. — it is not a loan. Bits USA is powered by Bits Card Inc which has its principal office at 368 9th Avenue, New York, NY 10001. For support, please email us at <a href="mailto:usa@getbits.app">usa@getbits.app</a>. Individual borrowers must be a U.S. Citizen, permanent resident, or non-resident U.S. Alien and at least 18 years old. Valid bank account is required.
              </p>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
};

export default StoryPage;

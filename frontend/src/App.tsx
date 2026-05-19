import React, { useCallback, useEffect, useMemo, useState } from "react";
import { loadStripe } from "@stripe/stripe-js";
import { Elements, CardElement, useStripe, useElements } from "@stripe/react-stripe-js";

import { apiUrl } from "./api";
import styles from "./App.module.css";

const stripeKey = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY || "";
const stripePromise = stripeKey ? loadStripe(stripeKey) : null;

type Status =
  | "intake"
  | "bank_connected"
  | "reviewing"
  | "approved"
  | "denied"
  | "funded"
  | "repayment_scheduled"
  | "repaid"
  | "repayment_failed";

interface Application {
  id: string;
  customer: {
    name: string;
    email: string;
    phone: string;
    employer: string;
    ssn_last4: string | null;
  };
  requested_amount: number;
  payday: string;
  status: Status;
  plaid_connected: boolean;
  stripe_card_saved: boolean;
  stripe_charge_status: string | null;
  payout_methods: string | null;
  payout_contact: string | null;
  subscription_status: string | null;
  delivery_type: string | null;
  instant_fee_paid: boolean;
  repayment: null | {
    amount: number;
    due_date: string;
    status: string;
    note: string;
    created_at: string;
  };
  created_at: string;
  updated_at: string;
}

interface Message {
  id: string;
  sender: "customer" | "admin" | "system";
  text: string;
  created_at: string;
}

interface BankSnapshot {
  accounts: Array<{
    id: string;
    display_name: string;
    institution_name: string;
    last4: string | null;
    category: string;
    balance: {
      available: number | null; // cents
      current: number | null;   // cents
    } | null;
  }>;
  transactions: Array<{
    id: string;
    description: string;
    amount: number;   // positive = credit, in cents
    currency: string;
    date: string;
    category: string;
  }>;
  auth: unknown;
}

const applicationStorageKey = "advance_application_id";
const userTokenStorageKey = "advance_user_token";
const adminTokenStorageKey = "advance_admin_token";

const statusLabel: Record<Status, string> = {
  intake: "Intake",
  bank_connected: "Bank connected",
  reviewing: "Reviewing",
  approved: "Approved",
  denied: "Denied",
  funded: "Funded",
  repayment_scheduled: "Repayment scheduled",
  repaid: "Repaid",
  repayment_failed: "Repayment failed",
};

const formatMoney = (amount: number | null | undefined) => {
  if (amount == null) return "Unavailable";
  return amount.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  });
};

const today = new Date().toISOString().slice(0, 10);
const thirtyDaysFromNow = (() => { const d = new Date(); d.setDate(d.getDate() + 30); return d.toISOString().slice(0, 10); })();

function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return dp[a.length][b.length];
}

function fuzzyMatch(query: string, text: string): boolean {
  if (!query.trim()) return true;
  const q = query.toLowerCase().trim();
  const t = text.toLowerCase();
  if (t.includes(q)) return true;
  const textWords = t.split(/\s+/);
  return q.split(/\s+/).every(qw =>
    textWords.some(tw => levenshtein(qw, tw) <= Math.max(1, Math.floor(qw.length / 3)))
  );
}

function amountMatch(query: string, amount: number): boolean {
  if (!query.trim()) return true;
  const target = parseFloat(query);
  if (isNaN(target) || target <= 0) return true;
  const abs = Math.abs(amount);
  return abs >= target * 0.75 && abs <= target * 1.25;
}

// ── Shared components ─────────────────────────────────────────────────────────

const NavBar = ({
  onLogout,
  onGetStarted,
  onSignIn,
}: {
  onLogout?: () => void;
  onGetStarted?: () => void;
  onSignIn?: () => void;
}) => (
  <nav className={styles.nav}>
    <div className={styles.navBrand}>
      <svg width="30" height="30" viewBox="0 0 30 30" fill="none" aria-hidden="true">
        <rect width="30" height="30" rx="9" fill="#1a4d3a" />
        <path d="M15 7L21 11V19L15 23L9 19V11L15 7Z" fill="white" fillOpacity="0.92" />
        <circle cx="15" cy="15" r="3" fill="#1a4d3a" />
      </svg>
      Advance
    </div>
    <div className={styles.navRight}>
      {!onGetStarted && (
        <span className={styles.navSecure}>
          <svg width="13" height="14" viewBox="0 0 13 14" fill="none" aria-hidden="true">
            <path d="M6.5 1L11.5 3.5V8C11.5 11 9.3 13.5 6.5 14.2C3.7 13.5 1.5 11 1.5 8V3.5L6.5 1Z" fill="#607870" />
          </svg>
          Bank-level security
        </span>
      )}
      {onGetStarted && onSignIn && (
        <div className={styles.navCtas}>
          <button className={styles.navCtaGhost} onClick={onSignIn}>Sign in</button>
          <button className={styles.navCtaPrimary} onClick={onGetStarted}>Get started</button>
        </div>
      )}
      {onLogout && (
        <button className={styles.logoutBtn} onClick={onLogout}>Sign out</button>
      )}
    </div>
  </nav>
);

const TrustPillars = () => (
  <section className={`${styles.section} ${styles.sectionTint}`}>
    <div className={styles.sectionInner}>
      <p className={styles.sectionLabel}>Why people trust us</p>
      <div className={styles.trustGrid}>
        <div className={styles.trustCard}>
          <div className={styles.trustIcon}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M12 3L15 9.5H22L16.5 13.5L18.5 20.5L12 16.5L5.5 20.5L7.5 13.5L2 9.5H9L12 3Z" fill="#1a4d3a" />
            </svg>
          </div>
          <strong>Same-day decision</strong>
          <span>Apply in minutes. A real human reviews and responds the same day.</span>
        </div>
        <div className={styles.trustCard}>
          <div className={styles.trustIcon}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M12 2L20 6V12C20 16.8 16.5 21 12 22.2C7.5 21 4 16.8 4 12V6L12 2Z" fill="#1a4d3a" />
              <path d="M9 12L11.5 14.5L15.5 9.5" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <strong>256-bit encryption</strong>
          <span>Your data is protected by the same technology banks use. Powered by Plaid and Stripe.</span>
        </div>
        <div className={styles.trustCard}>
          <div className={styles.trustIcon}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <circle cx="12" cy="12" r="9" stroke="#1a4d3a" strokeWidth="2.2" />
              <path d="M8.5 12L11 14.5L15.5 9" stroke="#1a4d3a" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <strong>No credit check — ever</strong>
          <span>We verify your income, not your credit score. Your credit is never pulled.</span>
        </div>
      </div>
    </div>
  </section>
);

const AlienMascot = ({ flag = "usa", size = 220 }: { flag?: "usa" | "mexico"; size?: number }) => (
  <svg width={size} height={Math.round(size * 1.25)} viewBox="0 0 200 250" fill="none" xmlns="http://www.w3.org/2000/svg">
    {/* Ground shadow */}
    <ellipse cx="95" cy="245" rx="50" ry="7" fill="rgba(0,0,0,0.10)"/>

    {/* Body */}
    <rect x="68" y="132" width="56" height="76" rx="28" fill="#a78bfa"/>
    {/* Body highlight */}
    <ellipse cx="82" cy="148" rx="10" ry="14" fill="rgba(255,255,255,0.15)"/>

    {/* Head */}
    <circle cx="96" cy="82" r="54" fill="#a78bfa"/>
    {/* Head highlight */}
    <ellipse cx="78" cy="60" rx="18" ry="14" fill="rgba(255,255,255,0.13)"/>

    {/* Eyes — white sclera */}
    <ellipse cx="78" cy="76" rx="17" ry="20" fill="white"/>
    <ellipse cx="114" cy="76" rx="17" ry="20" fill="white"/>
    {/* Irises */}
    <circle cx="81" cy="79" rx="11" ry="11" r="11" fill="#4c1d95"/>
    <circle cx="117" cy="79" r="11" fill="#4c1d95"/>
    {/* Pupils */}
    <circle cx="83" cy="81" r="5.5" fill="#0f0a1e"/>
    <circle cx="119" cy="81" r="5.5" fill="#0f0a1e"/>
    {/* Eye shine */}
    <circle cx="77" cy="73" r="4" fill="white"/>
    <circle cx="113" cy="73" r="4" fill="white"/>

    {/* Smile */}
    <path d="M80 103 Q96 118 112 103" stroke="#4c1d95" strokeWidth="4" strokeLinecap="round" fill="none"/>

    {/* Antenna stem */}
    <line x1="96" y1="28" x2="96" y2="50" stroke="#c4b5fd" strokeWidth="5" strokeLinecap="round"/>
    {/* Antenna ball */}
    <circle cx="96" cy="21" r="12" fill="#7c3aed"/>
    <circle cx="91" cy="17" r="4.5" fill="rgba(255,255,255,0.35)"/>

    {/* Left arm (relaxed, down) */}
    <path d="M69 155 Q44 172 40 194" stroke="#a78bfa" strokeWidth="19" strokeLinecap="round" fill="none"/>
    <circle cx="39" cy="197" r="12" fill="#8b5cf6"/>

    {/* Right arm (raised, holding flag) */}
    <path d="M123 150 Q152 133 158 106" stroke="#a78bfa" strokeWidth="19" strokeLinecap="round" fill="none"/>
    <circle cx="159" cy="103" r="12" fill="#8b5cf6"/>

    {/* Legs */}
    <rect x="74" y="200" width="20" height="38" rx="10" fill="#8b5cf6"/>
    <rect x="98" y="200" width="20" height="38" rx="10" fill="#8b5cf6"/>
    {/* Feet */}
    <ellipse cx="84" cy="239" rx="16" ry="9" fill="#7c3aed"/>
    <ellipse cx="108" cy="239" rx="16" ry="9" fill="#7c3aed"/>

    {/* Flag pole */}
    <line x1="159" y1="46" x2="159" y2="106" stroke="#92400e" strokeWidth="5" strokeLinecap="round"/>
    <circle cx="159" cy="44" r="5" fill="#d97706"/>

    {flag === "usa" ? (
      <g>
        <rect x="159" y="47" width="38" height="30" rx="2" fill="#ef4444"/>
        <rect x="159" y="51" width="38" height="4.5" fill="white"/>
        <rect x="159" y="60" width="38" height="4.5" fill="white"/>
        <rect x="159" y="69" width="38" height="4.5" fill="white"/>
        <rect x="159" y="47" width="17" height="19" rx="1" fill="#1d4ed8"/>
        <circle cx="163" cy="51" r="1.5" fill="white"/>
        <circle cx="168" cy="51" r="1.5" fill="white"/>
        <circle cx="173" cy="51" r="1.5" fill="white"/>
        <circle cx="165" cy="56" r="1.5" fill="white"/>
        <circle cx="170" cy="56" r="1.5" fill="white"/>
        <circle cx="175" cy="56" r="1.5" fill="white"/>
        <circle cx="163" cy="61" r="1.5" fill="white"/>
        <circle cx="168" cy="61" r="1.5" fill="white"/>
        <circle cx="173" cy="61" r="1.5" fill="white"/>
      </g>
    ) : (
      <g>
        <rect x="159" y="47" width="13" height="30" rx="2" fill="#006847"/>
        <rect x="172" y="47" width="13" height="30" fill="white"/>
        <rect x="185" y="47" width="12" height="30" rx="2" fill="#ce1126"/>
        <circle cx="178" cy="62" r="7" fill="#8b4513"/>
        <circle cx="178" cy="62" r="4" fill="#d97706"/>
        <circle cx="176" cy="60" r="1.5" fill="rgba(255,255,255,0.4)"/>
      </g>
    )}
  </svg>
);

// ── App router ────────────────────────────────────────────────────────────────

const App = () => {
  const path = window.location.pathname;
  if (path === "/admin") return <AdminApp />;
  if (path === "/loan") return <LoanApp />;
  return <CustomerApp />;
};

// ── Customer app ──────────────────────────────────────────────────────────────

const CustomerApp = () => {
  const [application, setApplication] = useState<Application | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [form, setForm] = useState({
    name: "",
    email: "",
    phone: "",
    employer: "",
    payday: "",
    ssn_last4: "",
    password: "",
    confirmPassword: "",
  });
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<"landing" | "signup">("landing");
  const [isDateFocused, setIsDateFocused] = useState(false);
  const [token, setToken] = useState<string>(() => localStorage.getItem(userTokenStorageKey) || "");
  const [subBusy, setSubBusy] = useState(false);
  const [showDeliveryModal, setShowDeliveryModal] = useState(false);
  const [deliveryChoice, setDeliveryChoice] = useState<"instant" | "standard" | null>(null);
  const [deliveryBusy, setDeliveryBusy] = useState(false);
  const [deliveryError, setDeliveryError] = useState<string | null>(null);

  const loadApplication = useCallback(async (id: string) => {
    const response = await fetch(apiUrl(`/api/advance/applications/${id}`));
    if (!response.ok) {
      localStorage.removeItem(applicationStorageKey);
      return;
    }
    const data = await response.json();
    setApplication(data.application);
  }, []);

  const loadMessages = useCallback(async (id: string) => {
    const response = await fetch(apiUrl(`/api/advance/applications/${id}/messages`));
    if (!response.ok) return;
    const data = await response.json();
    setMessages(data.messages);
  }, []);

  useEffect(() => {
    const applicationId = localStorage.getItem(applicationStorageKey);
    if (applicationId) {
      loadApplication(applicationId);
      loadMessages(applicationId);
    }
  }, [loadApplication, loadMessages]);

  useEffect(() => {
    if (!application?.id) return;
    const interval = window.setInterval(() => {
      loadApplication(application.id);
      loadMessages(application.id);
    }, 4000);
    return () => window.clearInterval(interval);
  }, [application?.id, loadApplication, loadMessages]);

  const handleLogout = () => {
    localStorage.removeItem(applicationStorageKey);
    localStorage.removeItem(userTokenStorageKey);
    setApplication(null);
    setMessages([]);
    setView("landing");
    setToken("");
  };

  useEffect(() => {
    if (
      application &&
      !application.delivery_type &&
      (application.status === "approved" || application.status === "funded" || application.status === "repayment_scheduled")
    ) {
      setShowDeliveryModal(true);
    } else {
      setShowDeliveryModal(false);
    }
  }, [application?.delivery_type, application?.status]);

  const activateSubscription = async () => {
    if (!application) return;
    setSubBusy(true);
    setError(null);
    try {
      const res = await fetch(apiUrl(`/api/advance/applications/${application.id}/subscription/activate`), {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.error_message || "Could not activate membership");
      setApplication(data.application);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setSubBusy(false);
    }
  };

  const saveDelivery = async () => {
    if (!application || !deliveryChoice) { setDeliveryError("Please choose a delivery option"); return; }
    setDeliveryBusy(true);
    setDeliveryError(null);
    try {
      const res = await fetch(apiUrl(`/api/advance/applications/${application.id}/delivery`), {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ delivery_type: deliveryChoice }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.error_message || "Could not save delivery preference");
      setApplication(data.application);
      setShowDeliveryModal(false);
    } catch (e) {
      setDeliveryError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setDeliveryBusy(false);
    }
  };

  const handleSignupSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (form.password !== form.confirmPassword) {
      setError("Passwords do not match");
      return;
    }
    setError(null);
    await createApplication();
  };

  const createApplication = async () => {
    setIsBusy(true);
    setError(null);
    try {
      const { confirmPassword, ...body } = form;
      const response = await fetch(apiUrl("/api/advance/applications"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, requested_amount: 10 }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.error_message || "Unable to start application");
      localStorage.setItem(applicationStorageKey, data.application.id);
      if (data.token) {
        localStorage.setItem(userTokenStorageKey, data.token);
        setToken(data.token);
      }
      setApplication(data.application);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Something went wrong");
    } finally {
      setIsBusy(false);
    }
  };

  const connectBank = async () => {
    if (!application) return;
    setIsBusy(true);
    setError(null);
    try {
      const stripeInst = await stripePromise;
      if (!stripeInst) throw new Error("Stripe is not configured on this server");

      const res = await fetch(apiUrl(`/api/advance/applications/${application.id}/stripe/bank-setup-intent`), {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.error_message || "Could not start bank connection");

      // Open Stripe Financial Connections modal
      const { setupIntent, error: fcError } = await stripeInst.collectBankAccountForSetup({
        clientSecret: data.client_secret,
        params: {
          payment_method_type: "us_bank_account",
          payment_method_data: {
            billing_details: {
              name: application.customer.name,
              email: application.customer.email,
            },
          },
        },
        expand: ["payment_method"],
      });

      if (fcError) throw new Error(fcError.message);
      // User cancelled the modal
      if (!setupIntent || setupIntent.status === "requires_payment_method") return;

      // Confirm the SetupIntent to authorise the mandate
      if (setupIntent.status === "requires_confirmation") {
        const { error: confirmError } = await stripeInst.confirmUsBankAccountSetup(data.client_secret);
        if (confirmError) throw new Error(confirmError.message);
      }

      // Extract IDs from the (expanded) payment method
      const pm = setupIntent.payment_method as any;
      const pmId: string | undefined = typeof pm === "string" ? pm : pm?.id;
      const fcAccountId: string | null = typeof pm === "object"
        ? (pm?.us_bank_account?.financial_connections_account ?? null)
        : null;

      const saveRes = await fetch(apiUrl(`/api/advance/applications/${application.id}/stripe/save-bank-account`), {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ payment_method_id: pmId, financial_connections_account_id: fcAccountId }),
      });
      const saveData = await saveRes.json();
      if (!saveRes.ok) throw new Error(saveData.error?.error_message || "Could not save bank account");
      setApplication(saveData.application);
      await loadMessages(application.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setIsBusy(false);
    }
  };


  // ── Landing ──────────────────────────────────────────────────────────────────
  if (!application) {
    if (view === "landing") {
      return (
        <main className={styles.page}>
          <NavBar
            onGetStarted={() => setView("signup")}
            onSignIn={() => window.location.href = "/loan"}
          />

          {/* Hero — two-column with mascot */}
          <section className={styles.hero}>
            <div className={styles.heroContent}>
              <div className={styles.heroTextBlock}>
                <div className={styles.heroTrustRow}>
                  <span className={styles.heroBadge}>No credit check · No hidden fees</span>
                  <span className={styles.heroTrustBadge}>👥 Trusted by 700,000+ people</span>
                </div>
                <h1 className={styles.heroHeading}>Get cash<br />before payday.</h1>
                <p className={styles.heroSub}>
                  Connect your bank, get a decision today, and pay it back within 30 days. That's it.
                </p>
                <div className={styles.heroActions}>
                  <button className={styles.btnWhite} onClick={() => setView("signup")}>
                    Get started — it's free
                  </button>
                </div>
              </div>
              <div className={styles.mascotWrap}>
                <AlienMascot flag="usa" size={240} />
              </div>
            </div>
          </section>

          {/* Raffle banner */}
          <section className={styles.raffleBanner}>
            <div className={styles.raffleBannerInner}>
              <div>
                <p className={styles.raffleBadge}>🎰 Limited-time raffle</p>
                <h2 className={styles.raffleHeading}>Win a free trip<br />to <em>Cancún.</em></h2>
                <p className={styles.raffleSub}>
                  Everyone who applies for a cash advance is automatically entered into our raffle to win an all-inclusive trip to Cancún, Mexico. No extra steps — just apply.
                </p>
                <div className={styles.rafflePerks}>
                  <div className={styles.rafflePerk}>
                    <div className={styles.rafflePerkDot} />
                    One raffle entry per application — automatic
                  </div>
                  <div className={styles.rafflePerk}>
                    <div className={styles.rafflePerkDot} />
                    Open to all U.S. applicants
                  </div>
                  <div className={styles.rafflePerk}>
                    <div className={styles.rafflePerkDot} />
                    Winner announced monthly
                  </div>
                </div>
              </div>
              <div className={styles.raffleMascot}>
                <AlienMascot flag="mexico" size={220} />
              </div>
            </div>
          </section>

          {/* Trust stats strip */}
          <div className={styles.trustStatStrip}>
            <div className={styles.trustStatItem}>
              <span className={styles.trustStatNum}>700k+</span>
              <span className={styles.trustStatLabel}>People trust us<br />with their data</span>
            </div>
            <div className={styles.trustStatItem}>
              <span className={styles.trustStatNum}>$0</span>
              <span className={styles.trustStatLabel}>Hidden fees,<br />ever</span>
            </div>
            <div className={styles.trustStatItem}>
              <span className={styles.trustStatNum}>30</span>
              <span className={styles.trustStatLabel}>Days to repay,<br />no pressure</span>
            </div>
          </div>

          {/* How it works */}
          <section className={styles.section}>
            <div className={styles.sectionInner}>
              <p className={styles.sectionLabel}>How it works</p>
              <h2 className={styles.sectionHeading}>Three steps to your money.</h2>
              <div className={styles.stepsGrid}>
                <div className={styles.stepCard}>
                  <div className={styles.stepNum}>1</div>
                  <strong>Apply in 2 minutes</strong>
                  <span>Name, employer, next payday, last 4 of SSN. No credit pull — ever.</span>
                </div>
                <div className={styles.stepCard}>
                  <div className={styles.stepNum}>2</div>
                  <strong>Connect your bank</strong>
                  <span>We verify your income via Plaid. Secure and read-only — we never see your password.</span>
                </div>
                <div className={styles.stepCard}>
                  <div className={styles.stepNum}>3</div>
                  <strong>Get your money</strong>
                  <span>A real human reviews your application and sends your money the same day.</span>
                </div>
              </div>
            </div>
          </section>

          {/* Trust pillars */}
          <TrustPillars />

          {/* Partner strip */}
          <div className={styles.partnerStrip}>
            <span>Secured by</span>
            <div className={styles.partnerBadge}>
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="6" fill="#000"/><path d="M4 7l2.5 2.5L10 5" stroke="#fff" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>
              Plaid
            </div>
            <div className={styles.partnerBadge}>
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><rect width="14" height="14" rx="3" fill="#635bff"/><path d="M5.8 5.2c0-.5.4-.8 1-.8.8 0 1.6.3 2.2.6V3.4C8.4 3.1 7.7 3 7 3 5.3 3 4.2 3.9 4.2 5.3c0 2.2 3 1.8 3 2.9 0 .6-.5.9-1.1.9-.9 0-1.8-.4-2.5-.9v1.7c.7.3 1.4.5 2.2.5 1.7 0 2.9-.9 2.9-2.3C10.7 5.9 5.8 6.3 5.8 5.2z" fill="#fff"/></svg>
              Stripe
            </div>
          </div>
        </main>
      );
    }

    // ── Signup ────────────────────────────────────────────────────────────────
    return (
      <main className={styles.page}>
        <NavBar />
        {isDateFocused && <div className={styles.backdrop} />}
        <section className={styles.chatOnly} style={{ paddingTop: "3.2rem" }}>
          <div className={styles.signupCard}>
            <div className={styles.signupCardHeader}>
              <div className={styles.progressSteps}>
                <div className={`${styles.progressStep} ${styles.active}`}>
                  <div className={styles.progressStepDot}>1</div>
                  <span className={styles.progressStepLabel}>Your info</span>
                </div>
                <div className={styles.progressStep}>
                  <div className={styles.progressStepDot}>2</div>
                  <span className={styles.progressStepLabel}>Connect bank</span>
                </div>
                <div className={styles.progressStep}>
                  <div className={styles.progressStepDot}>3</div>
                  <span className={styles.progressStepLabel}>Get funded</span>
                </div>
              </div>
              <p className={styles.kicker}>Step 1 of 3</p>
              <h1>Tell us about yourself</h1>
              <p>Takes 2 minutes. Trusted by 700,000+ people. Never sold or shared.</p>
              <p style={{ marginTop: "0.6rem", fontSize: "1.3rem", color: "var(--brand)", fontWeight: 600 }}>
                🔒 No hard credit check — ever. Zero impact on your credit score.
              </p>
            </div>
            <div className={styles.signupCardBody}>
              <form className={styles.intakeComposer} onSubmit={handleSignupSubmit}>
                <div className={styles.intakeGrid}>
                  <label>
                    Full name
                    <input required value={form.name} placeholder="Jane Smith"
                      onChange={(event) => setForm({ ...form, name: event.target.value })} />
                  </label>
                  <label>
                    Email address
                    <input required type="email" value={form.email} placeholder="jane@example.com"
                      onChange={(event) => setForm({ ...form, email: event.target.value })} />
                  </label>
                  <label>
                    Phone number
                    <input required value={form.phone} placeholder="(555) 000-0000"
                      onChange={(event) => setForm({ ...form, phone: event.target.value })} />
                  </label>
                  <label>
                    Employer
                    <input required value={form.employer} placeholder="Acme Corp"
                      onChange={(event) => setForm({ ...form, employer: event.target.value })} />
                  </label>
                  <label>
                    Next payday <span style={{ color: "var(--muted)", fontWeight: 400 }}>(future dates only)</span>
                    <input required min={today} type="date" value={form.payday}
                      onFocus={() => setIsDateFocused(true)}
                      onBlur={() => setIsDateFocused(false)}
                      onChange={(event) => setForm({ ...form, payday: event.target.value })} />
                  </label>
                  <label>
                    SSN <span style={{ color: "var(--muted)", fontWeight: 400 }}>(last 4 digits only)</span>
                    <input required type="text" inputMode="numeric" maxLength={4}
                      pattern="[0-9]{4}" placeholder="1234"
                      value={form.ssn_last4}
                      onChange={(event) => {
                        const val = event.target.value.replace(/\D/g, "").slice(0, 4);
                        setForm({ ...form, ssn_last4: val });
                      }} />
                  </label>
                  <label>
                    Create a password
                    <input required type="password" minLength={6} placeholder="Min. 6 characters"
                      autoComplete="new-password"
                      value={form.password}
                      onChange={(event) => setForm({ ...form, password: event.target.value })} />
                  </label>
                  <label style={{ gridColumn: "1 / -1" }}>
                    Confirm password
                    <input required type="password" autoComplete="new-password"
                      value={form.confirmPassword}
                      onChange={(event) => setForm({ ...form, confirmPassword: event.target.value })} />
                  </label>
                </div>
                {error && <p className={styles.error}>{error}</p>}
                <div className={styles.intakeFooter}>
                  <button disabled={isBusy}>{isBusy ? "Creating account…" : "Continue →"}</button>
                </div>
              </form>
            </div>
          </div>
        </section>
      </main>
    );

  }

  // ── Benefits page (activate membership) ──────────────────────────────────
  if (!application.subscription_status) {
    return (
      <main className={styles.page}>
        <NavBar onLogout={handleLogout} />
        <div className={styles.benefitsHeader}>
          <p className={styles.benefitsHeaderKicker}>Advance Membership</p>
          <h1 className={styles.benefitsHeaderTitle}>Here's what you get.</h1>
          <p className={styles.benefitsHeaderSub}>A monthly cash advance with zero interest — and a lot more.</p>
        </div>
        <div className={styles.benefitsBody}>
          <div className={styles.benefitsGrid}>
            <div className={styles.benefitCard}>
              <span className={styles.benefitIcon}>💸</span>
              <p className={styles.benefitCardTitle}>Cash advance</p>
              <p className={styles.benefitCardSub}>No interest. No fees on the advance itself. Just money when you need it.</p>
            </div>
            <div className={styles.benefitCard}>
              <span className={styles.benefitIcon}>🚫</span>
              <p className={styles.benefitCardTitle}>No credit check</p>
              <p className={styles.benefitCardSub}>We never pull your credit. Zero impact on your credit score, ever.</p>
            </div>
            <div className={styles.benefitCard}>
              <span className={styles.benefitIcon}>🔒</span>
              <p className={styles.benefitCardTitle}>No bureau reporting</p>
              <p className={styles.benefitCardSub}>Your advance activity stays completely private — never reported to credit bureaus.</p>
            </div>
            <div className={styles.benefitCard}>
              <span className={styles.benefitIcon}>😌</span>
              <p className={styles.benefitCardTitle}>No stress</p>
              <p className={styles.benefitCardSub}>We don't chase you for repayment. Life happens — we get it.</p>
            </div>
            <div className={styles.benefitCard}>
              <span className={styles.benefitIcon}>⭐</span>
              <p className={styles.benefitCardTitle}>Earn points</p>
              <p className={styles.benefitCardSub}>Pay on time and earn points. Redeem them for a surprise gift — our treat.</p>
            </div>
            <div className={styles.benefitCard}>
              <span className={styles.benefitIcon}>🎰</span>
              <p className={styles.benefitCardTitle}>Weekly $300 raffle</p>
              <p className={styles.benefitCardSub}>Every on-time member is entered weekly. Miss or be late on a payment and you're frozen until you're back in good standing.</p>
            </div>
          </div>

          <div className={styles.usageBox}>
            <p className={styles.usageBoxTitle}>Usage limits · $1.99/month</p>
            <p className={styles.usageBoxText}>
              Your membership includes <strong>1 advance per month</strong> (12 per year). Need more? You can upgrade for unlimited access anytime.
            </p>
          </div>

          {error && <p className={styles.error}>{error}</p>}
          <button style={{ width: "100%" }} disabled={subBusy} onClick={activateSubscription}>
            {subBusy ? "Activating…" : "Continue →"}
          </button>
        </div>
        <StatesFooter />
      </main>
    );
  }

  // ── Authenticated application view ────────────────────────────────────────
  const needsBank = !application.plaid_connected;
  const needsCard = !application.stripe_card_saved &&
    (application.status === "approved" || application.status === "funded" || application.status === "repayment_scheduled");

  return (
    <main className={styles.page}>
      <NavBar onLogout={handleLogout} />

      {showDeliveryModal && (
        <div className={styles.modalBackdrop}>
          <div className={styles.modal}>
            <p className={styles.modalKicker}>You're approved! 🎉</p>
            <h2 className={styles.modalTitle}>
              Approved for a{" "}
              <span style={{ color: "var(--brand)" }}>${application.requested_amount} cash advance</span>
            </h2>
            <p style={{ color: "var(--muted)", marginBottom: "2.4rem" }}>
              How fast do you need your money?
            </p>
            <div className={styles.deliveryOptions}>
              <button
                type="button"
                className={`${styles.deliveryOption} ${deliveryChoice === "instant" ? styles.deliveryOptionSelected : ""}`}
                onClick={() => setDeliveryChoice("instant")}
              >
                <p className={styles.deliveryOptionBadge}>+$1 fee</p>
                <p className={styles.deliveryOptionTitle}>⚡ Instant</p>
                <p className={styles.deliveryOptionSub}>Money sent within minutes to your PayPal, CashApp, or Zelle.</p>
              </button>
              <button
                type="button"
                className={`${styles.deliveryOption} ${deliveryChoice === "standard" ? styles.deliveryOptionSelected : ""}`}
                onClick={() => setDeliveryChoice("standard")}
              >
                <p className={styles.deliveryOptionBadge}>Free</p>
                <p className={styles.deliveryOptionTitle}>📬 Standard</p>
                <p className={styles.deliveryOptionSub}>2–3 business days after approval. No extra charge.</p>
              </button>
            </div>
            {deliveryError && <p className={styles.error}>{deliveryError}</p>}
            <button
              disabled={deliveryBusy || !deliveryChoice}
              onClick={saveDelivery}
              style={{ width: "100%", marginTop: "2rem" }}
            >
              {deliveryBusy ? "Saving…" : "Continue →"}
            </button>
          </div>
        </div>
      )}

      <div className={styles.appCard}>
        <div className={styles.appCardPanel}>
          <div className={styles.appCardHeader}>
            <p className={styles.appCardKicker}>Your advance</p>
            <span className={styles.appCardStatusBadge}>{statusLabel[application.status]}</span>
          </div>
          <div className={styles.appCardBody}>
            <dl>
              <dt>Name</dt>
              <dd>{application.customer.name}</dd>
              <dt>Employer</dt>
              <dd>{application.customer.employer}</dd>
              <dt>Payday</dt>
              <dd>{application.payday}</dd>
              <dt>Delivery</dt>
              <dd>{application.delivery_type === "instant" ? "⚡ Instant" : "📬 Standard (2-3 days)"}</dd>
              <dt>Bank</dt>
              <dd>{application.plaid_connected ? "✓ Connected" : "Not connected"}</dd>
              {application.repayment && (
                <>
                  <dt>Repay by</dt>
                  <dd className={styles.dueDate}>{application.repayment.due_date}</dd>
                </>
              )}
            </dl>

            {needsBank && (
              <div className={styles.appCardAction}>
                <p><strong>Next step:</strong> connect your bank account so a reviewer can verify your income and approve your advance. Your bank account will also be used for automatic repayment via direct debit.</p>
                <button disabled={isBusy} onClick={connectBank}>
                  {isBusy ? "Connecting…" : "Connect bank account →"}
                </button>
              </div>
            )}

            {needsCard && (
              <div className={styles.appCardAction}>
                <p><strong>You're approved!</strong> Add a payment method so we can collect your repayment automatically on the due date.</p>
                <button onClick={() => window.location.href = "/loan"}>
                  Set up repayment →
                </button>
              </div>
            )}

            {application.status === "repaid" && (
              <p className={styles.paidNote}>✓ Repayment collected — thank you!</p>
            )}

            {!needsBank && !needsCard && application.status !== "repaid" && (
              <div className={styles.appCardAction}>
                <p>Your application is being reviewed. We'll update this page as soon as there's news — no action needed from you right now.</p>
              </div>
            )}

            {error && <p className={styles.error}>{error}</p>}
          </div>
        </div>
      </div>
    </main>
  );
};

// ── Admin app ─────────────────────────────────────────────────────────────────

const AdminApp = () => {
  const [adminToken, setAdminToken] = useState(
    () => sessionStorage.getItem(adminTokenStorageKey) || "",
  );
  const [tokenInput, setTokenInput] = useState(adminToken);
  const [applications, setApplications] = useState<Application[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [messageText, setMessageText] = useState("");
  const [snapshot, setSnapshot] = useState<BankSnapshot | null>(null);
  const [repaymentDate, setRepaymentDate] = useState(thirtyDaysFromNow);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selected = applications.find((application) => application.id === selectedId) || null;
  const adminHeaders = useMemo<Record<string, string>>(
    () => {
      const headers: Record<string, string> = {};
      if (adminToken) headers["x-admin-token"] = adminToken;
      return headers;
    },
    [adminToken],
  );

  const unlockAdmin = (event: React.FormEvent) => {
    event.preventDefault();
    sessionStorage.setItem(adminTokenStorageKey, tokenInput);
    setAdminToken(tokenInput);
  };

  const loadApplications = useCallback(async () => {
    const response = await fetch(apiUrl("/api/advance/admin/applications"), {
      headers: adminHeaders,
    });
    if (!response.ok) return;
    const data = await response.json();
    setApplications(data.applications);
    setSelectedId((current) => current || data.applications[0]?.id || null);
  }, [adminHeaders]);

  const loadMessages = useCallback(async (id: string) => {
    const response = await fetch(apiUrl(`/api/advance/applications/${id}/messages`));
    if (!response.ok) return;
    const data = await response.json();
    setMessages(data.messages);
  }, []);

  useEffect(() => {
    loadApplications();
    const interval = window.setInterval(loadApplications, 4000);
    return () => window.clearInterval(interval);
  }, [loadApplications]);

  useEffect(() => {
    if (!selectedId) return;
    loadMessages(selectedId);
    setSnapshot(null);
  }, [selectedId, loadMessages]);

  const sendAdminMessage = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected || !messageText.trim()) return;
    const text = messageText.trim();
    setMessageText("");
    await fetch(apiUrl(`/api/advance/applications/${selected.id}/messages`), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...adminHeaders },
      body: JSON.stringify({ sender: "admin", text }),
    });
    await loadMessages(selected.id);
  };

  const setStatus = async (status: Status, note?: string) => {
    if (!selected) return;
    setIsBusy(true);
    await fetch(apiUrl(`/api/advance/admin/applications/${selected.id}/status`), {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...adminHeaders },
      body: JSON.stringify({ status, note }),
    });
    await loadApplications();
    await loadMessages(selected.id);
    setIsBusy(false);
  };

  const loadBankSnapshot = async () => {
    if (!selected) return;
    setIsBusy(true);
    setError(null);
    try {
      const response = await fetch(apiUrl(`/api/advance/admin/applications/${selected.id}/bank_snapshot`), {
        headers: adminHeaders,
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.error_message || "Unable to load bank details");
      setSnapshot(data);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Unable to load bank details");
    } finally {
      setIsBusy(false);
    }
  };

  const scheduleRepayment = async () => {
    if (!selected) return;
    setIsBusy(true);
    await fetch(apiUrl(`/api/advance/admin/applications/${selected.id}/repayment`), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...adminHeaders },
      body: JSON.stringify({ amount: 25, due_date: repaymentDate }),
    });
    await loadApplications();
    await loadMessages(selected.id);
    setIsBusy(false);
  };

  const chargeCard = async () => {
    if (!selected) return;
    setIsBusy(true);
    setError(null);
    try {
      const res = await fetch(apiUrl(`/api/advance/admin/applications/${selected.id}/charge`), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...adminHeaders },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.error_message || "Charge failed");
      await loadApplications();
      await loadMessages(selected.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Charge failed");
    } finally {
      setIsBusy(false);
    }
  };

  return (
    <main className={styles.page}>
      {!adminToken && (
        <section className={styles.shell}>
          <div className={styles.intro}>
            <p className={styles.kicker}>Admin</p>
            <h1>Review console</h1>
            <p>Enter the admin token configured on the backend.</p>
          </div>
          <form className={styles.panel} onSubmit={unlockAdmin}>
            <label>
              Admin token
              <input
                type="password"
                value={tokenInput}
                onChange={(event) => setTokenInput(event.target.value)}
              />
            </label>
            <button>Open admin</button>
          </form>
        </section>
      )}
      {adminToken && (
        <section className={styles.adminLayout}>
          <aside className={styles.inbox}>
            <h1>Reviews</h1>
            {applications.map((application) => (
              <button
                key={application.id}
                className={application.id === selectedId ? styles.activeRow : styles.row}
                onClick={() => setSelectedId(application.id)}
              >
                <span>{application.customer.name || "Unnamed applicant"}</span>
                <small>{statusLabel[application.status]}</small>
              </button>
            ))}
          </aside>
          {selected ? (
            <section className={styles.review}>
              <div className={styles.reviewHeader}>
                <div>
                  <p className={styles.kicker}>Manual decision</p>
                  <h2>{selected.customer.name}</h2>
                  <p>
                    {selected.customer.email} · {selected.customer.phone}
                  </p>
                </div>
                <div className={styles.status}>{statusLabel[selected.status]}</div>
              </div>
              <div className={styles.reviewGrid}>
                <section className={styles.panel}>
                  <h3>Applicant</h3>
                  <dl>
                    <dt>Requested</dt>
                    <dd>{formatMoney(selected.requested_amount)}</dd>
                    <dt>Employer</dt>
                    <dd>{selected.customer.employer}</dd>
                    <dt>Payday</dt>
                    <dd>{selected.payday}</dd>
                    <dt>SSN last 4</dt>
                    <dd>{selected.customer.ssn_last4 || "—"}</dd>
                    <dt>Plaid</dt>
                    <dd>{selected.plaid_connected ? "Connected" : "Waiting"}</dd>
                  </dl>
                  <div className={styles.actions}>
                    <button disabled={isBusy} onClick={loadBankSnapshot}>Load bank details</button>
                    <button
                      disabled={isBusy}
                      onClick={() =>
                        setStatus(
                          "approved",
                          "Congrats, you are approved for a cash advance. To send the funds manually, please reply with: routing number, account number, checking or savings, and the legal name on the account. Do not send your online banking password.",
                        )
                      }
                    >
                      Approve
                    </button>
                    <button disabled={isBusy} onClick={() => setStatus("denied", "We are unable to approve this advance right now.")}>Deny</button>
                    <button disabled={isBusy} onClick={() => setStatus("funded", "Your advance has been sent.")}>Mark funded</button>
                  </div>
                  {(selected.payout_methods || selected.payout_contact) && (
                    <div className={styles.repayment}>
                      <h4 style={{ margin: "0 0 0.8rem", fontSize: "1.4rem" }}>Payout preference</h4>
                      {selected.payout_methods && (
                        <p style={{ margin: "0 0 0.4rem", fontSize: "1.4rem" }}>
                          <strong>Method:</strong> {selected.payout_methods}
                        </p>
                      )}
                      {selected.payout_contact && (
                        <p style={{ margin: 0, fontSize: "1.4rem" }}>
                          <strong>Contact:</strong> {selected.payout_contact}
                        </p>
                      )}
                    </div>
                  )}
                  <div className={styles.repayment}>
                    <label>
                      Repayment due date (30 days from funding)
                      <input
                        type="date"
                        min={today}
                        value={repaymentDate}
                        onChange={(event) => setRepaymentDate(event.target.value)}
                      />
                    </label>
                    <button disabled={isBusy} onClick={scheduleRepayment}>Record repayment schedule</button>
                    {selected.stripe_card_saved && (
                      <button disabled={isBusy} onClick={chargeCard} style={{ marginTop: "0.6rem" }}>
                        {isBusy ? "Charging…" : "Charge card now"}
                      </button>
                    )}
                    {!selected.stripe_card_saved && (
                      <p className={styles.muted} style={{ marginTop: "0.6rem" }}>No card on file — customer must save one via their loan dashboard.</p>
                    )}
                  </div>
                  {error && <p className={styles.error}>{error}</p>}
                </section>
                <section className={styles.panel}>
                  <h3>Bank snapshot</h3>
                  {!snapshot ? (
                    <p className={styles.muted}>Load bank details after the applicant connects Plaid.</p>
                  ) : (
                    <BankSnapshotView snapshot={snapshot} />
                  )}
                </section>
              </div>
              <section className={styles.chat}>
                <header>
                  <h3>Chat</h3>
                </header>
                <MessageList messages={messages} />
                <form className={styles.composer} onSubmit={sendAdminMessage}>
                  <input
                    placeholder="Reply to applicant…"
                    value={messageText}
                    onChange={(event) => setMessageText(event.target.value)}
                  />
                  <button>Send</button>
                </form>
              </section>
            </section>
          ) : (
            <section className={styles.empty}>No applications yet.</section>
          )}
        </section>
      )}
    </main>
  );
};

// ── Message list ──────────────────────────────────────────────────────────────

const MessageList = ({ messages }: { messages: Message[] }) => (
  <div className={styles.messages}>
    {messages.map((message) => (
      <div key={message.id} className={`${styles.message} ${styles[message.sender]}`}>
        <span>
          {message.sender === "customer" ? "You" : message.sender === "admin" ? "Support" : "Notice"}
        </span>
        <div className={styles.messageBubble}>
          <p>{message.text}</p>
        </div>
      </div>
    ))}
  </div>
);

// ── Bank snapshot view ────────────────────────────────────────────────────────

const BankSnapshotView = ({ snapshot }: { snapshot: BankSnapshot }) => {
  const [nameQuery, setNameQuery] = useState("");
  const [amountQuery, setAmountQuery] = useState("");

  const allTx = snapshot.transactions;
  const filtered = allTx.filter(
    tx => fuzzyMatch(nameQuery, tx.description) && amountMatch(amountQuery, Math.abs(tx.amount) / 100)
  );

  return (
    <div className={styles.snapshot}>
      <h4>Accounts</h4>
      {snapshot.accounts.map((account) => (
        <div key={account.id} className={styles.account}>
          <strong>{account.display_name}</strong>
          <span>{account.institution_name} · {account.category} · ···{account.last4 || "—"}</span>
          {account.balance && (
            <>
              <span>Available {formatMoney((account.balance.available ?? 0) / 100)}</span>
              <span>Current {formatMoney((account.balance.current ?? 0) / 100)}</span>
            </>
          )}
        </div>
      ))}
      <h4>All transactions</h4>
      {allTx.length === 0 && (
        <p style={{ color: "#c0392b", fontWeight: 600, fontSize: "1.35rem" }}>
          No transactions returned — check server logs (subscribe/refresh may be pending)
        </p>
      )}
      <div className={styles.searchRow}>
        <label>
          Search by description
          <input
            placeholder="e.g. employer name…"
            value={nameQuery}
            onChange={(e) => setNameQuery(e.target.value)}
          />
        </label>
        <label>
          Filter by amount (±25%)
          <input
            type="number"
            min="0"
            placeholder="e.g. 2000"
            value={amountQuery}
            onChange={(e) => setAmountQuery(e.target.value)}
          />
        </label>
      </div>
      <p className={styles.muted}>{filtered.length} of {allTx.length} transaction{allTx.length !== 1 ? "s" : ""}</p>
      {filtered.length === 0 && allTx.length > 0 ? (
        <p className={styles.muted}>No matching transactions.</p>
      ) : (
        filtered.map((tx) => (
          <div key={tx.id} className={styles.incomingTransaction}>
            <span>{tx.date}</span>
            <strong>{tx.description}</strong>
            <span className={tx.amount > 0 ? styles.incomingAmount : styles.outgoingAmount}>
              {tx.amount > 0 ? "+" : ""}{formatMoney(tx.amount / 100)}
            </span>
          </div>
        ))
      )}
    </div>
  );
};

// ── Loan (returning borrower) app ─────────────────────────────────────────────

const LoanApp = () => {
  const [token, setToken] = useState(() => localStorage.getItem(userTokenStorageKey) || "");
  const [loginForm, setLoginForm] = useState({ email: "", password: "" });
  const [application, setApplication] = useState<Application | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [payoffDone, setPayoffDone] = useState(false);
  const [payoutMethods, setPayoutMethods] = useState<string[]>([]);
  const [payoutContact, setPayoutContact] = useState("");
  const [payoutSaved, setPayoutSaved] = useState(false);
  const [payoutBusy, setPayoutBusy] = useState(false);
  const [payoutError, setPayoutError] = useState<string | null>(null);

  const authHeaders = useMemo<Record<string, string>>(
    (): Record<string, string> => (token ? { Authorization: `Bearer ${token}` } : {}),
    [token],
  );

  const loadMe = useCallback(async (hdrs: Record<string, string>) => {
    const res = await fetch(apiUrl("/api/advance/auth/me"), { headers: hdrs });
    if (!res.ok) { setToken(""); localStorage.removeItem(userTokenStorageKey); return; }
    const data = await res.json();
    setApplication(data.application);
    setMessages(data.messages);
  }, []);

  useEffect(() => {
    if (token) loadMe({ Authorization: `Bearer ${token}` });
  }, [token, loadMe]);

  useEffect(() => {
    if (!token || !application) return;
    const interval = window.setInterval(() => loadMe(authHeaders), 6000);
    return () => window.clearInterval(interval);
  }, [token, application, authHeaders, loadMe]);

  useEffect(() => {
    if (application?.payout_methods) setPayoutMethods(application.payout_methods.split(','));
    if (application?.payout_contact) setPayoutContact(application.payout_contact);
    if (application?.payout_methods && application?.payout_contact) setPayoutSaved(true);
  }, [application?.payout_methods, application?.payout_contact]);

  const togglePayoutMethod = (method: string) => {
    setPayoutMethods(prev => prev.includes(method) ? prev.filter(m => m !== method) : [...prev, method]);
    setPayoutSaved(false);
  };

  const submitPayoutPreference = async () => {
    if (payoutMethods.length === 0) { setPayoutError("Please select at least one payout method"); return; }
    if (!payoutContact.trim()) { setPayoutError("Please enter your username, email, or phone number"); return; }
    setPayoutBusy(true);
    setPayoutError(null);
    try {
      const res = await fetch(apiUrl(`/api/advance/applications/${application!.id}/payout-preference`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify({ methods: payoutMethods.join(','), contact: payoutContact.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.error_message || "Unable to save preference");
      setApplication(data.application);
      setPayoutSaved(true);
    } catch (e) {
      setPayoutError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setPayoutBusy(false);
    }
  };

  const login = async (event: React.FormEvent) => {
    event.preventDefault();
    setIsBusy(true);
    setError(null);
    try {
      const res = await fetch(apiUrl("/api/advance/auth/login"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(loginForm),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.error_message || "Login failed");
      localStorage.setItem(userTokenStorageKey, data.token);
      setToken(data.token);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Login failed");
    } finally {
      setIsBusy(false);
    }
  };

  const payoff = async () => {
    if (!application) return;
    setIsBusy(true);
    setError(null);
    try {
      const res = await fetch(apiUrl(`/api/advance/applications/${application.id}/payoff`), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.error_message || "Unable to process payoff");
      setApplication(data.application);
      setMessages(data.messages);
      setPayoffDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setIsBusy(false);
    }
  };

  const logout = () => {
    localStorage.removeItem(userTokenStorageKey);
    setToken("");
    setApplication(null);
    setMessages([]);
    setPayoffDone(false);
  };

  if (!token || !application) {
    return (
      <main className={styles.page}>
        <NavBar />
        <section className={styles.chatOnly} style={{ paddingTop: "4rem" }}>
          <div className={styles.signupCard} style={{ maxWidth: "46rem", margin: "0 auto" }}>
            <div className={styles.signupCardHeader}>
              <p className={styles.kicker}>Returning borrower</p>
              <h1>Welcome back.</h1>
              <p>Sign in to manage your advance and repayment.</p>
            </div>
            <div className={styles.signupCardBody}>
              <form className={styles.intakeComposer} onSubmit={login}>
                <label>
                  Email address
                  <input required type="email" value={loginForm.email} placeholder="jane@example.com"
                    onChange={(e) => setLoginForm({ ...loginForm, email: e.target.value })} />
                </label>
                <label>
                  Password
                  <input required type="password" value={loginForm.password} placeholder="Your password"
                    onChange={(e) => setLoginForm({ ...loginForm, password: e.target.value })} />
                </label>
                {error && <p className={styles.error}>{error}</p>}
                <button disabled={isBusy} style={{ width: "100%" }}>{isBusy ? "Signing in…" : "Sign in"}</button>
                <p style={{ textAlign: "center", margin: 0, fontSize: "1.35rem", color: "var(--muted)" }}>
                  Don't have an account?{" "}
                  <a href="/" style={{ color: "var(--brand)", fontWeight: 700 }}>Apply now — it's free</a>
                </p>
              </form>
            </div>
          </div>
        </section>
      </main>
    );
  }

  const rep = application.repayment;
  const canPayoff = !!rep && rep.status === "pending" &&
    (application.status === "repayment_scheduled" || application.status === "funded");

  return (
    <main className={styles.page}>
      <NavBar onLogout={logout} />
      <section className={styles.chatOnly}>
        <section className={styles.loanDashboard}>
          <div className={styles.loanHeader}>
            <div>
              <p className={styles.kicker}>Your loan</p>
              <h2>{application.customer.name}</h2>
              <p>{application.customer.email}</p>
              <p style={{ marginTop: "0.4rem", fontSize: "1.4rem", color: "var(--muted)" }}>
                Approved for a <strong style={{ color: "var(--brand)" }}>$25 cash advance</strong>
              </p>
            </div>
            <div className={styles.loanHeaderRight}>
              <div className={styles.status}>{statusLabel[application.status]}</div>
            </div>
          </div>

          <div className={styles.loanGrid}>
            <section className={styles.panel}>
              <h3>Loan details</h3>
              <dl>
                <dt>Employer</dt><dd>{application.customer.employer}</dd>
                <dt>Payday</dt><dd>{application.payday}</dd>
                <dt>Bank</dt><dd>{application.plaid_connected ? "Connected" : "Not connected"}</dd>
              </dl>
            </section>

            <section className={styles.panel}>
              <h3>Repayment</h3>
              {application.status === "repaid" ? (
                <p className={styles.paidNote}>Repayment collected — thank you!</p>
              ) : application.stripe_card_saved ? (
                <>
                  {rep && (
                    <dl>
                      <dt>Due date</dt><dd className={styles.dueDate}>{rep.due_date}</dd>
                      <dt>Status</dt><dd>{rep.status === "paid" ? "Paid" : "Pending"}</dd>
                    </dl>
                  )}
                  <p className={styles.paidNote}>Bank account saved — repayment will be collected via direct debit on the due date.</p>
                  {(application.status === "approved" || application.status === "funded" || application.status === "repayment_scheduled") && (
                    <details style={{ marginTop: "1.6rem" }}>
                      <summary style={{ fontSize: "1.35rem", color: "var(--muted)", cursor: "pointer", fontWeight: 600 }}>
                        Prefer to pay by card instead?
                      </summary>
                      <div style={{ marginTop: "1.2rem" }}>
                        {!stripeKey ? (
                          <p className={styles.error}>Card payments are not configured yet.</p>
                        ) : (
                          <Elements stripe={stripePromise}>
                            <SaveCardForm
                              applicationId={application.id}
                              authToken={token}
                              onSaved={() => loadMe({ Authorization: `Bearer ${token}` })}
                            />
                          </Elements>
                        )}
                      </div>
                    </details>
                  )}
                </>
              ) : (application.status === "approved" || application.status === "funded" || application.status === "repayment_scheduled") ? (
                <>
                  <p><strong>Set up repayment.</strong> Save a card and we'll automatically collect your repayment on the due date.</p>
                  {!stripeKey ? (
                    <p className={styles.error}>Card payments are not configured yet. Please contact support.</p>
                  ) : (
                    <Elements stripe={stripePromise}>
                      <SaveCardForm
                        applicationId={application.id}
                        authToken={token}
                        onSaved={() => loadMe({ Authorization: `Bearer ${token}` })}
                      />
                    </Elements>
                  )}
                </>
              ) : (
                <p className={styles.muted}>No repayment scheduled yet. A reviewer will reach out once your advance is funded.</p>
              )}
              {error && <p className={styles.error}>{error}</p>}

              {(application.status === "approved" || application.status === "funded" || application.status === "repayment_scheduled" || application.status === "repaid") && (
                <div style={{ marginTop: "2rem", borderTop: "1px solid var(--border)", paddingTop: "1.6rem" }}>
                  <p style={{ fontWeight: 700, marginBottom: "0.8rem", color: "var(--ink)" }}>How should we send you the money?</p>
                  <p style={{ fontSize: "1.35rem", color: "var(--muted)", marginBottom: "1.2rem" }}>Select one or more and enter your contact info.</p>
                  <div style={{ display: "flex", gap: "0.8rem", flexWrap: "wrap" }}>
                    {["PayPal", "CashApp", "Zelle"].map(method => (
                      <button
                        key={method}
                        type="button"
                        onClick={() => togglePayoutMethod(method)}
                        style={{
                          padding: "0.8rem 1.6rem",
                          borderRadius: "var(--pill)",
                          border: `2px solid ${payoutMethods.includes(method) ? "var(--brand)" : "var(--border)"}`,
                          background: payoutMethods.includes(method) ? "var(--brand-tint2)" : "var(--white)",
                          color: payoutMethods.includes(method) ? "var(--brand)" : "var(--ink-2)",
                          fontWeight: 600,
                          fontSize: "1.4rem",
                          cursor: "pointer",
                        }}
                      >
                        {method}
                      </button>
                    ))}
                  </div>
                  <label style={{ display: "block", marginTop: "1.2rem" }}>
                    <span style={{ fontSize: "1.35rem", fontWeight: 600, color: "var(--ink-2)", display: "block", marginBottom: "0.4rem" }}>
                      {payoutMethods.length === 1 ? `Your ${payoutMethods[0]} username / email / phone` : "Your username, email, or phone number"}
                    </span>
                    <input
                      value={payoutContact}
                      placeholder="e.g. @username or email@example.com"
                      onChange={e => { setPayoutContact(e.target.value); setPayoutSaved(false); }}
                    />
                  </label>
                  {payoutError && <p className={styles.error}>{payoutError}</p>}
                  {payoutSaved && <p className={styles.paidNote}>✓ Payout preference saved!</p>}
                  <button disabled={payoutBusy} onClick={submitPayoutPreference} style={{ marginTop: "1.2rem" }}>
                    {payoutBusy ? "Saving…" : "Submit"}
                  </button>
                </div>
              )}
            </section>
          </div>
        </section>
      </section>
    </main>
  );
};

// ── Save card form ────────────────────────────────────────────────────────────

const SaveCardForm = ({
  applicationId,
  authToken,
  onSaved,
}: {
  applicationId: string;
  authToken: string;
  onSaved: () => void;
}) => {
  const stripe = useStripe();
  const elements = useElements();
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!stripe || !elements) return;
    setIsBusy(true);
    setError(null);
    try {
      const res = await fetch(apiUrl(`/api/advance/applications/${applicationId}/stripe/setup-intent`), {
        method: "POST",
        headers: { Authorization: `Bearer ${authToken}` },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.error_message || "Could not start card setup");

      const cardElement = elements.getElement(CardElement);
      if (!cardElement) throw new Error("Card element not found");

      const result = await stripe.confirmCardSetup(data.client_secret, {
        payment_method: { card: cardElement },
      });

      if (result.error) throw new Error(result.error.message);

      const paymentMethodId = result.setupIntent.payment_method as string;
      const saveRes = await fetch(
        apiUrl(`/api/advance/applications/${applicationId}/stripe/save-payment-method`),
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
          body: JSON.stringify({ payment_method_id: paymentMethodId }),
        },
      );
      if (!saveRes.ok) throw new Error("Could not save card");
      setDone(true);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setIsBusy(false);
    }
  };

  if (done) return <p className={styles.paidNote}>Card saved — we'll charge it automatically on the due date.</p>;

  return (
    <form onSubmit={handleSubmit}>
      <div className={styles.cardElementWrap}>
        <CardElement options={{ hidePostalCode: true }} />
      </div>
      {error && <p className={styles.error}>{error}</p>}
      <button disabled={isBusy || !stripe}>{isBusy ? "Saving…" : "Save card"}</button>
    </form>
  );
};

// ── States footer ─────────────────────────────────────────────────────────────

const StatesFooter = () => (
  <div className={styles.statesFooter}>
    <p className={styles.statesFooterTitle}>Available states only</p>
    <p>Arkansas · Louisiana · Arizona · Montana · Nevada · Missouri · Wisconsin · Kansas · South Carolina · Utah · Indiana</p>
  </div>
);


export default App;

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { loadStripe } from "@stripe/stripe-js";
import { Elements, CardElement, useStripe, useElements } from "@stripe/react-stripe-js";
import { usePlaidLink } from "react-plaid-link";

import { apiUrl } from "./api";
import styles from "./App.module.css";
import TermsPage from "./TermsPage";
import PrivacyPage from "./PrivacyPage";

const stripeKey = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY || "";
const stripePromise = stripeKey ? loadStripe(stripeKey) : null;

type Status =
  | "intake"
  | "bank_connected"
  | "reviewing"
  | "approved"
  | "denied"
  | "expired"
  | "funded"
  | "repayment_scheduled"
  | "repaid"
  | "repayment_failed"
  | "written_off";

interface IncomeSource {
  id: number | null;
  employer: string;
  payday: string;
  pay_frequency: string;
  accrued_cents?: number | null;
  days_elapsed?: number;
  period_days?: number;
  avg_paycheck_cents?: number;
  matched_tx_count?: number;
  error?: string;
}

interface Application {
  id: string;
  customer: {
    name: string;
    email: string;
    phone: string;
    employer: string;
    ssn_last4: string | null;
    pay_frequency: string | null;
    state: string | null;
    dob: string | null;
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
  repayment_count: number;
  offer_expires_at: string | null;
  referral_code: string | null;
  referred_by: string | null;
  limit_freeze_until: string | null;
  income_sources: Array<Pick<IncomeSource, "id" | "employer" | "payday" | "pay_frequency">>;
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
    routing_number: string | null;
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
    pfc: string | null;
    status: "wage_income" | "excluded" | "uncertain" | "outgoing";
    reason: "pfc" | "keyword" | "ai" | "refund" | null;
    ai_classified: boolean;
  }>;
  income_sources: IncomeSource[];
  total_accrued_cents: number;
  auth: unknown;
}

const US_STATES = [
  "Alabama", "Alaska", "Arizona", "Arkansas", "California", "Colorado",
  "Connecticut", "Delaware", "Florida", "Georgia", "Hawaii", "Idaho",
  "Illinois", "Indiana", "Iowa", "Kansas", "Kentucky", "Louisiana",
  "Maine", "Maryland", "Massachusetts", "Michigan", "Minnesota",
  "Mississippi", "Missouri", "Montana", "Nebraska", "Nevada",
  "New Hampshire", "New Jersey", "New Mexico", "New York",
  "North Carolina", "North Dakota", "Ohio", "Oklahoma", "Oregon",
  "Pennsylvania", "Rhode Island", "South Carolina", "South Dakota",
  "Tennessee", "Texas", "Utah", "Vermont", "Virginia", "Washington",
  "West Virginia", "Wisconsin", "Wyoming",
];

const ELIGIBLE_STATES = new Set(["Georgia", "Utah"]);
const ADVANCE_TIERS = [25, 50, 75, 100, 150, 200];

const applicationStorageKey = "advance_application_id";
const userTokenStorageKey = "advance_user_token";
const adminTokenStorageKey = "advance_admin_token";

const statusLabel: Record<Status, string> = {
  intake: "Intake",
  bank_connected: "Bank connected",
  reviewing: "Reviewing",
  approved: "Approved",
  denied: "Denied",
  expired: "Offer expired",
  funded: "Funded",
  repayment_scheduled: "Repayment scheduled",
  repaid: "Repaid",
  repayment_failed: "Repayment failed",
  written_off: "Written off",
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
  if (path === "/terms") return <TermsPage />;
  if (path === "/privacy") return <PrivacyPage />;
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
    dob: "",
    income_sources: [{ employer: "", payday: "", pay_frequency: "", pay_frequency_other: "" }],
    ssn: "",
    state: "",
    password: "",
    confirmPassword: "",
    referralCode: "",
  });
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<"landing" | "referral" | "signup">("landing");
  const [gateCode, setGateCode] = useState("");
  const [gateValid, setGateValid] = useState<boolean | null>(null);
  const [gateReferrerName, setGateReferrerName] = useState<string | null>(null);
  const [gateBusy, setGateBusy] = useState(false);
  const [isDateFocused, setIsDateFocused] = useState(false);
  const [token, setToken] = useState<string>(() => localStorage.getItem(userTokenStorageKey) || "");
  const [showDeliveryModal, setShowDeliveryModal] = useState(false);
  const [deliveryChoice, setDeliveryChoice] = useState<"instant" | "standard" | null>(null);
  const [deliveryBusy, setDeliveryBusy] = useState(false);
  const [deliveryError, setDeliveryError] = useState<string | null>(null);
  const [trustScreenSeen, setTrustScreenSeen] = useState(false);
  const [reapplyBusy, setReapplyBusy] = useState(false);
  const [codeCopied, setCodeCopied] = useState(false);

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
      trustScreenSeen &&
      (application.status === "approved" || application.status === "funded" || application.status === "repayment_scheduled")
    ) {
      setShowDeliveryModal(true);
    } else {
      setShowDeliveryModal(false);
    }
  }, [application?.delivery_type, application?.status, trustScreenSeen]);



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

  const handleReapply = async () => {
    if (!application) return;
    setReapplyBusy(true);
    setError(null);
    try {
      const res = await fetch(apiUrl(`/api/advance/applications/${application.id}/reapply`), {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.error_message || "Could not reapply");
      setApplication(data.application);
      setTrustScreenSeen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setReapplyBusy(false);
    }
  };

  const handleSignupSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!form.dob) {
      setError("Please enter your date of birth");
      return;
    }
    const dob = new Date(form.dob);
    const today = new Date();
    const age = today.getFullYear() - dob.getFullYear() - (
      today < new Date(today.getFullYear(), dob.getMonth(), dob.getDate()) ? 1 : 0
    );
    if (age < 18) {
      setError("You must be at least 18 years old to apply.");
      return;
    }
    if (form.ssn.replace(/-/g, "").length !== 9) {
      setError("Please enter your full 9-digit Social Security Number");
      return;
    }
    for (const [i, src] of form.income_sources.entries()) {
      const label = form.income_sources.length > 1 ? ` (source ${i + 1})` : "";
      if (!src.pay_frequency) { setError(`Please select how often you get paid${label}`); return; }
      if (src.pay_frequency === "other" && !src.pay_frequency_other.trim()) { setError(`Please describe your pay schedule${label}`); return; }
    }
    if (!form.state) {
      setError("Please select your state");
      return;
    }
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
      const { confirmPassword, income_sources: rawSources, ssn, referralCode: _rc, ...rest } = form;
      const normalizedGateCode = gateCode.trim().toLowerCase().replace(/\s+/g, '');
      const body = {
        ...rest,
        ssn: ssn.replace(/-/g, ""),
        income_sources: rawSources.map(({ pay_frequency_other, pay_frequency, ...s }) => ({
          ...s,
          pay_frequency: pay_frequency === "other" ? pay_frequency_other.trim() : pay_frequency,
        })),
        requested_amount: 25,
        ...(normalizedGateCode ? { referral_code: normalizedGateCode } : {}),
      };
      const response = await fetch(apiUrl("/api/advance/applications"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.error_message || "Unable to start application");
      localStorage.setItem(applicationStorageKey, data.application.id);
      if (data.token) {
        localStorage.setItem(userTokenStorageKey, data.token);
        setToken(data.token);
      }
      setApplication(data.application);
      // Add to Mailchimp waitlist if state isn't live yet and no referral bypass
      if (form.state && !ELIGIBLE_STATES.has(form.state) && !normalizedGateCode) {
        fetch(apiUrl("/api/waitlist"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: form.name, email: form.email, state: form.state }),
        }).catch(() => {});
      }
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Something went wrong");
    } finally {
      setIsBusy(false);
    }
  };

  const updateSource = (i: number, field: string, value: string) =>
    setForm(f => { const s = [...f.income_sources]; s[i] = { ...s[i], [field]: value }; return { ...f, income_sources: s }; });
  const addSource = () =>
    setForm(f => ({ ...f, income_sources: [...f.income_sources, { employer: "", payday: "", pay_frequency: "", pay_frequency_other: "" }] }));
  const removeSource = (i: number) =>
    setForm(f => ({ ...f, income_sources: f.income_sources.filter((_, idx) => idx !== i) }));

  const [plaidLinkToken, setPlaidLinkToken] = useState<string | null>(null);
  const [plaidLinkError, setPlaidLinkError] = useState<string | null>(null);

  const fetchPlaidLinkToken = () => {
    if (!application || application.plaid_connected) return;
    setPlaidLinkError(null);
    fetch(apiUrl(`/api/advance/applications/${application.id}/plaid/link-token`), {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.json())
      .then(d => {
        if (d.link_token) {
          setPlaidLinkToken(d.link_token);
        } else {
          setPlaidLinkError(d.error?.error_message || "Could not load bank connection. Please try again.");
        }
      })
      .catch(() => setPlaidLinkError("Could not load bank connection. Please try again."));
  };

  useEffect(() => {
    fetchPlaidLinkToken();
  }, [application?.id, application?.plaid_connected, token]);


  // ── Landing ──────────────────────────────────────────────────────────────────
  if (!application) {
    if (view === "landing") {
      return (
        <main className={styles.page}>
          <NavBar
            onGetStarted={() => setView("referral")}
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
                  Connect your bank, get a decision today, and pay it back on your next payday. That's it.
                </p>
                <div className={styles.heroActions}>
                  <button className={styles.btnWhite} onClick={() => setView("referral")}>
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
              <span className={styles.trustStatNum}>0%</span>
              <span className={styles.trustStatLabel}>Interest — repay<br />on your payday</span>
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

    // ── Referral gate ────────────────────────────────────────────────────────
    if (view === "referral") {
      return (
        <main className={styles.page}>
          <NavBar />
          <div className={styles.benefitsHeader} style={{ paddingBottom: "5.6rem" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "4rem", maxWidth: "80rem", margin: "0 auto", flexWrap: "wrap" }}>
              <div style={{ flex: "1 1 32rem", textAlign: "left" }}>
                <p className={styles.benefitsHeaderKicker}>Invite-only early access</p>
                <h1 className={styles.benefitsHeaderTitle} style={{ marginBottom: "1.6rem" }}>
                  You got the hook-up?
                </h1>
                <p className={styles.benefitsHeaderSub}>
                  Advance is growing through word of mouth. Enter your invite code below to get started.
                </p>
              </div>
              <div style={{ flexShrink: 0, opacity: 0.92 }}>
                <AlienMascot flag="usa" size={160} />
              </div>
            </div>
          </div>
          <div className={styles.benefitsBody} style={{ maxWidth: "48rem", margin: "0 auto" }}>
            <div style={{ marginBottom: "2rem" }}>
              <label style={{ fontSize: "1.5rem", fontWeight: 600, display: "block", marginBottom: "0.8rem", color: "var(--ink)" }}>
                Enter your invite code
              </label>
              <div style={{ position: "relative" }}>
                <input
                  type="text"
                  placeholder="Enter your code"
                  autoComplete="off"
                  value={gateCode}
                  onChange={(e) => { setGateCode(e.target.value); setGateValid(null); setError(null); }}
                  onKeyDown={(e) => e.key === "Enter" && document.getElementById("gate-continue")?.click()}
                  style={{ width: "100%", fontSize: "1.6rem", padding: "1.2rem 1.4rem", borderRadius: "var(--r-sm)", border: `1.5px solid ${gateValid === false ? "#dc2626" : gateValid === true ? "#16a34a" : "var(--border)"}` }}
                />
                {gateValid === true && (
                  <span style={{ position: "absolute", right: "1.2rem", top: "50%", transform: "translateY(-50%)", fontSize: "1.3rem", color: "#16a34a", fontWeight: 600, pointerEvents: "none" }}>
                    ✓ {gateReferrerName ? `Referred by ${gateReferrerName}` : "Code accepted"}
                  </span>
                )}
              </div>
              {gateValid === false && (
                <p style={{ fontSize: "1.3rem", color: "#dc2626", marginTop: "0.6rem" }}>
                  That code isn't recognized. Check with whoever referred you and try again.
                </p>
              )}
            </div>
            {error && <p className={styles.error}>{error}</p>}
            <button
              id="gate-continue"
              style={{ width: "100%" }}
              disabled={!gateCode.trim() || gateBusy}
              onClick={async () => {
                const code = gateCode.trim().toLowerCase().replace(/\s+/g, '');
                if (!code) return;
                setGateBusy(true);
                setError(null);
                try {
                  const res = await fetch(apiUrl(`/api/advance/referral/${encodeURIComponent(code)}`));
                  const data = await res.json();
                  setGateValid(data.valid);
                  setGateReferrerName(data.valid ? data.referrer_name : null);
                  if (data.valid) {
                    setForm(f => ({ ...f, referralCode: code }));
                    setView("signup");
                  }
                } catch {
                  setError("Could not verify code. Please try again.");
                } finally {
                  setGateBusy(false);
                }
              }}
            >
              {gateBusy ? "Checking…" : "Continue →"}
            </button>
            <p style={{ fontSize: "1.3rem", color: "var(--muted)", marginTop: "1.6rem", textAlign: "center" }}>
              Already have an account?{" "}
              <a href="/loan" style={{ color: "var(--brand)", fontWeight: 600 }}>Sign in →</a>
            </p>
          </div>
          <StatesFooter />
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
                    Date of birth
                    <input required type="date" value={form.dob}
                      max={new Date(new Date().setFullYear(new Date().getFullYear() - 18)).toISOString().slice(0, 10)}
                      onChange={(event) => setForm({ ...form, dob: event.target.value })} />
                  </label>
                  <div style={{ gridColumn: "1 / -1", display: "flex", flexDirection: "column", gap: "1rem" }}>
                    {form.income_sources.map((src, i) => (
                      <div key={i} style={{ border: "1.5px solid var(--border)", borderRadius: "var(--r-sm)", padding: "1.2rem 1.4rem", display: "flex", flexDirection: "column", gap: "1rem" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                          <strong style={{ fontSize: "1.4rem" }}>
                            {form.income_sources.length > 1 ? `Income source ${i + 1}` : "Income source"}
                          </strong>
                          {form.income_sources.length > 1 && (
                            <button type="button" onClick={() => removeSource(i)}
                              style={{ fontSize: "1.2rem", color: "var(--muted)", background: "none", border: "none", cursor: "pointer", padding: 0 }}>
                              Remove
                            </button>
                          )}
                        </div>
                        <label>
                          Employer
                          <input required value={src.employer} placeholder="Acme Corp"
                            onChange={e => updateSource(i, "employer", e.target.value)} />
                        </label>
                        <label>
                          Next payday <span style={{ color: "var(--muted)", fontWeight: 400 }}>(future dates only)</span>
                          <input required min={today} type="date" value={src.payday}
                            onChange={e => updateSource(i, "payday", e.target.value)} />
                        </label>
                        <label>
                          How often do you get paid?
                          <select required value={src.pay_frequency}
                            onChange={e => updateSource(i, "pay_frequency", e.target.value)}
                            style={{ display: "block", width: "100%", padding: "1rem 1.2rem", borderRadius: "var(--r-sm)", border: "1.5px solid var(--border)", fontSize: "1.5rem", background: "var(--white)", color: src.pay_frequency ? "var(--ink)" : "var(--muted)", appearance: "auto" }}>
                            <option value="" disabled>Select frequency…</option>
                            <option value="weekly">Weekly</option>
                            <option value="biweekly">Biweekly</option>
                            <option value="semimonthly">Semi-monthly</option>
                            <option value="monthly">Monthly</option>
                            <option value="daily">Daily</option>
                            <option value="other">Other</option>
                          </select>
                        </label>
                        {src.pay_frequency === "other" && (
                          <label>
                            Describe your pay schedule
                            <input required type="text" placeholder="e.g. every Friday, on the 1st and 15th…"
                              value={src.pay_frequency_other}
                              onChange={e => updateSource(i, "pay_frequency_other", e.target.value)} />
                          </label>
                        )}
                      </div>
                    ))}
                    <button type="button" onClick={addSource}
                      style={{ alignSelf: "flex-start", fontSize: "1.3rem", background: "none", border: "1.5px solid var(--border)", borderRadius: "var(--r-sm)", padding: "0.6rem 1.2rem", cursor: "pointer" }}>
                      + Add another income source
                    </button>
                  </div>
                  <label>
                    State
                    <select
                      required
                      value={form.state}
                      onChange={(e) => setForm({ ...form, state: e.target.value })}
                      style={{ display: "block", width: "100%", padding: "1rem 1.2rem", borderRadius: "var(--r-sm)", border: "1.5px solid var(--border)", fontSize: "1.5rem", background: "var(--white)", color: form.state ? "var(--ink)" : "var(--muted)", appearance: "auto" }}
                    >
                      <option value="" disabled>Select state…</option>
                      {US_STATES.map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </label>
                  <label style={{ gridColumn: "1 / -1" }}>
                    Social Security Number
                    <input
                      required
                      type="text"
                      inputMode="numeric"
                      autoComplete="off"
                      placeholder="XXX-XX-XXXX"
                      value={(() => {
                        const d = form.ssn.replace(/-/g, "");
                        if (d.length > 5) return `${d.slice(0,3)}-${d.slice(3,5)}-${d.slice(5)}`;
                        if (d.length > 3) return `${d.slice(0,3)}-${d.slice(3)}`;
                        return d;
                      })()}
                      onChange={(e) => {
                        const digits = e.target.value.replace(/\D/g, "").slice(0, 9);
                        setForm({ ...form, ssn: digits });
                      }}
                    />
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
                <p style={{ fontSize: "1.25rem", color: "var(--muted)", margin: "1.2rem 0 0.8rem", lineHeight: 1.6 }}>
                  By creating an account, you agree to our{" "}
                  <a href="/terms" target="_blank" rel="noopener noreferrer" style={{ color: "var(--brand)", fontWeight: 600 }}>
                    Terms &amp; Conditions
                  </a>
                  . We never pull your credit and we will never send your account to collections.
                </p>
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

  // ── Waitlist screen (non-eligible state — cannot proceed past here) ─────────
  if (application.subscription_status === 'waitlisted') {
    const stateName = application.customer.state || "your state";
    return (
      <main className={styles.page}>
        <NavBar onLogout={handleLogout} />

        {/* Hero band */}
        <div className={styles.benefitsHeader} style={{ paddingBottom: "5.6rem" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "4rem", maxWidth: "80rem", margin: "0 auto", flexWrap: "wrap" }}>
            <div style={{ flex: "1 1 32rem", textAlign: "left" }}>
              <p className={styles.benefitsHeaderKicker}>You're in line</p>
              <h1 className={styles.benefitsHeaderTitle} style={{ marginBottom: "1.6rem" }}>
                We're coming to<br />{stateName}!
              </h1>
              <p className={styles.benefitsHeaderSub}>
                Advance is live in Georgia and Utah today. We're expanding state by state — {stateName} is on the roadmap.
                You'll get an email the moment we go live.
              </p>
            </div>
            <div style={{ flexShrink: 0, opacity: 0.92 }}>
              <AlienMascot flag="usa" size={180} />
            </div>
          </div>
        </div>

        {/* Body */}
        <div className={styles.benefitsBody}>
          {/* Confirmation card */}
          <div style={{
            background: "var(--brand-tint)", border: "1.5px solid var(--brand-tint2)",
            borderRadius: "var(--r-lg)", padding: "2.4rem 2.8rem", marginBottom: "3.2rem",
            display: "flex", alignItems: "center", gap: "1.6rem", flexWrap: "wrap",
          }}>
            <span style={{ fontSize: "2.4rem" }}>✅</span>
            <div>
              <p style={{ fontSize: "1.5rem", fontWeight: 700, color: "var(--ink)", marginBottom: "0.2rem" }}>
                You're confirmed
              </p>
              <p style={{ fontSize: "1.4rem", color: "var(--muted)", margin: 0 }}>
                We'll email <strong style={{ color: "var(--ink)" }}>{application.customer.email}</strong> as soon as Advance launches in {stateName}.
              </p>
            </div>
          </div>

          {/* What to expect cards */}
          <div className={styles.benefitsGrid} style={{ marginBottom: "3.2rem" }}>
            {[
              { icon: "🚫", title: "No credit check, ever", sub: "We won't pull your credit now or when we launch. Your score is safe." },
              { icon: "💸", title: "Instant access at launch", sub: "When we go live in your state, you'll skip the line — your account is ready to go." },
              { icon: "🔒", title: "Your data is safe", sub: "We've stored your information securely. We will never sell it or share it with advertisers." },
              { icon: "🎰", title: "Weekly $300 raffle", sub: "Once Advance is live in your state, you'll be automatically entered in our weekly cash raffle." },
            ].map(({ icon, title, sub }) => (
              <div key={title} className={styles.benefitCard}>
                <span className={styles.benefitIcon}>{icon}</span>
                <p className={styles.benefitCardTitle}>{title}</p>
                <p className={styles.benefitCardSub}>{sub}</p>
              </div>
            ))}
          </div>

          {/* Contact */}
          <div style={{ textAlign: "center", color: "var(--muted)", fontSize: "1.4rem" }}>
            Questions? Reach us at{" "}
            <a href="mailto:usa@getbits.app" style={{ color: "var(--brand)", fontWeight: 600 }}>usa@getbits.app</a>
          </div>
        </div>

        <StatesFooter />
      </main>
    );
  }

  // ── Denied screen (shown instead of raw "Denied" status) ────────────────────
  if (application.status === 'denied') {
    return (
      <main className={styles.page}>
        <NavBar onLogout={handleLogout} />

        {/* Hero band */}
        <div className={styles.benefitsHeader} style={{ paddingBottom: "5.6rem" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "4rem", maxWidth: "80rem", margin: "0 auto", flexWrap: "wrap" }}>
            <div style={{ flex: "1 1 32rem", textAlign: "left" }}>
              <p className={styles.benefitsHeaderKicker}>Application update</p>
              <h1 className={styles.benefitsHeaderTitle} style={{ marginBottom: "1.6rem" }}>
                Not quite ready<br />yet.
              </h1>
              <p className={styles.benefitsHeaderSub}>
                We weren't able to approve your advance at this time — but this isn't permanent.
                Many members get approved on a second try once their income history builds up.
              </p>
            </div>
            <div style={{ flexShrink: 0, opacity: 0.92 }}>
              <AlienMascot flag="usa" size={180} />
            </div>
          </div>
        </div>

        {/* Body */}
        <div className={styles.benefitsBody}>
          {/* Reassurance card */}
          <div style={{
            background: "var(--brand-tint)", border: "1.5px solid var(--brand-tint2)",
            borderRadius: "var(--r-lg)", padding: "2.4rem 2.8rem", marginBottom: "3.2rem",
            display: "flex", alignItems: "center", gap: "1.6rem", flexWrap: "wrap",
          }}>
            <span style={{ fontSize: "2.4rem" }}>💌</span>
            <div>
              <p style={{ fontSize: "1.5rem", fontWeight: 700, color: "var(--ink)", marginBottom: "0.2rem" }}>
                No mark on your credit
              </p>
              <p style={{ fontSize: "1.4rem", color: "var(--muted)", margin: 0 }}>
                We never reported anything to any credit bureau. Your score is exactly where it was.
              </p>
            </div>
          </div>

          {/* What typically helps */}
          <div className={styles.benefitsGrid} style={{ marginBottom: "3.2rem" }}>
            {[
              { icon: "📅", title: "Consistent deposit history", sub: "A few more pay cycles showing regular deposits can make a big difference. Try again in 30–60 days." },
              { icon: "🏦", title: "Keep your bank connected", sub: "Your account is still active. When you're ready to reapply, your bank connection will still be in place." },
              { icon: "🚫", title: "No collections, ever", sub: "We'll never refer you to a debt collector, sell your information, or file a lawsuit — unconditionally." },
              { icon: "📩", title: "Get in touch", sub: "If you think this was a mistake or have questions, email us. We review every message personally." },
            ].map(({ icon, title, sub }) => (
              <div key={title} className={styles.benefitCard}>
                <span className={styles.benefitIcon}>{icon}</span>
                <p className={styles.benefitCardTitle}>{title}</p>
                <p className={styles.benefitCardSub}>{sub}</p>
              </div>
            ))}
          </div>

          {/* Reapply */}
          <button
            style={{ width: "100%", marginBottom: "1.6rem" }}
            disabled={reapplyBusy}
            onClick={handleReapply}
          >
            {reapplyBusy ? "Resubmitting…" : "Reapply →"}
          </button>
          {error && <p className={styles.error} style={{ textAlign: "center" }}>{error}</p>}
          <div style={{ textAlign: "center", color: "var(--muted)", fontSize: "1.4rem" }}>
            Questions? Email{" "}
            <a href="mailto:usa@getbits.app" style={{ color: "var(--brand)", fontWeight: 600 }}>usa@getbits.app</a>
          </div>
        </div>

        <StatesFooter />
      </main>
    );
  }

  // ── Approval trust screen (shown once before delivery choice) ───────────────
  if (
    application.status === "approved" &&
    !application.delivery_type &&
    !trustScreenSeen
  ) {
    const milestones = [
      { amount: "$25", label: "1st advance", current: true },
      { amount: "$50", label: "2nd advance", current: false },
      { amount: "$75", label: "3rd advance", current: false },
      { amount: "$100", label: "4th advance", current: false },
      { amount: "$150", label: "5th advance", current: false },
      { amount: "$200", label: "6th+", current: false },
    ];
    return (
      <main className={styles.page}>
        <NavBar onLogout={handleLogout} />

        {/* Hero band */}
        <div className={styles.benefitsHeader} style={{ paddingBottom: "5.6rem" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "4rem", maxWidth: "80rem", margin: "0 auto", flexWrap: "wrap" }}>
            <div style={{ flex: "1 1 32rem", textAlign: "left" }}>
              <p className={styles.benefitsHeaderKicker}>You're approved</p>
              <h1 className={styles.benefitsHeaderTitle} style={{ marginBottom: "1.6rem" }}>
                $25 is on<br />its way. 🎉
              </h1>
              <p className={styles.benefitsHeaderSub}>
                Your first advance is <strong>$25</strong>. Pay it back on time and your limit grows — all the way up to $200.
              </p>
            </div>
            <div style={{ flexShrink: 0, opacity: 0.92 }}>
              <AlienMascot flag="usa" size={180} />
            </div>
          </div>
        </div>

        {/* Body */}
        <div className={styles.benefitsBody}>

          {/* Expiry notice */}
          {application.offer_expires_at && (() => {
            const exp = new Date(application.offer_expires_at);
            const timeStr = exp.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", timeZoneName: "short" });
            return (
              <div style={{
                background: "#fffbeb", border: "1.5px solid #fde68a",
                borderRadius: "var(--r-lg)", padding: "1.6rem 2rem", marginBottom: "2.4rem",
                display: "flex", alignItems: "center", gap: "1.2rem",
              }}>
                <span style={{ fontSize: "2rem" }}>⏰</span>
                <p style={{ fontSize: "1.4rem", color: "#78350f", margin: 0, lineHeight: 1.6 }}>
                  <strong>This offer expires tonight at {timeStr}.</strong> If you don't choose a delivery method before then, your offer will be cancelled and you'll need to reapply.
                </p>
              </div>
            );
          })()}

          {/* Trust explanation */}
          <div style={{
            background: "var(--brand-tint)", border: "1.5px solid var(--brand-tint2)",
            borderRadius: "var(--r-lg)", padding: "2.4rem 2.8rem", marginBottom: "3.2rem",
          }}>
            <p style={{ fontSize: "1.6rem", fontWeight: 700, color: "var(--ink)", marginBottom: "0.8rem" }}>
              How trust-building works
            </p>
            <p style={{ fontSize: "1.4rem", color: "var(--muted)", lineHeight: 1.7, margin: 0 }}>
              Every on-time repayment earns you a higher limit on your next advance. We start small because we're just getting to know each other — but the more history we build together, the more we can offer you.
            </p>
          </div>

          {/* Milestone ladder */}
          <p style={{ fontSize: "1.35rem", fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: "1.6rem" }}>
            Your advance limit roadmap
          </p>
          <div style={{ display: "flex", gap: "1rem", marginBottom: "3.2rem", overflowX: "auto", paddingBottom: "0.4rem" }}>
            {milestones.map((m, i) => (
              <div
                key={m.amount}
                style={{
                  flex: "1 0 9rem",
                  background: m.current ? "var(--brand)" : "var(--white)",
                  border: m.current ? "none" : "1.5px solid var(--border)",
                  borderRadius: "var(--r-lg)",
                  padding: "1.8rem 1.2rem",
                  textAlign: "center",
                  position: "relative",
                  opacity: m.current ? 1 : 0.55 + i * 0.07,
                }}
              >
                {m.current && (
                  <span style={{
                    position: "absolute", top: "-1.2rem", left: "50%", transform: "translateX(-50%)",
                    background: "#fbbf24", color: "#78350f", fontSize: "1.05rem", fontWeight: 700,
                    padding: "0.2rem 0.8rem", borderRadius: "99px", whiteSpace: "nowrap",
                  }}>
                    You are here
                  </span>
                )}
                <p style={{
                  fontSize: "2rem", fontWeight: 800, margin: "0 0 0.4rem",
                  color: m.current ? "white" : "var(--ink)",
                }}>
                  {m.amount}
                </p>
                <p style={{
                  fontSize: "1.15rem", color: m.current ? "rgba(255,255,255,0.75)" : "var(--muted)",
                  margin: 0,
                }}>
                  {m.label}
                </p>
              </div>
            ))}
          </div>

          {/* What happens next cards */}
          <div className={styles.benefitsGrid} style={{ marginBottom: "3.2rem" }}>
            {[
              { icon: "📅", title: "Repay on payday", sub: "Your advance is automatically due on your next payday. Repay on time to unlock a higher limit." },
              { icon: "🚫", title: "No credit bureau reporting", sub: "We never report anything to any credit bureau — good or bad. Your score is always safe." },
              { icon: "🔄", title: "No rollover, no interest", sub: "This isn't a loan. There's zero interest and you can't roll over your balance. Just pay back what you got." },
              { icon: "🛡️", title: "We never chase you", sub: "If repayment fails, we write it off. No collections, no lawsuits, no debt buyers — ever." },
            ].map(({ icon, title, sub }) => (
              <div key={title} className={styles.benefitCard}>
                <span className={styles.benefitIcon}>{icon}</span>
                <p className={styles.benefitCardTitle}>{title}</p>
                <p className={styles.benefitCardSub}>{sub}</p>
              </div>
            ))}
          </div>

          <button
            style={{ width: "100%" }}
            onClick={() => setTrustScreenSeen(true)}
          >
            Choose how to receive my $25 →
          </button>
        </div>

        <StatesFooter />
      </main>
    );
  }

  // ── Authenticated application view ────────────────────────────────────────
  const needsBank = !application.plaid_connected;
  // Bank verifies income via Plaid; card is required for repayment
  const needsCard = application.plaid_connected && !application.stripe_card_saved &&
    (application.status === "approved" || application.status === "funded" || application.status === "repayment_scheduled");

  return (
    <main className={styles.page}>
      <NavBar onLogout={handleLogout} />

      {showDeliveryModal && (
        <div className={styles.modalBackdrop}>
          <div className={styles.modal}>
            <p className={styles.modalKicker}>How fast do you need it?</p>
            <h2 className={styles.modalTitle}>
              Receive your{" "}
              <span style={{ color: "var(--brand)" }}>${application.requested_amount} advance</span>
            </h2>
            <p style={{ color: "var(--muted)", marginBottom: "0.8rem" }}>
              Repayment due on your payday: <strong style={{ color: "var(--ink)" }}>{application.payday}</strong>
            </p>
            <p style={{ color: "var(--muted)", marginBottom: "2.4rem" }}>
              How fast do you need your money?
            </p>
            <div className={styles.deliveryOptions}>
              <button
                type="button"
                className={`${styles.deliveryOption} ${deliveryChoice === "instant" ? styles.deliveryOptionSelected : ""}`}
                onClick={() => setDeliveryChoice("instant")}
              >
                <p className={styles.deliveryOptionBadge}>+$5 fee</p>
                <p className={styles.deliveryOptionTitle}>⚡ Instant</p>
                <p className={styles.deliveryOptionSub}>Money sent within minutes to your PayPal, CashApp, or Zelle. $5 fee added to repayment — nothing charged now.</p>
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
              <dt>Employer{(application.income_sources?.length ?? 0) > 1 ? "s" : ""}</dt>
              <dd>{(application.income_sources?.length > 0 ? application.income_sources.map(s => s.employer) : [application.customer.employer]).join(", ") || "—"}</dd>
              <dt>Next payday</dt>
              <dd>{application.income_sources?.[0]?.payday ?? application.payday}</dd>
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
                <p><strong>Next step:</strong> connect your bank account via Plaid. This verifies your income so we can review your application.</p>
                {plaidLinkToken ? (
                  <PlaidConnectButton
                    linkToken={plaidLinkToken}
                    applicationId={application.id}
                    authToken={token}
                    onConnected={(app) => { setApplication(app); setPlaidLinkToken(null); loadMessages(app.id); }}
                    onError={(msg) => setError(msg)}
                  />
                ) : plaidLinkError ? (
                  <div>
                    <p style={{ color: "var(--error, #c0392b)", marginBottom: "0.8rem", fontSize: "1.4rem" }}>{plaidLinkError}</p>
                    <button onClick={fetchPlaidLinkToken}>Retry →</button>
                  </div>
                ) : (
                  <button disabled>Loading…</button>
                )}
              </div>
            )}

            {needsCard && (
              <div className={styles.appCardAction}>
                <p><strong>You're approved!</strong> Set up your repayment method via your loan dashboard.</p>
                <button onClick={() => window.location.href = "/loan"}>
                  Set up repayment →
                </button>
              </div>
            )}

            {/* ── Post-setup dashboard ───────────────────────────────── */}
            {!needsBank && !needsCard && (() => {
              const now = new Date();
              const dueDate = application.repayment?.due_date
                ? new Date(application.repayment.due_date + "T00:00:00")
                : null;
              const daysUntilDue = dueDate
                ? Math.max(0, Math.ceil((dueDate.getTime() - now.getTime()) / 86400000))
                : null;
              const canReapplyAt = (() => {
                if (["expired", "denied"].includes(application.status)) return null;
                if (dueDate) { const d = new Date(dueDate); d.setDate(d.getDate() + 1); return d; }
                return null;
              })();
              const daysUntilReapply = canReapplyAt
                ? Math.max(0, Math.ceil((canReapplyAt.getTime() - now.getTime()) / 86400000))
                : 0;
              const canReapplyNow = !canReapplyAt || canReapplyAt <= now;
              const freezeDate = application.limit_freeze_until
                ? new Date(application.limit_freeze_until + "T00:00:00") : null;
              const isFrozen = !!(freezeDate && freezeDate > now);
              const nextTierAmount = isFrozen
                ? ADVANCE_TIERS[Math.max(0, application.repayment_count - 1)]
                : ADVANCE_TIERS[Math.min(application.repayment_count, ADVANCE_TIERS.length - 1)];

              // Active loan
              if (["funded", "repayment_scheduled"].includes(application.status)) {
                return (
                  <div style={{ marginTop: "1.6rem" }}>
                    <div style={{ display: "flex", gap: "1.2rem", flexWrap: "wrap" }}>
                      <div style={{
                        flex: "1 1 14rem", background: "var(--brand)", color: "white",
                        borderRadius: "var(--r-lg)", padding: "2rem",
                      }}>
                        <p style={{ fontSize: "1.15rem", opacity: 0.75, marginBottom: "0.4rem", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em" }}>Due in</p>
                        <p style={{ fontSize: "3.2rem", fontWeight: 800, margin: "0 0 0.2rem" }}>{daysUntilDue ?? "—"}</p>
                        <p style={{ fontSize: "1.3rem", opacity: 0.8, margin: 0 }}>{dueDate ? `days · ${dueDate.toLocaleDateString([], { month: "short", day: "numeric" })}` : "days"}</p>
                      </div>
                      <div style={{
                        flex: "1 1 14rem", background: "var(--brand-tint)", border: "1.5px solid var(--brand-tint2)",
                        borderRadius: "var(--r-lg)", padding: "2rem",
                      }}>
                        <p style={{ fontSize: "1.15rem", color: "var(--muted)", marginBottom: "0.4rem", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em" }}>Reapply in</p>
                        <p style={{ fontSize: "3.2rem", fontWeight: 800, color: "var(--ink)", margin: "0 0 0.2rem" }}>{daysUntilReapply}</p>
                        <p style={{ fontSize: "1.3rem", color: "var(--muted)", margin: 0 }}>days after repayment</p>
                      </div>
                    </div>
                    <p style={{ fontSize: "1.3rem", color: "var(--muted)", marginTop: "1.2rem", lineHeight: 1.6 }}>
                      Repay on time to unlock your next advance of <strong style={{ color: "var(--ink)" }}>${nextTierAmount}</strong>. No interest, no late fees, and we never report anything to credit bureaus.
                    </p>
                  </div>
                );
              }

              // Cooldown — repaid but not yet eligible
              if (!canReapplyNow) {
                return (
                  <div style={{ marginTop: "1.6rem" }}>
                    <div style={{
                      background: "var(--brand-tint)", border: "1.5px solid var(--brand-tint2)",
                      borderRadius: "var(--r-lg)", padding: "2rem", textAlign: "center",
                    }}>
                      <p style={{ fontSize: "1.15rem", color: "var(--muted)", marginBottom: "0.4rem", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em" }}>Next advance unlocks in</p>
                      <p style={{ fontSize: "4rem", fontWeight: 800, color: "var(--ink)", margin: "0 0 0.4rem" }}>{daysUntilReapply}</p>
                      <p style={{ fontSize: "1.4rem", color: "var(--muted)", margin: 0 }}>days · eligible for <strong style={{ color: "var(--ink)" }}>${nextTierAmount}</strong></p>
                    </div>
                    <p style={{ fontSize: "1.3rem", color: "var(--muted)", marginTop: "1.2rem" }}>
                      ✓ Repayment collected — thank you! Your next advance will be ready {canReapplyAt?.toLocaleDateString([], { month: "long", day: "numeric" })}.
                    </p>
                  </div>
                );
              }

              // Can reapply now (expired, denied handled by full screens, repaid + cooldown over)
              if (["reviewing", "intake", "bank_connected"].includes(application.status)) {
                return (
                  <div className={styles.appCardAction}>
                    <p>Your application is being reviewed. We'll update this page as soon as there's news — no action needed from you right now.</p>
                  </div>
                );
              }

              // Expired or repaid + cooldown over → reapply
              return (
                <div style={{ marginTop: "1.6rem" }}>
                  {application.status === "repaid" && (
                    <p className={styles.paidNote}>✓ Repayment collected — thank you!</p>
                  )}
                  {application.status === "expired" && (
                    <p style={{ fontSize: "1.4rem", color: "var(--muted)", marginBottom: "1.2rem", lineHeight: 1.6 }}>
                      Your previous offer expired before you chose a delivery method. Nothing was charged — you can reapply right now.
                    </p>
                  )}
                  <div style={{
                    background: "var(--brand-tint)", border: "1.5px solid var(--brand-tint2)",
                    borderRadius: "var(--r-lg)", padding: "1.6rem 2rem", marginBottom: "1.6rem",
                    display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "1.2rem",
                  }}>
                    <div>
                      <p style={{ fontSize: "1.5rem", fontWeight: 700, color: "var(--ink)", marginBottom: "0.2rem" }}>
                        Ready for your next advance
                      </p>
                      <p style={{ fontSize: "1.35rem", color: "var(--muted)", margin: 0 }}>
                        You're eligible for <strong style={{ color: "var(--brand)" }}>${nextTierAmount}</strong>
                        {application.repayment_count > 0 && ` — up from your last advance`}
                      </p>
                    </div>
                    <button
                      disabled={reapplyBusy}
                      onClick={handleReapply}
                      style={{ whiteSpace: "nowrap" }}
                    >
                      {reapplyBusy ? "Submitting…" : `Apply for $${nextTierAmount} →`}
                    </button>
                  </div>
                </div>
              );
            })()}

            {/* ── Freeze warning ─────────────────────────────────────── */}
            {application.limit_freeze_until && (() => {
              const fd = new Date(application.limit_freeze_until + "T00:00:00");
              if (fd <= new Date()) return null;
              const frozenAmount = ADVANCE_TIERS[Math.max(0, application.repayment_count - 1)];
              return (
                <div style={{
                  background: "#fef3c7", border: "1.5px solid #fcd34d",
                  borderRadius: "var(--r-lg)", padding: "1.6rem 2rem", marginTop: "1.2rem",
                }}>
                  <p style={{ fontSize: "1.4rem", fontWeight: 700, color: "#92400e", marginBottom: "0.4rem" }}>
                    ⏸ Limit progression paused
                  </p>
                  <p style={{ fontSize: "1.35rem", color: "#92400e", margin: 0, lineHeight: 1.6 }}>
                    A user you referred didn't repay their first advance. Your next advance stays at <strong>${frozenAmount}</strong> until <strong>{fd.toLocaleDateString([], { month: "long", day: "numeric", year: "numeric" })}</strong>.
                  </p>
                </div>
              );
            })()}

            {/* ── Referral code card — shown only after first advance ── */}
            {application.referral_code && application.delivery_type && (
              <div style={{
                background: "var(--brand-tint)", border: "1.5px solid var(--brand-tint2)",
                borderRadius: "var(--r-lg)", padding: "1.6rem 2rem", marginTop: "1.2rem",
              }}>
                <p style={{ fontSize: "1.15rem", fontWeight: 700, color: "var(--muted)", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: "0.4rem" }}>
                  Your referral code
                </p>
                <div style={{ display: "flex", alignItems: "center", gap: "1.2rem", flexWrap: "wrap", marginBottom: "1rem" }}>
                  <code style={{ fontSize: "2rem", fontWeight: 800, color: "var(--brand)", letterSpacing: "0.04em" }}>
                    {application.referral_code}
                  </code>
                  <button
                    type="button"
                    onClick={() => {
                      navigator.clipboard.writeText(application.referral_code!);
                      setCodeCopied(true);
                      setTimeout(() => setCodeCopied(false), 2000);
                    }}
                    style={{ fontSize: "1.25rem", padding: "0.5rem 1.2rem" }}
                  >
                    {codeCopied ? "Copied!" : "Copy"}
                  </button>
                </div>
                <p style={{ fontSize: "1.35rem", color: "var(--ink-2)", lineHeight: 1.65 }}>
                  Share this code with friends so they can get early access to Advance. Every person you refer who gets their first advance earns you <strong>an extra entry</strong> into the weekly $300 raffle.
                </p>
                <p style={{ fontSize: "1.25rem", color: "#b45309", marginTop: "0.8rem", lineHeight: 1.6, background: "#fffbeb", borderRadius: "var(--r-sm)", padding: "0.8rem 1rem" }}>
                  Heads up: if someone you refer doesn't repay their first advance on time, it will make it harder for you to unlock higher credit limits going forward.
                </p>
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
  const [isSnapshotLoading, setIsSnapshotLoading] = useState(false);
  const [pmDetails, setPmDetails] = useState<{ bank_name: string; routing_number: string; last4: string; account_type: string } | null>(null);
  const [repaymentDate, setRepaymentDate] = useState(thirtyDaysFromNow);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [referralStats, setReferralStats] = useState<{
    total: number; got_advance: number; repaid: number; defaulted: number; active: number;
    referred: Array<{ id: string; name: string; email: string; status: string; repayment_count: number; got_advance: boolean; created_at: string }>;
  } | null>(null);

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

  const loadBankSnapshot = useCallback(async (id: string) => {
    setIsSnapshotLoading(true);
    setError(null);
    try {
      const response = await fetch(apiUrl(`/api/advance/admin/applications/${id}/bank_snapshot`), {
        headers: adminHeaders,
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.error_message || "Unable to load bank details");
      setSnapshot(data);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Unable to load bank details");
    } finally {
      setIsSnapshotLoading(false);
    }
  }, [adminHeaders]);

  useEffect(() => {
    loadApplications();
    const interval = window.setInterval(loadApplications, 4000);
    return () => window.clearInterval(interval);
  }, [loadApplications]);

  useEffect(() => {
    if (!selectedId) return;
    loadMessages(selectedId);
    setSnapshot(null);
    setPmDetails(null);
    setReferralStats(null);
    loadBankSnapshot(selectedId);
    if (selected?.payday) setRepaymentDate(selected.payday);
    // Load referral analytics for this applicant
    fetch(apiUrl(`/api/advance/admin/applications/${selectedId}/referrals`), { headers: adminHeaders })
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data) setReferralStats(data); })
      .catch(() => {});
  }, [selectedId, loadMessages, loadBankSnapshot, adminHeaders]);

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

  const loadPaymentMethodDetails = async () => {
    if (!selected) return;
    setIsBusy(true);
    setError(null);
    try {
      const res = await fetch(apiUrl(`/api/advance/admin/applications/${selected.id}/payment-method-details`), { headers: adminHeaders });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.error_message || "Unable to load bank details");
      setPmDetails(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to load bank details");
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
                <small style={{ color: "var(--muted)", fontSize: "1.2rem" }}>
                  {new Date(application.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                </small>
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
                    <dt>Income sources</dt>
                    <dd>
                      {(selected.income_sources?.length > 0 ? selected.income_sources : [{ employer: selected.customer.employer, payday: selected.payday, pay_frequency: selected.customer.pay_frequency }]).map((src, i) => (
                        <div key={i} style={{ marginBottom: "0.4rem" }}>
                          <strong>{src.employer || "—"}</strong>
                          <span style={{ color: "var(--muted)", fontSize: "1.2rem" }}> · {src.payday} · {src.pay_frequency || "—"}</span>
                        </div>
                      ))}
                    </dd>
                    <dt>Est. accrued income</dt>
                    <dd>
                      {isSnapshotLoading ? (
                        <span style={{ color: "var(--muted)" }}>Calculating…</span>
                      ) : snapshot ? (
                        <span style={{ fontSize: "1.6rem", fontWeight: 700 }}>
                          {snapshot.total_accrued_cents > 0
                            ? formatMoney(snapshot.total_accrued_cents / 100)
                            : <span style={{ color: "var(--muted)", fontWeight: 400 }}>Insufficient data</span>}
                        </span>
                      ) : (
                        <span style={{ color: "var(--muted)" }}>—</span>
                      )}
                    </dd>
                    <dt>Date of birth</dt>
                    <dd>{selected.customer.dob || "—"}</dd>
                    <dt>SSN last 4</dt>
                    <dd>{selected.customer.ssn_last4 || "—"}</dd>
                    <dt>State</dt>
                    <dd>{selected.customer.state || "—"}</dd>
                    <dt>Bank / direct debit</dt>
                    <dd>{selected.plaid_connected ? "✓ Connected" : "Waiting"}</dd>
                    <dt>Backup card</dt>
                    <dd>{selected.stripe_card_saved ? "✓ On file" : "None"}</dd>
                    <dt>Referral code</dt>
                    <dd>{selected.referral_code || "—"}</dd>
                    {selected.referred_by && <><dt>Referred by</dt><dd>{selected.referred_by}</dd></>}
                    {selected.limit_freeze_until && <><dt>Limit freeze</dt><dd>Until {selected.limit_freeze_until}</dd></>}
                  </dl>
                  <div className={styles.actions}>
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
                    <button disabled={isBusy} style={{ background: "#dc2626", borderColor: "#dc2626" }} onClick={() => { if (confirm("Write off this advance? If the user was referred and this is their first advance, the referrer's limit progression will be frozen for 3 months.")) setStatus("written_off"); }}>Write off</button>
                  </div>
                  {(selected.payout_methods || selected.payout_contact) && (
                    <div className={styles.repayment}>
                      <h4 style={{ margin: "0 0 0.8rem", fontSize: "1.4rem" }}>Payout preference</h4>
                      {selected.payout_methods && (
                        <p style={{ margin: "0 0 0.4rem", fontSize: "1.4rem" }}>
                          <strong>Method:</strong> {selected.payout_methods}
                        </p>
                      )}
                      {selected.payout_methods?.includes("Bank transfer") ? (
                        pmDetails ? (
                          <dl style={{ margin: "0.8rem 0 0", fontSize: "1.35rem" }}>
                            <dt>Bank</dt><dd>{pmDetails.bank_name}</dd>
                            <dt>Routing</dt><dd>{pmDetails.routing_number}</dd>
                            <dt>Account</dt><dd>···{pmDetails.last4} ({pmDetails.account_type})</dd>
                          </dl>
                        ) : (
                          <button disabled={isBusy} onClick={loadPaymentMethodDetails} style={{ marginTop: "0.6rem" }}>
                            View routing details
                          </button>
                        )
                      ) : (
                        selected.payout_contact && (
                          <p style={{ margin: 0, fontSize: "1.4rem" }}>
                            <strong>Contact:</strong> {selected.payout_contact}
                          </p>
                        )
                      )}
                    </div>
                  )}
                  <div className={styles.repayment}>
                    <label>
                      Repayment due date (defaults to payday)
                      <input
                        type="date"
                        min={today}
                        value={repaymentDate}
                        onChange={(event) => setRepaymentDate(event.target.value)}
                      />
                    </label>
                    <button disabled={isBusy} onClick={scheduleRepayment}>Record repayment schedule</button>
                    {(selected.plaid_connected || selected.stripe_card_saved) ? (
                      <button disabled={isBusy} onClick={chargeCard} style={{ marginTop: "0.6rem" }}>
                        {isBusy ? "Processing…" : "Collect repayment now"}
                      </button>
                    ) : (
                      <p className={styles.muted} style={{ marginTop: "0.6rem" }}>No payment method on file yet.</p>
                    )}
                  </div>
                  {error && <p className={styles.error}>{error}</p>}
                </section>
                <section className={styles.panel}>
                  <h3>Referral tree</h3>
                  {!referralStats ? (
                    <p className={styles.muted}>Loading…</p>
                  ) : referralStats.total === 0 ? (
                    <p className={styles.muted}>No referrals yet.{selected.referral_code ? ` Code: ${selected.referral_code}` : ''}</p>
                  ) : (
                    <>
                      <div style={{ display: "flex", gap: "0.8rem", flexWrap: "wrap", marginBottom: "1.4rem" }}>
                        {[
                          { label: "Referred", value: referralStats.total, color: "var(--brand)" },
                          { label: "Got advance", value: referralStats.got_advance, color: "#16a34a" },
                          { label: "Repaid", value: referralStats.repaid, color: "#16a34a" },
                          { label: "Active", value: referralStats.active, color: "#2563eb" },
                          { label: "Defaulted", value: referralStats.defaulted, color: "#dc2626" },
                        ].map(({ label, value, color }) => (
                          <div key={label} style={{ background: "var(--surface)", border: "1.5px solid var(--border)", borderRadius: "var(--r-sm)", padding: "0.8rem 1.2rem", textAlign: "center", minWidth: "7rem" }}>
                            <p style={{ fontSize: "2rem", fontWeight: 800, color, margin: 0 }}>{value}</p>
                            <p style={{ fontSize: "1.15rem", color: "var(--muted)", margin: 0 }}>{label}</p>
                          </div>
                        ))}
                      </div>
                      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "1.3rem" }}>
                        <thead>
                          <tr style={{ borderBottom: "1.5px solid var(--border)" }}>
                            <th style={{ textAlign: "left", padding: "0.4rem 0.6rem", color: "var(--muted)", fontWeight: 600 }}>Name</th>
                            <th style={{ textAlign: "left", padding: "0.4rem 0.6rem", color: "var(--muted)", fontWeight: 600 }}>Status</th>
                            <th style={{ textAlign: "center", padding: "0.4rem 0.6rem", color: "var(--muted)", fontWeight: 600 }}>Repayments</th>
                            <th style={{ textAlign: "center", padding: "0.4rem 0.6rem", color: "var(--muted)", fontWeight: 600 }}>Advance</th>
                          </tr>
                        </thead>
                        <tbody>
                          {referralStats.referred.map(r => (
                            <tr key={r.id} style={{ borderBottom: "1px solid var(--border)", cursor: "pointer" }}
                              onClick={() => setSelectedId(r.id)}>
                              <td style={{ padding: "0.6rem", fontWeight: 500 }}>{r.name}</td>
                              <td style={{ padding: "0.6rem" }}>
                                <span style={{
                                  fontSize: "1.15rem", fontWeight: 600, padding: "0.2rem 0.6rem", borderRadius: "999px",
                                  background: r.status === 'repaid' ? '#dcfce7' : r.status === 'written_off' ? '#fee2e2' : r.status === 'funded' || r.status === 'repayment_scheduled' ? '#dbeafe' : '#f3f4f6',
                                  color: r.status === 'repaid' ? '#166534' : r.status === 'written_off' ? '#991b1b' : r.status === 'funded' || r.status === 'repayment_scheduled' ? '#1e40af' : '#374151',
                                }}>
                                  {statusLabel[r.status as Status] ?? r.status}
                                </span>
                              </td>
                              <td style={{ padding: "0.6rem", textAlign: "center" }}>{r.repayment_count}</td>
                              <td style={{ padding: "0.6rem", textAlign: "center" }}>{r.got_advance ? "✓" : "—"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </>
                  )}
                </section>
                <section className={styles.panel}>
                  <h3>Bank snapshot</h3>
                  {isSnapshotLoading ? (
                    <p className={styles.muted}>Loading bank data…</p>
                  ) : !snapshot ? (
                    <p className={styles.muted}>No bank data — applicant may not have connected yet.</p>
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

const STATUS_LABEL: Record<string, string> = {
  pfc: "Plaid category",
  keyword: "keyword match",
  ai: "AI",
  refund: "refund detected",
};

const BankSnapshotView = ({ snapshot }: { snapshot: BankSnapshot }) => {
  const [showExcluded, setShowExcluded] = useState(false);

  const incoming = snapshot.transactions.filter(tx => tx.amount > 0);
  const eligible = incoming.filter(tx => tx.status === "wage_income");
  const uncertain = incoming.filter(tx => tx.status === "uncertain");
  const excluded = incoming.filter(tx => tx.status === "excluded");

  const renderTx = (tx: BankSnapshot["transactions"][number]) => {
    const isExcluded = tx.status === "excluded";
    const isUncertain = tx.status === "uncertain";
    return (
      <div
        key={tx.id}
        className={styles.incomingTransaction}
        style={{ opacity: isExcluded ? 0.45 : 1 }}
      >
        <span>{tx.date}</span>
        <strong>{tx.description}</strong>
        <span style={{ fontSize: "1.2rem", color: "var(--muted)" }}>{tx.category}</span>
        <div style={{ display: "flex", gap: "0.6rem", alignItems: "center", flexWrap: "wrap" }}>
          {isUncertain && (
            <span style={{ fontSize: "1.1rem", background: "#fff3cd", color: "#856404", borderRadius: "4px", padding: "1px 6px" }}>
              uncertain
            </span>
          )}
          {isExcluded && (
            <span style={{ fontSize: "1.1rem", background: "#fde", color: "#a00", borderRadius: "4px", padding: "1px 6px" }}>
              excluded · {STATUS_LABEL[tx.reason!] ?? tx.reason}
            </span>
          )}
          {tx.ai_classified && (
            <span style={{ fontSize: "1.1rem", background: "#e8f0fe", color: "#1a56db", borderRadius: "4px", padding: "1px 6px" }}>
              AI
            </span>
          )}
          <span className={isExcluded ? styles.outgoingAmount : styles.incomingAmount}>
            +{formatMoney(tx.amount / 100)}
          </span>
        </div>
      </div>
    );
  };

  return (
    <div className={styles.snapshot}>
      {snapshot.income_sources?.length > 0 && (
        <>
          <h4>Accrued wages today</h4>
          {snapshot.income_sources.map((src, i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", padding: "0.8rem 0", borderBottom: "1px solid var(--border)" }}>
              <div>
                <strong style={{ fontSize: "1.4rem" }}>{src.employer || "Unknown employer"}</strong>
                <div style={{ fontSize: "1.2rem", color: "var(--muted)", marginTop: "0.2rem" }}>
                  {src.accrued_cents != null
                    ? `${src.days_elapsed} of ${src.period_days} days elapsed · avg paycheck ${formatMoney((src.avg_paycheck_cents ?? 0) / 100)}`
                    : src.error === "no_transactions" ? "No matching wage transactions found" : "Unable to calculate"}
                </div>
              </div>
              <strong style={{ fontSize: "1.5rem", color: src.accrued_cents != null ? "var(--ink)" : "var(--muted)" }}>
                {src.accrued_cents != null ? formatMoney(src.accrued_cents / 100) : "—"}
              </strong>
            </div>
          ))}
          {snapshot.income_sources.length > 1 && (
            <div style={{ display: "flex", justifyContent: "space-between", padding: "0.8rem 0", fontWeight: 700, fontSize: "1.4rem" }}>
              <span>Total accrued</span>
              <span>{formatMoney(snapshot.total_accrued_cents / 100)}</span>
            </div>
          )}
        </>
      )}

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

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: "2rem" }}>
        <h4 style={{ margin: 0 }}>
          Eligible income ({eligible.length + uncertain.length} of {incoming.length})
        </h4>
        <button
          style={{ fontSize: "1.2rem", padding: "4px 10px" }}
          onClick={() => setShowExcluded(s => !s)}
        >
          {showExcluded ? "Hide excluded" : `Show excluded (${excluded.length})`}
        </button>
      </div>

      {incoming.length === 0 && (
        <p style={{ color: "var(--muted)", fontSize: "1.35rem", marginTop: "1rem" }}>
          No incoming transactions yet — Plaid may still be syncing. Refresh in a moment.
        </p>
      )}

      {[...eligible, ...uncertain].map(renderTx)}

      {showExcluded && excluded.length > 0 && (
        <>
          <p style={{ fontSize: "1.2rem", color: "var(--muted)", marginTop: "1.2rem", marginBottom: "0.4rem" }}>
            — excluded transactions —
          </p>
          {excluded.map(renderTx)}
        </>
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

  const isBankTransferPayout = payoutMethods.includes("Bank transfer");

  const togglePayoutMethod = (method: string) => {
    if (method === "Bank transfer") {
      // Bank transfer is exclusive — deselects PayPal/CashApp/Zelle
      setPayoutMethods(prev => prev.includes("Bank transfer") ? [] : ["Bank transfer"]);
    } else {
      // Selecting PayPal/CashApp/Zelle deselects bank transfer
      setPayoutMethods(prev => {
        const withoutBank = prev.filter(m => m !== "Bank transfer");
        return withoutBank.includes(method) ? withoutBank.filter(m => m !== method) : [...withoutBank, method];
      });
    }
    setPayoutSaved(false);
  };

  const submitPayoutPreference = async () => {
    if (payoutMethods.length === 0) { setPayoutError("Please select at least one payout method"); return; }
    if (!isBankTransferPayout && !payoutContact.trim()) { setPayoutError("Please enter your username, email, or phone number"); return; }
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
                <dt>Employer{(application.income_sources?.length ?? 0) > 1 ? "s" : ""}</dt>
                <dd>{(application.income_sources?.length > 0 ? application.income_sources.map(s => s.employer) : [application.customer.employer]).join(", ") || "—"}</dd>
                <dt>Next payday</dt><dd>{application.income_sources?.[0]?.payday ?? application.payday}</dd>
                <dt>Bank</dt><dd>{application.plaid_connected ? "Connected" : "Not connected"}</dd>
              </dl>
            </section>

            <section className={styles.panel}>
              <h3>Repayment</h3>
              {application.status === "repaid" ? (
                <p className={styles.paidNote}>Repayment collected — thank you!</p>
              ) : application.plaid_connected ? (
                // Bank verified via Plaid — card required for repayment
                <>
                  <p className={styles.paidNote}>✓ Bank verified via Plaid.</p>
                  {rep && (
                    <dl style={{ marginTop: "1.2rem" }}>
                      <dt>Due date</dt><dd className={styles.dueDate}>{rep.due_date}</dd>
                      <dt>Status</dt><dd>{rep.status === "paid" ? "Paid" : "Pending"}</dd>
                    </dl>
                  )}
                  {(application.status === "approved" || application.status === "funded" || application.status === "repayment_scheduled") && (
                    <div style={{ marginTop: "1.6rem" }}>
                      {application.stripe_card_saved ? (
                        <p className={styles.paidNote}>✓ Card on file — repayment will be collected automatically on the due date.</p>
                      ) : !stripeKey ? (
                        <p className={styles.error}>Card payments are not configured yet.</p>
                      ) : (
                        <>
                          <p style={{ marginBottom: "1rem", fontWeight: 600 }}>Add a card to complete repayment setup:</p>
                          <Elements stripe={stripePromise}>
                            <SaveCardForm
                              applicationId={application.id}
                              authToken={token}
                              onSaved={() => loadMe({ Authorization: `Bearer ${token}` })}
                            />
                          </Elements>
                        </>
                      )}
                    </div>
                  )}
                </>
              ) : application.stripe_card_saved ? (
                // Card-only (old flow)
                <>
                  {rep && (
                    <dl>
                      <dt>Due date</dt><dd className={styles.dueDate}>{rep.due_date}</dd>
                      <dt>Status</dt><dd>{rep.status === "paid" ? "Paid" : "Pending"}</dd>
                    </dl>
                  )}
                  <p className={styles.paidNote}>Card saved — repayment will be collected automatically on the due date.</p>
                </>
              ) : (application.status === "approved" || application.status === "funded" || application.status === "repayment_scheduled") ? (
                <>
                  <p><strong>Set up repayment.</strong> Save a card to complete your repayment setup.</p>
                  {stripeKey && (
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
                    {["PayPal", "CashApp", "Zelle", "Bank transfer"].map(method => (
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
                        {method === "Bank transfer" ? "🏦 Bank transfer" : method}
                      </button>
                    ))}
                  </div>
                  {isBankTransferPayout ? (
                    <p style={{ marginTop: "1.2rem", fontSize: "1.35rem", color: "var(--brand)", fontWeight: 600 }}>
                      ✓ We'll send funds directly to your connected bank account — no extra info needed.
                      {!application.plaid_connected && (
                        <span style={{ color: "#c0392b", display: "block", marginTop: "0.4rem" }}>
                          You'll need to connect your bank first from this page.
                        </span>
                      )}
                    </p>
                  ) : (
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
                  )}
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

// ── Plaid connect button ──────────────────────────────────────────────────────

const PlaidConnectButton = ({
  linkToken,
  applicationId,
  authToken,
  onConnected,
  onError,
}: {
  linkToken: string;
  applicationId: string;
  authToken: string;
  onConnected: (app: Application) => void;
  onError: (msg: string) => void;
}) => {
  const [busy, setBusy] = useState(false);
  const { open, ready } = usePlaidLink({
    token: linkToken,
    onSuccess: async (publicToken) => {
      setBusy(true);
      try {
        const res = await fetch(apiUrl(`/api/advance/applications/${applicationId}/plaid/exchange-token`), {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
          body: JSON.stringify({ public_token: publicToken }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error?.error_message || "Could not save bank account");
        onConnected(data.application);
      } catch (e) {
        onError(e instanceof Error ? e.message : "Something went wrong");
      } finally {
        setBusy(false);
      }
    },
    onExit: () => setBusy(false),
  });
  return (
    <button disabled={!ready || busy} onClick={() => open()}>
      {busy ? "Connecting…" : "Connect bank account →"}
    </button>
  );
};

// ── States footer ─────────────────────────────────────────────────────────────

const StatesFooter = () => (
  <div className={styles.statesFooter}>
    <p className={styles.statesFooterTitle}>Available states only</p>
    <p>Georgia · Utah</p>
    <p style={{ marginTop: "0.8rem", fontSize: "1.25rem" }}>
      <a href="/terms" style={{ color: "var(--muted)", textDecoration: "underline" }}>Terms &amp; Conditions</a>
      {" · "}
      <a href="/privacy" style={{ color: "var(--muted)", textDecoration: "underline" }}>Privacy Policy</a>
      {" · "}
      <a href="mailto:usa@getbits.app" style={{ color: "var(--muted)", textDecoration: "underline" }}>usa@getbits.app</a>
    </p>
  </div>
);


export default App;

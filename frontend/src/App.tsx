import React, { useCallback, useEffect, useMemo, useState } from "react";
import { loadStripe } from "@stripe/stripe-js";
import { Elements, CardElement, useStripe, useElements } from "@stripe/react-stripe-js";

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

const ELIGIBLE_STATES = new Set([
  "Alabama", "Alaska", "Arizona", "Colorado", "Delaware", "Florida", "Georgia",
  "Hawaii", "Idaho", "Iowa", "Kentucky", "Maine", "Michigan", "Minnesota",
  "Mississippi", "Montana", "Nebraska", "New Hampshire", "New Jersey",
  "New Mexico", "North Carolina", "North Dakota", "Ohio", "Oklahoma", "Oregon",
  "Pennsylvania", "Rhode Island", "South Dakota", "Tennessee", "Texas",
  "Vermont", "Virginia", "Washington", "West Virginia", "Wyoming",
]);
const ADVANCE_TIERS = [25, 50, 75, 100, 150, 200];

const applicationStorageKey = "advance_application_id";
const userTokenStorageKey = "advance_user_token";
const adminTokenStorageKey = "advance_admin_token";
// Stashed by PlaidConnectButton before Link opens so /oauth-return can pick the
// same link_token back up and resume the OAuth flow (Plaid rejects a new token
// for an in-progress OAuth session).
const oauthLinkTokenStorageKey = "advance_plaid_oauth_link_token";

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
  if (path === "/oauth-return") return <OauthReturn />;
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
  const [benefitsSeen, setBenefitsSeen] = useState(false);
  const [reapplyBusy, setReapplyBusy] = useState(false);
  const [showConfirmation, setShowConfirmation] = useState(false);
  const [codeCopied, setCodeCopied] = useState(false);
  const [showPayoutStep, setShowPayoutStep] = useState(false);
  const [payoutMethods, setPayoutMethods] = useState<string[]>([]);
  const [payoutContact, setPayoutContact] = useState("");
  const [payoutSaved, setPayoutSaved] = useState(false);
  const [payoutBusy, setPayoutBusy] = useState(false);
  const [payoutError, setPayoutError] = useState<string | null>(null);
  const [cardSaved, setCardSaved] = useState(false);

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

  // Hydrate card/payout local state from the application so the post-approval
  // flow doesn't re-prompt for things the user already saved during pre-bank
  // onboarding.
  useEffect(() => {
    if (application?.stripe_card_saved) setCardSaved(true);
    if (application?.payout_methods && application?.payout_contact) {
      setPayoutMethods(application.payout_methods.split(','));
      setPayoutContact(application.payout_contact);
      setPayoutSaved(true);
    }
  }, [application?.stripe_card_saved, application?.payout_methods, application?.payout_contact]);



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
      // Skip the post-approval payout/card step entirely if pre-bank onboarding
      // already captured both — go straight to the confirmation screen.
      const alreadyCaptured =
        data.application.stripe_card_saved &&
        data.application.payout_methods &&
        data.application.payout_contact;
      if (alreadyCaptured) setShowConfirmation(true);
      else setShowPayoutStep(true);
    } catch (e) {
      setDeliveryError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setDeliveryBusy(false);
    }
  };

  const togglePayoutMethod = (method: string) => {
    setPayoutMethods(prev =>
      prev.includes(method) ? prev.filter(m => m !== method) : [...prev, method]
    );
    setPayoutSaved(false);
  };

  const submitPayoutPreference = async () => {
    if (payoutMethods.length === 0) { setPayoutError("Please select at least one payout method"); return; }
    const isBankTransferPayout = payoutMethods.includes("Bank transfer");
    if (!isBankTransferPayout && !payoutContact.trim()) {
      setPayoutError("Please enter your username, email, or phone number");
      return;
    }
    setPayoutBusy(true);
    setPayoutError(null);
    try {
      const res = await fetch(apiUrl(`/api/advance/applications/${application!.id}/payout-preference`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
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
  const [hostedLinkUrl, setHostedLinkUrl] = useState<string | null>(null);
  const [plaidLinkError, setPlaidLinkError] = useState<string | null>(null);
  const [plaidCheckingCompletion, setPlaidCheckingCompletion] = useState(false);

  const fetchPlaidLinkToken = () => {
    if (!application || application.plaid_connected) return;
    setPlaidLinkError(null);
    fetch(apiUrl(`/api/advance/applications/${application.id}/plaid/link-token`), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ origin: window.location.origin }),
    })
      .then(r => r.json())
      .then(d => {
        if (d.link_token && d.hosted_link_url) {
          setPlaidLinkToken(d.link_token);
          setHostedLinkUrl(d.hosted_link_url);
        } else {
          setPlaidLinkError(d.error?.error_message || "Could not load bank connection. Please try again.");
        }
      })
      .catch(() => setPlaidLinkError("Could not load bank connection. Please try again."));
  };

  // After Hosted Link completes, Plaid redirects the user back with
  // ?plaid_complete=1. Detect that, ask the backend to exchange the
  // public_token via linkTokenGet, and update the application.
  useEffect(() => {
    if (!application || application.plaid_connected || !token) return;
    if (!window.location.search.includes("plaid_complete=1")) return;
    const stashedLinkToken = localStorage.getItem("plaid_hosted_link_token");
    if (!stashedLinkToken) {
      window.history.replaceState({}, "", window.location.pathname);
      return;
    }
    setPlaidCheckingCompletion(true);
    fetch(apiUrl(`/api/advance/applications/${application.id}/plaid/check-completion`), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ link_token: stashedLinkToken }),
    })
      .then(r => r.json())
      .then(d => {
        if (d.status === "connected" && d.application) {
          setApplication(d.application);
          localStorage.removeItem("plaid_hosted_link_token");
        } else if (d.error) {
          setPlaidLinkError(d.error.error_message || "We couldn't finish your bank connection. Please try again.");
        }
        window.history.replaceState({}, "", window.location.pathname);
      })
      .catch(() => setPlaidLinkError("We couldn't finish your bank connection. Please try again."))
      .finally(() => setPlaidCheckingCompletion(false));
  }, [application?.id, application?.plaid_connected, token]);

  useEffect(() => {
    fetchPlaidLinkToken();
  }, [application?.id, application?.plaid_connected, token]);


  // ── Landing ──────────────────────────────────────────────────────────────────
  if (!application) {
    if (view === "landing") {
      const goSignup = () => setView("referral");
      const goSignIn = () => { window.location.href = "/loan"; };
      return (
        <div className={styles.ldPage}>
          {/* ── 1. Nav ─────────────────────────────────────────────────────── */}
          <header className={styles.ldNav}>
            <div className={styles.ldNavInner}>
              <a className={styles.ldBrand} href="#top" onClick={(e) => { e.preventDefault(); window.scrollTo({ top: 0, behavior: "smooth" }); }}>
                <span className={styles.ldBrandMark}>
                  <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true">
                    <circle cx="11" cy="11" r="10" fill="#fff" />
                    <path d="M6 13l3 3 7-8" stroke="#0d5234" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
                advance<span className={styles.ldBrandDot}>.</span>
              </a>
              <nav className={styles.ldNavLinks} aria-label="Main">
                <a href="#how">How it works</a>
                <a href="#why">Why us</a>
                <a href="#raffle">Raffle</a>
                <a href="#faq">FAQ</a>
              </nav>
              <div className={styles.ldNavCtas}>
                <button type="button" onClick={goSignIn} className={styles.ldLinkBtn}>Sign in</button>
                <button type="button" onClick={goSignup} className={styles.ldBtnGreen}>Get cash <span aria-hidden="true">→</span></button>
              </div>
            </div>
          </header>

          <main>
            {/* ── 2. Hero ──────────────────────────────────────────────────── */}
            <section className={styles.ldHero}>
              <div className={styles.ldHeroBgGrid} aria-hidden="true" />
              <div className={styles.ldHeroBgGlow} aria-hidden="true" />
              <div className={styles.ldHeroInner}>
                <div className={styles.ldHeroCopy}>
                  <span className={styles.ldEyebrow}>
                    <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">
                      <path d="M3 6.5l2.5 2.5L10 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    No credit check · 0% interest · No collections
                  </span>
                  <h1 className={styles.ldH1}>
                    Cash before<br />
                    <span className={styles.ldH1Accent}>your paycheck.</span>
                  </h1>
                  <p className={styles.ldHeroSub}>
                    Up to <strong>$300 in your account today</strong>. Repay on your next payday — no interest, no hidden fees, no surprises.
                  </p>
                  <div className={styles.ldHeroCtaRow}>
                    <button type="button" onClick={goSignup} className={styles.ldBtnWhiteLg}>
                      Get my cash <span aria-hidden="true">→</span>
                    </button>
                    <a className={styles.ldHeroLink} href="#how">
                      How it works
                    </a>
                  </div>
                  <ul className={styles.ldHeroProof}>
                    <li>
                      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M3 7l2.5 2.5L11 4.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
                      Same-day funding
                    </li>
                    <li>
                      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><rect x="3" y="6" width="8" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.4" /><path d="M4.5 6V4.5a2.5 2.5 0 0 1 5 0V6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
                      Bank-grade security
                    </li>
                    <li>
                      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.4" /></svg>
                      No credit pull
                    </li>
                  </ul>
                </div>

                {/* Phone frame mockup */}
                <div className={styles.ldHeroPhoneWrap}>
                  <div className={styles.ldHeroSparkle1} aria-hidden="true" />
                  <div className={styles.ldHeroSparkle2} aria-hidden="true" />
                  <div className={styles.ldPhone}>
                    <div className={styles.ldPhoneNotch} aria-hidden="true" />
                    <div className={styles.ldPhoneScreen}>
                      <div className={styles.ldPhoneTop}>
                        <span>9:41</span>
                        <span className={styles.ldPhoneTopIcons}>
                          <svg width="14" height="10" viewBox="0 0 14 10" fill="none"><path d="M1 8h2v1H1zM4 6h2v3H4zM7 4h2v5H7zM10 2h2v7h-2z" fill="#0a1410" /></svg>
                          <svg width="14" height="10" viewBox="0 0 14 10" fill="none"><path d="M7 9a4 4 0 0 0 0-8 4 4 0 0 0 0 8z" stroke="#0a1410" strokeWidth="1" fill="none" /></svg>
                          <svg width="20" height="10" viewBox="0 0 20 10" fill="none"><rect x="0.5" y="2.5" width="17" height="5" rx="1.5" stroke="#0a1410" /><rect x="2" y="4" width="13" height="2" rx="0.5" fill="#0a1410" /><rect x="18" y="4" width="1.5" height="2" rx="0.5" fill="#0a1410" /></svg>
                        </span>
                      </div>
                      <div className={styles.ldPhoneAppHeader}>
                        <span className={styles.ldPhoneAppName}>advance<span>.</span></span>
                        <span className={styles.ldPhoneAvatar}>JS</span>
                      </div>
                      <p className={styles.ldPhoneGreet}>Hey Jamie 👋</p>
                      <div className={styles.ldPhoneCard}>
                        <div className={styles.ldPhonePill}>
                          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M2.5 6.5l2.5 2.5 4.5-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
                          Approved
                        </div>
                        <p className={styles.ldPhoneLabel}>Advance amount</p>
                        <div className={styles.ldPhoneAmount}>$250<span>.00</span></div>
                        <div className={styles.ldPhoneRow}>
                          <span>Repay on</span>
                          <strong>Fri, Mar 14</strong>
                        </div>
                        <div className={styles.ldPhoneRow}>
                          <span>Account</span>
                          <strong>Chase ••4582</strong>
                        </div>
                        <div className={styles.ldPhoneRow}>
                          <span>Interest</span>
                          <strong className={styles.ldPhoneFree}>$0.00</strong>
                        </div>
                        <button type="button" className={styles.ldPhoneBtn}>Send to my bank</button>
                      </div>
                      <p className={styles.ldPhoneFooter}>🎰 You&apos;re entered in this week&apos;s $300 raffle</p>
                    </div>
                  </div>
                </div>
              </div>
            </section>

            {/* ── 3. Amount tier strip ─────────────────────────────────────── */}
            <section className={styles.ldAmounts}>
              <div className={styles.ldContainer}>
                <p className={styles.ldKicker}>How much do you need?</p>
                <h2 className={styles.ldH2}>Borrow only what you need.<br />Repay only what you borrowed.</h2>
                <div className={styles.ldAmountChips}>
                  <div className={styles.ldChip}>$25</div>
                  <div className={styles.ldChip}>$50</div>
                  <div className={styles.ldChip}>$100</div>
                  <div className={styles.ldChip}>$200</div>
                  <div className={styles.ldChipFeatured}>
                    $300
                    <span className={styles.ldChipBadge}>max</span>
                  </div>
                </div>
                <p className={styles.ldAmountsNote}>
                  Standard delivery same-day, free. Need it in minutes? $5 flat for instant transfer. That&apos;s the only fee.
                </p>
              </div>
            </section>

            {/* ── 4. How it works ──────────────────────────────────────────── */}
            <section className={styles.ldHow} id="how">
              <div className={styles.ldContainer}>
                <div className={styles.ldSectionHeader}>
                  <span className={styles.ldKicker}>How it works</span>
                  <h2 className={styles.ldH2}>From application to cash<br />in three steps.</h2>
                </div>
                <div className={styles.ldStepsGrid}>
                  <article className={styles.ldStep}>
                    <div className={styles.ldStepIconBox}>
                      <svg width="28" height="28" viewBox="0 0 28 28" fill="none" aria-hidden="true">
                        <rect x="4" y="3" width="20" height="22" rx="3" stroke="currentColor" strokeWidth="1.8" />
                        <line x1="8" y1="10" x2="20" y2="10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                        <line x1="8" y1="14" x2="16" y2="14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                        <line x1="8" y1="18" x2="14" y2="18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                      </svg>
                    </div>
                    <span className={styles.ldStepLabel}>Step 01</span>
                    <h3>Apply in 2 minutes</h3>
                    <p>Tell us your name, employer, payday and last 4 of your SSN. No credit pull, ever.</p>
                  </article>
                  <article className={styles.ldStep}>
                    <div className={styles.ldStepIconBox}>
                      <svg width="28" height="28" viewBox="0 0 28 28" fill="none" aria-hidden="true">
                        <path d="M3 11L14 4l11 7H3z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
                        <rect x="6" y="13" width="3" height="8" stroke="currentColor" strokeWidth="1.8" />
                        <rect x="12.5" y="13" width="3" height="8" stroke="currentColor" strokeWidth="1.8" />
                        <rect x="19" y="13" width="3" height="8" stroke="currentColor" strokeWidth="1.8" />
                        <line x1="3" y1="23" x2="25" y2="23" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                      </svg>
                    </div>
                    <span className={styles.ldStepLabel}>Step 02</span>
                    <h3>Connect your bank</h3>
                    <p>Link with Plaid — read-only, encrypted. We see your income but never your password.</p>
                  </article>
                  <article className={styles.ldStep}>
                    <div className={styles.ldStepIconBox}>
                      <svg width="28" height="28" viewBox="0 0 28 28" fill="none" aria-hidden="true">
                        <circle cx="14" cy="14" r="10" stroke="currentColor" strokeWidth="1.8" />
                        <path d="M10 14h8M14 10v8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                      </svg>
                    </div>
                    <span className={styles.ldStepLabel}>Step 03</span>
                    <h3>Get your money</h3>
                    <p>A real reviewer approves your advance. Money lands in your account the same day.</p>
                  </article>
                </div>
              </div>
            </section>

            {/* ── 5. Why us ────────────────────────────────────────────────── */}
            <section className={styles.ldWhy} id="why">
              <div className={styles.ldContainer}>
                <div className={styles.ldSectionHeader}>
                  <span className={styles.ldKicker}>Why advance</span>
                  <h2 className={styles.ldH2}>Built for people.<br />Not for banks.</h2>
                  <p className={styles.ldLead}>Every choice we made is the opposite of a payday lender.</p>
                </div>
                <div className={styles.ldFeatureGrid}>
                  <div className={styles.ldFeature}>
                    <div className={styles.ldFeatureNum}>0%</div>
                    <h3>No interest. Ever.</h3>
                    <p>$25 borrowed, $25 repaid. The math is that simple.</p>
                  </div>
                  <div className={styles.ldFeature}>
                    <div className={styles.ldFeatureNum}>0</div>
                    <h3>No credit check</h3>
                    <p>No hard pull. No soft pull. Your credit score never moves.</p>
                  </div>
                  <div className={styles.ldFeature}>
                    <div className={styles.ldFeatureNum}>$0</div>
                    <h3>No hidden fees</h3>
                    <p>Standard delivery is free. Optional $5 for instant. That&apos;s the whole pricing page.</p>
                  </div>
                  <div className={styles.ldFeature}>
                    <div className={styles.ldFeatureNum}>24h</div>
                    <h3>Same-day cash</h3>
                    <p>Approved before 2pm ET? Money lands in your account today. Guaranteed.</p>
                  </div>
                </div>
              </div>
            </section>

            {/* ── 6. Raffle ────────────────────────────────────────────────── */}
            <section className={styles.ldRaffle} id="raffle">
              <div className={styles.ldContainer}>
                <div className={styles.ldRaffleGrid}>
                  <div className={styles.ldRaffleCopy}>
                    <span className={styles.ldRaffleKicker}>🎰 Member perk</span>
                    <h2 className={styles.ldRaffleHeadline}>
                      $300 cash.<br />
                      <span className={styles.ldRaffleAccent}>Every Friday.</span>
                    </h2>
                    <p className={styles.ldRaffleSub}>
                      Every active member in good standing is automatically entered in our weekly $300 cash raffle. No purchase. No forms. Winners paid via PayPal, Cash App, or Zelle.
                    </p>
                    <ul className={styles.ldRaffleBullets}>
                      <li>
                        <span className={styles.ldRaffleCheck}>✓</span>
                        Auto-entered every week — no signup
                      </li>
                      <li>
                        <span className={styles.ldRaffleCheck}>✓</span>
                        Extra entry for every successful referral
                      </li>
                      <li>
                        <span className={styles.ldRaffleCheck}>✓</span>
                        Winner announced every Friday, paid same-day
                      </li>
                    </ul>
                    <button type="button" onClick={goSignup} className={styles.ldBtnDarkLg}>
                      Get my entry <span aria-hidden="true">→</span>
                    </button>
                  </div>
                  <div className={styles.ldRaffleVisual}>
                    <div className={styles.ldTicket}>
                      <div className={styles.ldTicketTop}>
                        <span className={styles.ldTicketBrand}>advance<span>.</span></span>
                        <span className={styles.ldTicketSerial}>WK · 12 / 2026</span>
                      </div>
                      <div className={styles.ldTicketDivider}>
                        <span /><span /><span /><span /><span /><span /><span /><span /><span /><span /><span /><span />
                      </div>
                      <p className={styles.ldTicketLabel}>This week&apos;s prize</p>
                      <div className={styles.ldTicketAmount}>$300</div>
                      <p className={styles.ldTicketCash}>paid in cash · PayPal · Cash App · Zelle</p>
                      <div className={styles.ldTicketFooter}>
                        <span>Next draw</span>
                        <strong>Fri · Mar 14</strong>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </section>

            {/* ── 7. Trust & Security ──────────────────────────────────────── */}
            <section className={styles.ldTrust}>
              <div className={styles.ldContainer}>
                <div className={styles.ldSectionHeader}>
                  <span className={styles.ldKicker}>Security</span>
                  <h2 className={styles.ldH2}>Your money is safe.<br />Your data is safer.</h2>
                  <p className={styles.ldLead}>We use the same banking infrastructure as Robinhood, Mercury, and Coinbase. We never store your bank password.</p>
                </div>
                <div className={styles.ldTrustGrid}>
                  <div className={styles.ldTrustCard}>
                    <div className={styles.ldTrustLogo}>Plaid</div>
                    <h3>Bank linking</h3>
                    <p>Read-only access via Plaid. Your bank credentials never touch our servers.</p>
                  </div>
                  <div className={styles.ldTrustCard}>
                    <div className={styles.ldTrustLogo}>Stripe</div>
                    <h3>Payments</h3>
                    <p>PCI-DSS Level 1. The same payments processor used by Amazon, Google, and Shopify.</p>
                  </div>
                  <div className={styles.ldTrustCard}>
                    <div className={styles.ldTrustLogoIcon} aria-hidden="true">
                      <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
                        <rect x="3" y="9" width="16" height="11" rx="2.5" stroke="currentColor" strokeWidth="1.8" />
                        <path d="M7 9V6a4 4 0 0 1 8 0v3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                      </svg>
                    </div>
                    <h3>Encryption</h3>
                    <p>256-bit TLS in transit. AES-256 at rest. SOC 2 Type II partner infrastructure.</p>
                  </div>
                </div>
                <div className={styles.ldComplianceRow}>
                  <span>Member FDIC partner bank</span>
                  <span className={styles.ldComplianceDot} />
                  <span>CCPA-compliant</span>
                  <span className={styles.ldComplianceDot} />
                  <span>GLBA</span>
                  <span className={styles.ldComplianceDot} />
                  <span>TCPA-compliant</span>
                </div>
              </div>
            </section>

            {/* ── 8. FAQ ───────────────────────────────────────────────────── */}
            <section className={styles.ldFaq} id="faq">
              <div className={styles.ldContainer}>
                <div className={styles.ldFaqGrid}>
                  <div>
                    <span className={styles.ldKicker}>FAQ</span>
                    <h2 className={styles.ldH2}>Questions, plain answers.</h2>
                    <p className={styles.ldLead}>If something isn&apos;t clear, ask us — we&apos;ll answer the same day.</p>
                  </div>
                  <div className={styles.ldFaqList}>
                    {[
                      ["Will this affect my credit score?", "No. We don't pull your credit, soft or hard. Advance never reports to credit bureaus."],
                      ["What if I can't repay on time?", "We'll text you to reschedule. We never send accounts to collections. We never charge a late fee on the principal."],
                      ["What states is advance available in?", "Currently 35 US states. If we're not in your state yet, you can join the waitlist."],
                      ["How much can I borrow?", "Up to $300 per advance. First-time members typically qualify for $50–$150 based on their pay history."],
                      ["How does repayment work?", "Automatic — on your next payday, we debit the amount you borrowed. You can also repay early at any time, free."],
                      ["Is there a membership fee?", "No monthly fee. The only optional cost is $5 if you want instant (same-hour) delivery instead of standard same-day."],
                    ].map(([q, a]) => (
                      <details key={q} className={styles.ldFaqItem}>
                        <summary>
                          <span>{q}</span>
                          <span className={styles.ldFaqPlus} aria-hidden="true">
                            <span /><span />
                          </span>
                        </summary>
                        <p>{a}</p>
                      </details>
                    ))}
                  </div>
                </div>
              </div>
            </section>

            {/* ── 9. CTA band ──────────────────────────────────────────────── */}
            <section className={styles.ldCta}>
              <div className={styles.ldCtaBgGlow} aria-hidden="true" />
              <div className={styles.ldContainer}>
                <h2 className={styles.ldCtaHeadline}>
                  Your next paycheck<br />is closer than you think.
                </h2>
                <p className={styles.ldCtaSub}>Get started in 2 minutes. No credit check. No commitment.</p>
                <div className={styles.ldCtaBtnRow}>
                  <button type="button" onClick={goSignup} className={styles.ldBtnWhiteLg}>
                    Get my cash <span aria-hidden="true">→</span>
                  </button>
                  <a className={styles.ldCtaGhost} href="#faq">Read the FAQ</a>
                </div>
                <p className={styles.ldCtaNote}>Invite-only beta — have a referral code ready</p>
              </div>
            </section>
          </main>

          {/* ── 10. Footer ─────────────────────────────────────────────────── */}
          <footer className={styles.ldFooter}>
            <div className={styles.ldContainer}>
              <div className={styles.ldFooterTop}>
                <div className={styles.ldFooterBrand}>
                  <a className={styles.ldBrand} href="#top" onClick={(e) => { e.preventDefault(); window.scrollTo({ top: 0, behavior: "smooth" }); }}>
                    advance<span className={styles.ldBrandDot}>.</span>
                  </a>
                  <p>Financial breathing room for the people who keep everything running.</p>
                </div>
                <div className={styles.ldFooterCols}>
                  <div>
                    <p className={styles.ldFooterColTitle}>Product</p>
                    <ul>
                      <li><a href="#how">How it works</a></li>
                      <li><a href="#raffle">Raffle</a></li>
                      <li><a href="#faq">FAQ</a></li>
                    </ul>
                  </div>
                  <div>
                    <p className={styles.ldFooterColTitle}>Legal</p>
                    <ul>
                      <li><a href="/terms">Terms</a></li>
                      <li><a href="/privacy">Privacy</a></li>
                      <li><a href="#">Disclosures</a></li>
                    </ul>
                  </div>
                  <div>
                    <p className={styles.ldFooterColTitle}>Support</p>
                    <ul>
                      <li><a href="mailto:hello@getbits.app">Contact</a></li>
                      <li><a href="#">Help center</a></li>
                    </ul>
                  </div>
                </div>
              </div>
              <div className={styles.ldStates}>
                <p className={styles.ldStatesLabel}>Available in 35 US states</p>
                <p className={styles.ldStatesList}>AL · AK · AZ · AR · CA · CO · DE · FL · GA · HI · ID · IL · IN · IA · KS · MI · MN · MS · MO · MT · NE · NV · NM · NY · NC · OH · OK · OR · RI · SC · TN · TX · UT · WA · WI</p>
              </div>
              <div className={styles.ldFooterBottom}>
                <span>© 2026 advance. All rights reserved.</span>
                <p>advance is a financial technology company, not a bank. Banking services provided by partner bank, Member FDIC. advance is not a payday lender. Cash advances are repayable in full on your next pay date with no interest. Available only to eligible residents in supported states.</p>
              </div>
            </div>
          </footer>
        </div>
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
                  By submitting this form and creating an account, you confirm that you have read, understood, and agree to be bound by our{" "}
                  <a href="/terms" target="_blank" rel="noopener noreferrer" style={{ color: "var(--brand)", fontWeight: 600 }}>
                    Terms &amp; Conditions
                  </a>
                  {" "}and{" "}
                  <a href="/privacy" target="_blank" rel="noopener noreferrer" style={{ color: "var(--brand)", fontWeight: 600 }}>
                    Privacy Policy
                  </a>
                  , including the state-specific provisions that apply to your state of residence. We never pull your credit and we will never send your account to collections.
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
  // Backend sets subscription_status='waitlisted' for non-eligible states without a personal referral.
  // neworleans (master gate key) grants signup access but does NOT bypass state eligibility.
  const stateIsIneligible = application.subscription_status === 'waitlisted';
  if (stateIsIneligible) {
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
                Advance is live in 35 states today. We're expanding fast — {stateName} is on the roadmap.
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

  // ── Pre-bank onboarding pages ─────────────────────────────────────────────
  // 6-step linear flow between signup and the main dashboard. Each step has
  // its own gate; the order in this file determines the order users see.
  //   1. Benefits        — pitch what they're signing up for
  //   2. Receive money   — pick payout method (PayPal/Cash App/Zelle) + confirm
  //   3. Trust           — milestone ladder, how trust-building works
  //   4. Card            — backup repayment card (Stripe)
  //   5. Delivery speed  — same-day ($5) vs 3-5 days (free)
  //   6. Bank            — verify income via Plaid Hosted Link
  const preBankActive =
    application.status === "intake" &&
    application.subscription_status === "active" &&
    !application.plaid_connected;

  // Step 1 of 6: benefits pitch (reuses the landing-page benefit cards)
  if (preBankActive && !benefitsSeen) {
    return (
      <main className={styles.page}>
        <NavBar onLogout={handleLogout} />
        <div className={styles.benefitsHeader} style={{ paddingBottom: "5.6rem" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "4rem", maxWidth: "80rem", margin: "0 auto", flexWrap: "wrap" }}>
            <div style={{ flex: "1 1 32rem", textAlign: "left" }}>
              <p className={styles.benefitsHeaderKicker}>Step 1 of 6 · What you get</p>
              <h1 className={styles.benefitsHeaderTitle} style={{ marginBottom: "1.6rem" }}>
                Here's what makes<br />Advance different.
              </h1>
              <p className={styles.benefitsHeaderSub}>
                No credit check. No interest. No collections. Pay back on payday — that's it.
              </p>
            </div>
            <div style={{ flexShrink: 0, opacity: 0.92 }}>
              <AlienMascot flag="usa" size={180} />
            </div>
          </div>
        </div>
        <div className={styles.benefitsBody}>
          <div className={styles.benefitsGrid} style={{ marginBottom: "3.2rem" }}>
            {[
              { icon: "🚫", title: "No credit check", sub: "We never pull your credit. Your score is safe with us — good or bad." },
              { icon: "💸", title: "No interest, ever", sub: "Pay back exactly what you got. No interest, no late fees, no rollover." },
              { icon: "🛡️", title: "No collections", sub: "If repayment fails, we write it off. No collections, no lawsuits, no debt buyers." },
              { icon: "🎰", title: "Weekly $300 raffle", sub: "Every active borrower is entered automatically. Refer a friend, earn extra entries." },
            ].map(({ icon, title, sub }) => (
              <div key={title} className={styles.benefitCard}>
                <span className={styles.benefitIcon}>{icon}</span>
                <p className={styles.benefitCardTitle}>{title}</p>
                <p className={styles.benefitCardSub}>{sub}</p>
              </div>
            ))}
          </div>
          <button style={{ width: "100%" }} onClick={() => setBenefitsSeen(true)}>
            Continue →
          </button>
        </div>
        <StatesFooter />
      </main>
    );
  }

  // Step 2 of 6: receive money — single-select PayPal/Cash App/Zelle with logos + confirmation
  const payoutAlreadySaved = !!(application.payout_methods && application.payout_contact);
  if (preBankActive && !payoutAlreadySaved) {
    const methods: { id: string; name: string; logo: React.ReactNode; placeholder: string; label: string }[] = [
      {
        id: "PayPal",
        name: "PayPal",
        placeholder: "e.g. you@email.com",
        label: "Your PayPal email or phone",
        logo: (
          <span style={{
            display: "inline-flex", alignItems: "center", justifyContent: "center",
            width: "3.6rem", height: "3.6rem", borderRadius: "50%",
            background: "linear-gradient(135deg, #009cde 0%, #003087 100%)",
            color: "white", fontSize: "1.8rem", fontWeight: 900, fontStyle: "italic",
            flexShrink: 0,
          }}>P</span>
        ),
      },
      {
        id: "CashApp",
        name: "Cash App",
        placeholder: "e.g. $cashtag",
        label: "Your $cashtag",
        logo: (
          <span style={{
            display: "inline-flex", alignItems: "center", justifyContent: "center",
            width: "3.6rem", height: "3.6rem", borderRadius: "0.8rem",
            background: "#00D632", color: "white", fontSize: "2rem", fontWeight: 900,
            flexShrink: 0,
          }}>$</span>
        ),
      },
      {
        id: "Zelle",
        name: "Zelle",
        placeholder: "e.g. you@email.com or phone",
        label: "Your Zelle email or phone",
        logo: (
          <span style={{
            display: "inline-flex", alignItems: "center", justifyContent: "center",
            width: "3.6rem", height: "3.6rem", borderRadius: "50%",
            background: "#6D1ED4", color: "white", fontSize: "1.8rem", fontWeight: 900,
            flexShrink: 0,
          }}>Z</span>
        ),
      },
    ];
    const selectedId = payoutMethods[0];
    const selectedMethod = methods.find(m => m.id === selectedId);
    return (
      <main className={styles.page}>
        <NavBar onLogout={handleLogout} />
        <div className={styles.benefitsHeader} style={{ paddingBottom: "5.6rem" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "4rem", maxWidth: "80rem", margin: "0 auto", flexWrap: "wrap" }}>
            <div style={{ flex: "1 1 32rem", textAlign: "left" }}>
              <p className={styles.benefitsHeaderKicker}>Step 2 of 6 · Receive money</p>
              <h1 className={styles.benefitsHeaderTitle} style={{ marginBottom: "1.6rem" }}>
                Where should we<br />send the cash?
              </h1>
              <p className={styles.benefitsHeaderSub}>
                Pick one — we'll send your advance here once you're approved.
              </p>
            </div>
            <div style={{ flexShrink: 0, opacity: 0.92 }}>
              <AlienMascot flag="usa" size={160} />
            </div>
          </div>
        </div>
        <div className={styles.benefitsBody} style={{ maxWidth: "48rem", margin: "0 auto" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: "1rem", marginBottom: "2rem" }}>
            {methods.map(m => {
              const selected = selectedId === m.id;
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => {
                    setPayoutMethods([m.id]);
                    setPayoutSaved(false);
                    setPayoutError(null);
                  }}
                  style={{
                    display: "flex", alignItems: "center", gap: "1.4rem",
                    padding: "1.4rem 1.8rem",
                    borderRadius: "var(--r-lg)",
                    border: `2px solid ${selected ? "var(--brand)" : "var(--border)"}`,
                    background: selected ? "var(--brand-tint)" : "var(--white)",
                    cursor: "pointer",
                    textAlign: "left",
                  }}
                >
                  {m.logo}
                  <span style={{ fontSize: "1.6rem", fontWeight: 700, color: "var(--ink)", flex: 1 }}>{m.name}</span>
                  {selected && <span style={{ fontSize: "1.6rem", color: "var(--brand)", fontWeight: 800 }}>✓</span>}
                </button>
              );
            })}
          </div>
          {selectedMethod && (
            <div style={{ marginBottom: "1.6rem" }}>
              <label style={{ fontSize: "1.35rem", fontWeight: 600, display: "block", marginBottom: "0.6rem", color: "var(--ink)" }}>
                {selectedMethod.label}
              </label>
              <input
                type="text"
                placeholder={selectedMethod.placeholder}
                value={payoutContact}
                onChange={(e) => { setPayoutContact(e.target.value); setPayoutSaved(false); setPayoutError(null); }}
                style={{ width: "100%", fontSize: "1.5rem", padding: "1.2rem 1.4rem", borderRadius: "var(--r-sm)", border: "1.5px solid var(--border)" }}
              />
            </div>
          )}
          {selectedMethod && payoutContact.trim() && (
            <div style={{
              background: "var(--brand-tint)", border: "1.5px solid var(--brand-tint2)",
              borderRadius: "var(--r-lg)", padding: "1.6rem 1.8rem", marginBottom: "1.6rem",
            }}>
              <p style={{ fontSize: "1.25rem", fontWeight: 700, color: "var(--brand)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "0.6rem" }}>
                Please confirm
              </p>
              <p style={{ fontSize: "1.5rem", color: "var(--ink)", margin: 0, lineHeight: 1.5 }}>
                We'll send your advance to <strong>{selectedMethod.name}</strong> at <strong>{payoutContact.trim()}</strong>. Make sure this is correct — we can't recover funds sent to the wrong address.
              </p>
            </div>
          )}
          {payoutError && <p className={styles.error}>{payoutError}</p>}
          <button
            style={{ width: "100%" }}
            disabled={payoutBusy || !selectedMethod || !payoutContact.trim()}
            onClick={async () => {
              await submitPayoutPreference();
              if (application) await loadApplication(application.id);
            }}
          >
            {payoutBusy ? "Saving…" : "Yes, this is correct →"}
          </button>
        </div>
        <StatesFooter />
      </main>
    );
  }

  // Step 3 of 6: trust-building screen (milestone ladder + how-it-works)
  if (preBankActive && !trustScreenSeen) {
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
        <div className={styles.benefitsHeader} style={{ paddingBottom: "5.6rem" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "4rem", maxWidth: "80rem", margin: "0 auto", flexWrap: "wrap" }}>
            <div style={{ flex: "1 1 32rem", textAlign: "left" }}>
              <p className={styles.benefitsHeaderKicker}>Step 3 of 6 · How Advance works</p>
              <h1 className={styles.benefitsHeaderTitle} style={{ marginBottom: "1.6rem" }}>
                Your limit grows<br />with trust.
              </h1>
              <p className={styles.benefitsHeaderSub}>
                You'll start at <strong>$25</strong>. Repay on time and your limit climbs — all the way up to $200.
              </p>
            </div>
            <div style={{ flexShrink: 0, opacity: 0.92 }}>
              <AlienMascot flag="usa" size={180} />
            </div>
          </div>
        </div>
        <div className={styles.benefitsBody}>
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
                    You start here
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
            Continue →
          </button>
        </div>
        <StatesFooter />
      </main>
    );
  }

  // Step 4 of 6: backup repayment card (Stripe)
  if (preBankActive && !application.stripe_card_saved) {
    return (
      <main className={styles.page}>
        <NavBar onLogout={handleLogout} />
        <div className={styles.benefitsHeader} style={{ paddingBottom: "5.6rem" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "4rem", maxWidth: "80rem", margin: "0 auto", flexWrap: "wrap" }}>
            <div style={{ flex: "1 1 32rem", textAlign: "left" }}>
              <p className={styles.benefitsHeaderKicker}>Step 4 of 6 · Repayment method</p>
              <h1 className={styles.benefitsHeaderTitle} style={{ marginBottom: "1.6rem" }}>
                Add a backup card.
              </h1>
              <p className={styles.benefitsHeaderSub}>
                We'll charge this card on your payday to collect your repayment. You won't be charged until your advance is funded.
              </p>
            </div>
            <div style={{ flexShrink: 0, opacity: 0.92 }}>
              <AlienMascot flag="usa" size={160} />
            </div>
          </div>
        </div>
        <div className={styles.benefitsBody} style={{ maxWidth: "48rem", margin: "0 auto" }}>
          {!stripeKey ? (
            <p className={styles.error}>Card payments are not configured yet.</p>
          ) : (
            <Elements stripe={stripePromise}>
              <SaveCardForm
                applicationId={application.id}
                authToken={token}
                onSaved={() => loadApplication(application.id)}
              />
            </Elements>
          )}
          <div style={{
            background: "var(--brand-tint)", border: "1.5px solid var(--brand-tint2)",
            borderRadius: "var(--r-lg)", padding: "1.4rem 1.8rem", marginTop: "2rem",
          }}>
            <p style={{ fontSize: "1.4rem", color: "var(--ink)", margin: 0, lineHeight: 1.6 }}>
              ✅ <strong>As long as you receive regular income, you should be approved.</strong>
            </p>
          </div>
          <p style={{ fontSize: "1.25rem", color: "var(--muted)", marginTop: "1.6rem", textAlign: "center" }}>
            🔒 Card details are encrypted and stored by Stripe — we never see them.
          </p>
        </div>
        <StatesFooter />
      </main>
    );
  }

  // Step 5 of 6: delivery speed (same-day vs 3-5 days)
  if (preBankActive && !application.delivery_type) {
    return (
      <main className={styles.page}>
        <NavBar onLogout={handleLogout} />
        <div className={styles.benefitsHeader} style={{ paddingBottom: "5.6rem" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "4rem", maxWidth: "80rem", margin: "0 auto", flexWrap: "wrap" }}>
            <div style={{ flex: "1 1 32rem", textAlign: "left" }}>
              <p className={styles.benefitsHeaderKicker}>Step 5 of 6 · Delivery speed</p>
              <h1 className={styles.benefitsHeaderTitle} style={{ marginBottom: "1.6rem" }}>
                How fast do<br />you need it?
              </h1>
              <p className={styles.benefitsHeaderSub}>
                Same-day costs an extra <strong>$5</strong>, added to your repayment. 3–5 day delivery is free.
              </p>
            </div>
            <div style={{ flexShrink: 0, opacity: 0.92 }}>
              <AlienMascot flag="usa" size={160} />
            </div>
          </div>
        </div>
        <div className={styles.benefitsBody} style={{ maxWidth: "48rem", margin: "0 auto" }}>
          <div className={styles.deliveryOptions}>
            <button
              type="button"
              className={`${styles.deliveryOption} ${deliveryChoice === "instant" ? styles.deliveryOptionSelected : ""}`}
              onClick={() => setDeliveryChoice("instant")}
            >
              <p className={styles.deliveryOptionBadge}>$5 fee</p>
              <p className={styles.deliveryOptionTitle}>⚡ Same day</p>
              <p className={styles.deliveryOptionSub}>Money sent the same day, straight to your PayPal, CashApp, or Zelle.</p>
            </button>
            <button
              type="button"
              className={`${styles.deliveryOption} ${deliveryChoice === "standard" ? styles.deliveryOptionSelected : ""}`}
              onClick={() => setDeliveryChoice("standard")}
            >
              <p className={styles.deliveryOptionBadge}>Free</p>
              <p className={styles.deliveryOptionTitle}>📬 3–5 days</p>
              <p className={styles.deliveryOptionSub}>No extra charge. Funds arrive in 3–5 business days.</p>
            </button>
          </div>
          {deliveryChoice && (() => {
            const total = application.requested_amount + (deliveryChoice === "instant" ? 5 : 0);
            return (
              <div style={{ marginTop: "1.6rem", padding: "1.4rem 1.8rem", background: "var(--surface)", border: "1.5px solid var(--border)", borderRadius: "var(--r-lg)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: "1.35rem", color: "var(--muted)", fontWeight: 600 }}>You'll repay on payday</span>
                <strong style={{ fontSize: "2rem", color: "var(--ink)" }}>${total}</strong>
              </div>
            );
          })()}
          {deliveryError && <p className={styles.error}>{deliveryError}</p>}
          <button
            disabled={deliveryBusy || !deliveryChoice}
            onClick={saveDelivery}
            style={{ width: "100%", marginTop: "2rem" }}
          >
            {deliveryBusy ? "Saving…" : "Continue →"}
          </button>
        </div>
        <StatesFooter />
      </main>
    );
  }

  // Step 6 of 6: bank connection (the final gate before review)
  if (preBankActive) {
    return (
      <main className={styles.page}>
        <NavBar onLogout={handleLogout} />
        <div className={styles.benefitsHeader} style={{ paddingBottom: "5.6rem" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "4rem", maxWidth: "80rem", margin: "0 auto", flexWrap: "wrap" }}>
            <div style={{ flex: "1 1 32rem", textAlign: "left" }}>
              <p className={styles.benefitsHeaderKicker}>Step 6 of 6 · Bank verification</p>
              <h1 className={styles.benefitsHeaderTitle} style={{ marginBottom: "1.6rem" }}>
                Let's see if<br />you're approved.
              </h1>
              <p className={styles.benefitsHeaderSub}>
                Connect your bank so we can verify income and finish your application. We never share your login — Plaid handles it securely.
              </p>
            </div>
            <div style={{ flexShrink: 0, opacity: 0.92 }}>
              <AlienMascot flag="usa" size={160} />
            </div>
          </div>
        </div>
        <div className={styles.benefitsBody} style={{ maxWidth: "48rem", margin: "0 auto" }}>
          {plaidCheckingCompletion ? (
            <button disabled>Finishing connection…</button>
          ) : plaidLinkToken && hostedLinkUrl ? (
            <PlaidConnectButton
              linkToken={plaidLinkToken}
              hostedLinkUrl={hostedLinkUrl}
            />
          ) : plaidLinkError ? (
            <div>
              <p style={{ color: "var(--error, #c0392b)", marginBottom: "0.8rem", fontSize: "1.4rem" }}>{plaidLinkError}</p>
              <button onClick={fetchPlaidLinkToken}>Retry →</button>
            </div>
          ) : (
            <button disabled>Loading…</button>
          )}
          {error && <p className={styles.error} style={{ marginTop: "1.2rem" }}>{error}</p>}
          <p style={{ fontSize: "1.25rem", color: "var(--muted)", marginTop: "1.6rem", textAlign: "center" }}>
            🔒 Bank-grade encryption · We never store your password · 256-bit TLS
          </p>
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
                <p className={styles.deliveryOptionBadge}>$5 fee</p>
                <p className={styles.deliveryOptionTitle}>⚡ Same day</p>
                <p className={styles.deliveryOptionSub}>Money sent the same day to your PayPal, CashApp, or Zelle.</p>
              </button>
              <button
                type="button"
                className={`${styles.deliveryOption} ${deliveryChoice === "standard" ? styles.deliveryOptionSelected : ""}`}
                onClick={() => setDeliveryChoice("standard")}
              >
                <p className={styles.deliveryOptionBadge}>Free</p>
                <p className={styles.deliveryOptionTitle}>📬 3–5 days</p>
                <p className={styles.deliveryOptionSub}>No extra charge. Funds arrive in 3–5 business days.</p>
              </button>
            </div>
            {deliveryChoice && (() => {
              const total = application.requested_amount + (deliveryChoice === "instant" ? 5 : 0);
              return (
                <div style={{ marginTop: "1.6rem", padding: "1.4rem 1.8rem", background: "var(--surface)", border: "1.5px solid var(--border)", borderRadius: "var(--r-lg)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontSize: "1.35rem", color: "var(--muted)", fontWeight: 600 }}>You'll repay on payday</span>
                  <strong style={{ fontSize: "2rem", color: "var(--ink)" }}>${total}</strong>
                </div>
              );
            })()}
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

      {showPayoutStep && !showConfirmation && (
        <div style={{ maxWidth: "56rem", margin: "0 auto", padding: "4rem 2.4rem 8rem" }}>
          <div style={{ textAlign: "center", marginBottom: "3.2rem" }}>
            <div style={{ fontSize: "4.8rem", marginBottom: "1.2rem" }}>💸</div>
            <h1 style={{ fontSize: "3rem", fontWeight: 800, color: "var(--ink)", marginBottom: "0.8rem" }}>
              Almost there!
            </h1>
            <p style={{ fontSize: "1.6rem", color: "var(--muted)", lineHeight: 1.6 }}>
              Tell us where to send your{" "}
              <strong style={{ color: "var(--ink)" }}>${application.requested_amount} advance</strong>{" "}
              and add a card for repayment.
            </p>
          </div>

          {/* Section 1: Payout method */}
          <div style={{
            background: "var(--white)", border: "1.5px solid var(--border)",
            borderRadius: "var(--r-lg)", padding: "2.4rem 2.8rem", marginBottom: "1.6rem",
          }}>
            <p style={{ fontWeight: 700, fontSize: "1.5rem", color: "var(--ink)", marginBottom: "0.4rem" }}>
              Where should we send it?
            </p>
            <p style={{ fontSize: "1.35rem", color: "var(--muted)", marginBottom: "1.6rem" }}>
              Select one or more options.
            </p>
            <div style={{ display: "flex", gap: "0.8rem", flexWrap: "wrap", marginBottom: "1.6rem" }}>
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

            {payoutMethods.length > 0 && (
              <label style={{ display: "block", marginBottom: "1.6rem" }}>
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
            {payoutSaved ? (
              <p className={styles.paidNote}>✓ Payout info saved!</p>
            ) : (
              <button disabled={payoutBusy} onClick={submitPayoutPreference} style={{ marginTop: "0.4rem" }}>
                {payoutBusy ? "Saving…" : "Save payout info"}
              </button>
            )}
          </div>

          {/* Section 2: Card for repayment */}
          <div style={{
            background: "var(--white)", border: "1.5px solid var(--border)",
            borderRadius: "var(--r-lg)", padding: "2.4rem 2.8rem", marginBottom: "2.4rem",
          }}>
            <p style={{ fontWeight: 700, fontSize: "1.5rem", color: "var(--ink)", marginBottom: "0.4rem" }}>
              Add a card for repayment
            </p>
            <p style={{ fontSize: "1.35rem", color: "var(--muted)", marginBottom: "1.6rem" }}>
              We'll charge this card on your repayment date. Your card is never charged upfront.
            </p>
            {cardSaved ? (
              <p className={styles.paidNote}>✓ Card saved — repayment will be collected automatically on your due date.</p>
            ) : stripeKey ? (
              <Elements stripe={stripePromise}>
                <SaveCardForm
                  applicationId={application.id}
                  authToken={token}
                  onSaved={() => {
                    loadApplication(application.id);
                    setCardSaved(true);
                  }}
                />
              </Elements>
            ) : (
              <p className={styles.error}>Card payments are not configured.</p>
            )}
          </div>

          {/* Continue — only when both are done */}
          <button
            disabled={!payoutSaved || !cardSaved}
            style={{ width: "100%" }}
            onClick={() => { setShowPayoutStep(false); setShowConfirmation(true); }}
          >
            Continue →
          </button>
          {(!payoutSaved || !cardSaved) && (
            <p style={{ textAlign: "center", fontSize: "1.3rem", color: "var(--muted)", marginTop: "0.8rem" }}>
              {!payoutSaved && !cardSaved ? "Save your payout info and card to continue." : !payoutSaved ? "Save your payout info to continue." : "Save your card to continue."}
            </p>
          )}
        </div>
      )}

      {showConfirmation && application.referral_code && (
        <div style={{ maxWidth: "56rem", margin: "0 auto", padding: "4rem 2.4rem 8rem" }}>

          {/* Hero */}
          {(() => {
            const totalToRepay = application.requested_amount + (application.delivery_type === "instant" ? 5 : 0);
            return (
              <div style={{ textAlign: "center", marginBottom: "3.2rem" }}>
                <div style={{ fontSize: "4.8rem", marginBottom: "1.2rem" }}>🎉</div>
                <h1 style={{ fontSize: "3rem", fontWeight: 800, color: "var(--ink)", marginBottom: "0.8rem" }}>
                  You're all set!
                </h1>
                <p style={{ fontSize: "1.6rem", color: "var(--muted)", lineHeight: 1.6, marginBottom: "1.6rem" }}>
                  Your <strong style={{ color: "var(--ink)" }}>${application.requested_amount} advance</strong> is{" "}
                  {application.delivery_type === "instant" ? "on its way — same-day delivery." : "on its way — arriving in 3–5 business days."}
                </p>
                <div style={{ display: "inline-flex", gap: "1.2rem", alignItems: "baseline", padding: "1rem 2rem", background: "var(--surface)", border: "1.5px solid var(--border)", borderRadius: "var(--r-lg)" }}>
                  <span style={{ fontSize: "1.3rem", color: "var(--muted)", fontWeight: 600 }}>You'll repay</span>
                  <strong style={{ fontSize: "2rem", color: "var(--ink)" }}>${totalToRepay}</strong>
                  <span style={{ fontSize: "1.3rem", color: "var(--muted)" }}>on payday</span>
                </div>
              </div>
            );
          })()}

          {/* Referral code card */}
          <div style={{
            background: "var(--brand-tint)", border: "2px solid var(--brand-tint2)",
            borderRadius: "var(--r-lg)", padding: "2.4rem 2.8rem", marginBottom: "2rem",
          }}>
            <p style={{ fontSize: "1.2rem", fontWeight: 700, color: "var(--brand)", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: "0.6rem" }}>
              Your referral code
            </p>
            <div style={{ display: "flex", alignItems: "center", gap: "1.2rem", flexWrap: "wrap", marginBottom: "1.4rem" }}>
              <code style={{ fontSize: "2.6rem", fontWeight: 900, color: "var(--brand)", letterSpacing: "0.06em" }}>
                {application.referral_code}
              </code>
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard.writeText(application.referral_code!);
                  setCodeCopied(true);
                  setTimeout(() => setCodeCopied(false), 2000);
                }}
                style={{ fontSize: "1.3rem", padding: "0.6rem 1.4rem" }}
              >
                {codeCopied ? "Copied!" : "Copy code"}
              </button>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: "1.2rem" }}>
              <div style={{ display: "flex", gap: "1.2rem", alignItems: "flex-start" }}>
                <span style={{ fontSize: "2rem", flexShrink: 0 }}>🎰</span>
                <div>
                  <p style={{ fontSize: "1.4rem", fontWeight: 700, color: "var(--ink)", marginBottom: "0.2rem" }}>Earn extra raffle entries</p>
                  <p style={{ fontSize: "1.35rem", color: "var(--ink-2)", lineHeight: 1.6 }}>
                    Every friend who uses your code and gets their first advance earns you <strong>an extra entry</strong> into the weekly $300 cash raffle — on top of your automatic entry.
                  </p>
                </div>
              </div>
              <div style={{ display: "flex", gap: "1.2rem", alignItems: "flex-start" }}>
                <span style={{ fontSize: "2rem", flexShrink: 0 }}>📈</span>
                <div>
                  <p style={{ fontSize: "1.4rem", fontWeight: 700, color: "var(--ink)", marginBottom: "0.2rem" }}>Help them, help yourself</p>
                  <p style={{ fontSize: "1.35rem", color: "var(--ink-2)", lineHeight: 1.6 }}>
                    Your referrals let friends skip the waitlist and get early access — even if Advance isn't live in their state yet.
                  </p>
                </div>
              </div>
              <div style={{
                background: "#fffbeb", border: "1.5px solid #fcd34d",
                borderRadius: "var(--r-sm)", padding: "1rem 1.2rem",
                display: "flex", gap: "1rem", alignItems: "flex-start",
              }}>
                <span style={{ fontSize: "1.6rem", flexShrink: 0 }}>⚠️</span>
                <p style={{ fontSize: "1.3rem", color: "#92400e", lineHeight: 1.6, margin: 0 }}>
                  One thing to keep in mind: if someone you refer doesn't pay back their first advance on time, it will slow down your ability to unlock higher credit limits. Only share with people you trust.
                </p>
              </div>
            </div>
          </div>

          <button
            style={{ width: "100%" }}
            onClick={() => setShowConfirmation(false)}
          >
            Go to my dashboard →
          </button>
        </div>
      )}

      {!showConfirmation && !showPayoutStep && <div className={styles.appCard}>
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
              <dd>{application.delivery_type === "instant" ? "⚡ Same day" : "📬 3–5 days"}</dd>
              <dt>Bank</dt>
              <dd>{application.plaid_connected ? "✓ Connected" : "Not connected"}</dd>
              {application.repayment ? (
                <>
                  <dt>Repay</dt>
                  <dd className={styles.dueDate}>${application.repayment.amount} on {application.repayment.due_date}</dd>
                </>
              ) : application.delivery_type ? (
                <>
                  <dt>Repay</dt>
                  <dd className={styles.dueDate}>${application.requested_amount + (application.delivery_type === "instant" ? 5 : 0)} on payday</dd>
                </>
              ) : null}
            </dl>

            {needsBank && (
              <div className={styles.appCardAction}>
                <p><strong>Next step:</strong> connect your bank account via Plaid. This verifies your income so we can review your application.</p>
                {plaidCheckingCompletion ? (
                  <button disabled>Finishing connection…</button>
                ) : plaidLinkToken && hostedLinkUrl ? (
                  <PlaidConnectButton
                    linkToken={plaidLinkToken}
                    hostedLinkUrl={hostedLinkUrl}
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

              // ── 1. Still being reviewed (pre-approval) ──
              if (["reviewing", "intake", "bank_connected"].includes(application.status)) {
                return (
                  <div className={styles.appCardAction}>
                    <p>Your application is being reviewed. We'll update this page as soon as there's news — no action needed from you right now.</p>
                  </div>
                );
              }

              // ── 2. Approved but not yet funded — money is coming ──
              if (application.status === "approved" && application.delivery_type) {
                return (
                  <div style={{ marginTop: "1.6rem" }}>
                    <div style={{
                      background: "linear-gradient(135deg, var(--brand) 0%, #7c3aed 100%)",
                      borderRadius: "var(--r-lg)", padding: "2.4rem 2.8rem", color: "white",
                    }}>
                      <p style={{ fontSize: "1.2rem", fontWeight: 700, opacity: 0.75, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: "0.8rem" }}>
                        Status update
                      </p>
                      <p style={{ fontSize: "2.2rem", fontWeight: 800, margin: "0 0 0.6rem" }}>
                        Your money is on its way.
                      </p>
                      <p style={{ fontSize: "1.4rem", opacity: 0.85, margin: 0, lineHeight: 1.6 }}>
                        {application.delivery_type === "instant"
                          ? "You selected same-day delivery — funds are sent the same day once we process your request."
                          : "You selected 3–5 day delivery — funds typically arrive within 3–5 business days."}
                      </p>
                    </div>
                  </div>
                );
              }

              // ── 3. Funded — countdown to repayment due date ──
              if (["funded", "repayment_scheduled"].includes(application.status)) {
                return (
                  <div style={{ marginTop: "1.6rem" }}>
                    <div style={{ display: "flex", gap: "1.2rem", flexWrap: "wrap", marginBottom: "1.2rem" }}>
                      <div style={{
                        flex: "1 1 16rem", background: "var(--brand)", color: "white",
                        borderRadius: "var(--r-lg)", padding: "2rem 2.4rem",
                      }}>
                        <p style={{ fontSize: "1.15rem", opacity: 0.75, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "0.6rem" }}>Repayment due</p>
                        <p style={{ fontSize: "4rem", fontWeight: 900, margin: "0 0 0.2rem", lineHeight: 1 }}>{daysUntilDue ?? "—"}</p>
                        <p style={{ fontSize: "1.4rem", opacity: 0.85, margin: 0 }}>
                          day{daysUntilDue === 1 ? "" : "s"}{dueDate ? ` · ${dueDate.toLocaleDateString([], { month: "long", day: "numeric" })}` : ""}
                        </p>
                      </div>
                      <div style={{
                        flex: "1 1 16rem", background: "var(--surface)", border: "1.5px solid var(--border)",
                        borderRadius: "var(--r-lg)", padding: "2rem 2.4rem",
                      }}>
                        <p style={{ fontSize: "1.15rem", color: "var(--muted)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "0.6rem" }}>Next advance</p>
                        <p style={{ fontSize: "2rem", fontWeight: 800, color: "var(--ink)", margin: "0 0 0.2rem" }}>
                          {canReapplyAt ? canReapplyAt.toLocaleDateString([], { month: "short", day: "numeric" }) : "—"}
                        </p>
                        <p style={{ fontSize: "1.3rem", color: "var(--muted)", margin: 0 }}>opens after repayment</p>
                      </div>
                    </div>
                    <p style={{ fontSize: "1.3rem", color: "var(--muted)", lineHeight: 1.6 }}>
                      Repay on time and your next advance eligibility opens the following day. No interest, no late fees — we never report anything to credit bureaus.
                    </p>
                  </div>
                );
              }

              // ── 4. Repaid but cooldown not over — countdown to next advance ──
              if (!canReapplyNow) {
                return (
                  <div style={{ marginTop: "1.6rem" }}>
                    <div style={{
                      background: "var(--brand-tint)", border: "1.5px solid var(--brand-tint2)",
                      borderRadius: "var(--r-lg)", padding: "2.4rem 2.8rem", textAlign: "center",
                    }}>
                      <p style={{ fontSize: "1.15rem", color: "var(--muted)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "0.6rem" }}>Next advance opens in</p>
                      <p style={{ fontSize: "5rem", fontWeight: 900, color: "var(--ink)", margin: "0 0 0.4rem", lineHeight: 1 }}>{daysUntilReapply}</p>
                      <p style={{ fontSize: "1.4rem", color: "var(--muted)", margin: "0 0 1.2rem" }}>
                        day{daysUntilReapply === 1 ? "" : "s"} · {canReapplyAt?.toLocaleDateString([], { month: "long", day: "numeric" })}
                      </p>
                    </div>
                    <p style={{ fontSize: "1.3rem", color: "var(--muted)", lineHeight: 1.6, marginTop: "1.2rem" }}>
                      ✓ Repayment collected — thank you! Check back on{" "}
                      <strong style={{ color: "var(--ink)" }}>{canReapplyAt?.toLocaleDateString([], { month: "long", day: "numeric" })}</strong>{" "}
                      to apply for your next advance.
                    </p>
                  </div>
                );
              }

              // ── 5. New month / cooldown over — offer to apply ──
              return (
                <div style={{ marginTop: "1.6rem" }}>
                  {application.status === "expired" && (
                    <p style={{ fontSize: "1.4rem", color: "var(--muted)", marginBottom: "1.2rem", lineHeight: 1.6 }}>
                      Your previous offer expired before you chose a delivery method. Nothing was charged — you can apply right now.
                    </p>
                  )}
                  <div style={{
                    background: "var(--brand-tint)", border: "1.5px solid var(--brand-tint2)",
                    borderRadius: "var(--r-lg)", padding: "1.6rem 2rem",
                    display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "1.2rem",
                  }}>
                    <div>
                      <p style={{ fontSize: "1.5rem", fontWeight: 700, color: "var(--ink)", marginBottom: "0.2rem" }}>
                        Ready for your next advance
                      </p>
                      <p style={{ fontSize: "1.35rem", color: "var(--muted)", margin: 0 }}>
                        {application.repayment_count > 0 ? "Your repayment history unlocks your next offer." : "Apply now and we'll review your eligibility."}
                      </p>
                    </div>
                    <button disabled={reapplyBusy} onClick={handleReapply} style={{ whiteSpace: "nowrap" }}>
                      {reapplyBusy ? "Submitting…" : "Apply now →"}
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
      </div>}

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
                  <h2>{selected.customer.name}</h2>
                  <p>{selected.customer.email} · {selected.customer.phone}</p>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: "1rem", flexWrap: "wrap" }}>
                  <div className={styles.actions} style={{ margin: 0 }}>
                    <button disabled={isBusy} onClick={() => setStatus("approved", "Congrats, you are approved for a cash advance. To send the funds manually, please reply with: routing number, account number, checking or savings, and the legal name on the account. Do not send your online banking password.")}>Approve</button>
                    <button disabled={isBusy} onClick={() => setStatus("denied", "We are unable to approve this advance right now.")}>Deny</button>
                    <button disabled={isBusy} onClick={() => setStatus("funded", "Your advance has been sent.")}>Mark funded</button>
                    <button disabled={isBusy} style={{ background: "#dc2626", borderColor: "#dc2626" }} onClick={() => { if (confirm("Write off this advance? If the user was referred and this is their first advance, the referrer's limit progression will be frozen for 3 months.")) setStatus("written_off"); }}>Write off</button>
                  </div>
                  <div className={styles.status}>{statusLabel[selected.status]}</div>
                </div>
              </div>
              <div className={styles.reviewGrid}>
                {/* LEFT COLUMN — stacks vertically */}
                <div style={{ display: "flex", flexDirection: "column", gap: "1.2rem" }}>
                <section className={styles.panel}>
                  <h3>Applicant</h3>
                  {/* Two-column DL layout */}
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 1.6rem" }}>
                    <dl className={styles.adminDl}>
                      <dt>Requested</dt>
                      <dd>{formatMoney(selected.requested_amount)}</dd>
                      <dt>Income</dt>
                      <dd>
                        {(selected.income_sources?.length > 0 ? selected.income_sources : [{ employer: selected.customer.employer, payday: selected.payday, pay_frequency: selected.customer.pay_frequency }]).map((src, i) => (
                          <div key={i} style={{ marginBottom: "0.2rem" }}>
                            <span style={{ fontWeight: 700 }}>{src.employer || "—"}</span>
                            <span style={{ color: "var(--muted)", fontWeight: 400 }}> · {src.payday} · {src.pay_frequency || "—"}</span>
                          </div>
                        ))}
                      </dd>
                      <dt>Accrued est.</dt>
                      <dd>
                        {isSnapshotLoading ? <span style={{ color: "var(--muted)" }}>…</span>
                          : snapshot ? (snapshot.total_accrued_cents > 0 ? formatMoney(snapshot.total_accrued_cents / 100) : <span style={{ color: "var(--muted)" }}>Insufficient</span>)
                          : "—"}
                      </dd>
                      <dt>Payout to</dt>
                      <dd>
                        {selected.payout_methods
                          ? <>{selected.payout_methods}{selected.payout_contact ? <span style={{ color: "var(--muted)", fontWeight: 400 }}> · {selected.payout_contact}</span> : null}</>
                          : "—"}
                      </dd>
                    </dl>
                    <dl className={styles.adminDl}>
                      <dt>DOB</dt>
                      <dd>{selected.customer.dob || "—"}</dd>
                      <dt>SSN last 4</dt>
                      <dd>{selected.customer.ssn_last4 || "—"}</dd>
                      <dt>State</dt>
                      <dd>{selected.customer.state || "—"}</dd>
                      <dt>Bank</dt>
                      <dd>{selected.plaid_connected ? "✓ Connected" : "Waiting"}</dd>
                      <dt>Card</dt>
                      <dd>{selected.stripe_card_saved ? "✓ On file" : "None"}</dd>
                      <dt>Referral code</dt>
                      <dd>{selected.referral_code || "—"}</dd>
                      {selected.referred_by && <><dt>Referred by</dt><dd>{selected.referred_by}</dd></>}
                      {selected.limit_freeze_until && <><dt>Limit freeze</dt><dd style={{ color: "#b45309" }}>Until {selected.limit_freeze_until}</dd></>}
                    </dl>
                  </div>
                  {/* Repayment section */}
                  <div className={styles.repayment}>
                    {selected.repayment && (
                      <p style={{ fontSize: "1.3rem", margin: 0 }}>
                        Repayment of <strong>${selected.repayment.amount}</strong> due <strong>{selected.repayment.due_date}</strong> — auto-collected on due date.
                      </p>
                    )}
                    <div style={{ display: "flex", gap: "0.8rem", alignItems: "center", flexWrap: "wrap" }}>
                      {(selected.plaid_connected || selected.stripe_card_saved) ? (
                        <button disabled={isBusy} onClick={chargeCard} style={{ fontSize: "1.3rem", padding: "0.7rem 1.2rem" }}>
                          {isBusy ? "Processing…" : "Collect repayment now"}
                        </button>
                      ) : (
                        <p className={styles.muted} style={{ margin: 0, fontSize: "1.3rem" }}>No payment method on file yet.</p>
                      )}
                      {error && <p className={styles.error} style={{ margin: 0, fontSize: "1.3rem" }}>{error}</p>}
                    </div>
                  </div>
                </section>
                <section className={styles.panel}>
                  <h3>Borrowing history</h3>
                  {(() => {
                    const totalTaken = selected.repayment_count + (selected.delivery_type ? 1 : 0);
                    const isActive = ["funded", "repayment_scheduled"].includes(selected.status);
                    const isWrittenOff = selected.status === "written_off";
                    const isRepaid = selected.status === "repaid" || selected.repayment?.status === "paid";
                    if (totalTaken === 0) return <p className={styles.muted}>No advances taken yet.</p>;
                    return (
                      <>
                        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginBottom: "0.8rem" }}>
                          {[
                            { label: "Total advances", value: totalTaken, color: "var(--brand)" },
                            { label: "Repaid", value: selected.repayment_count, color: "#16a34a" },
                            { label: "Written off", value: isWrittenOff ? 1 : 0, color: "#dc2626" },
                          ].map(({ label, value, color }) => (
                            <div key={label} style={{ background: "var(--surface)", border: "1.5px solid var(--border)", borderRadius: "var(--r-sm)", padding: "0.5rem 0.8rem", textAlign: "center", minWidth: "6rem" }}>
                              <p style={{ fontSize: "1.6rem", fontWeight: 800, color, margin: 0 }}>{value}</p>
                              <p style={{ fontSize: "1.15rem", color: "var(--muted)", margin: 0 }}>{label}</p>
                            </div>
                          ))}
                        </div>
                        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "1.3rem" }}>
                          <thead>
                            <tr style={{ borderBottom: "1.5px solid var(--border)" }}>
                              <th style={{ textAlign: "left", padding: "0.4rem 0.6rem", color: "var(--muted)", fontWeight: 600 }}>#</th>
                              <th style={{ textAlign: "left", padding: "0.4rem 0.6rem", color: "var(--muted)", fontWeight: 600 }}>Outcome</th>
                              <th style={{ textAlign: "left", padding: "0.4rem 0.6rem", color: "var(--muted)", fontWeight: 600 }}>Note</th>
                            </tr>
                          </thead>
                          <tbody>
                            {Array.from({ length: selected.repayment_count }, (_, i) => (
                              <tr key={i} style={{ borderBottom: "1px solid var(--border)" }}>
                                <td style={{ padding: "0.6rem", fontWeight: 600, color: "var(--muted)" }}>#{i + 1}</td>
                                <td style={{ padding: "0.6rem" }}>
                                  <span style={{ fontSize: "1.15rem", fontWeight: 600, padding: "0.2rem 0.6rem", borderRadius: "999px", background: "#dcfce7", color: "#166534" }}>Repaid ✓</span>
                                </td>
                                <td style={{ padding: "0.6rem", color: "var(--muted)", fontSize: "1.2rem" }}>On time</td>
                              </tr>
                            ))}
                            {selected.delivery_type && (
                              <tr style={{ borderBottom: "1px solid var(--border)" }}>
                                <td style={{ padding: "0.6rem", fontWeight: 600, color: "var(--muted)" }}>#{totalTaken}</td>
                                <td style={{ padding: "0.6rem" }}>
                                  <span style={{
                                    fontSize: "1.15rem", fontWeight: 600, padding: "0.2rem 0.6rem", borderRadius: "999px",
                                    background: isRepaid ? "#dcfce7" : isWrittenOff ? "#fee2e2" : isActive ? "#dbeafe" : "#f3f4f6",
                                    color: isRepaid ? "#166534" : isWrittenOff ? "#991b1b" : isActive ? "#1e40af" : "#374151",
                                  }}>
                                    {isRepaid ? "Repaid ✓" : isWrittenOff ? "Written off" : isActive ? "Active" : statusLabel[selected.status]}
                                  </span>
                                </td>
                                <td style={{ padding: "0.6rem", color: "var(--muted)", fontSize: "1.2rem" }}>
                                  {selected.repayment?.due_date ? `Due ${selected.repayment.due_date}` : selected.delivery_type === "instant" ? "Instant delivery" : "Standard delivery"}
                                </td>
                              </tr>
                            )}
                          </tbody>
                        </table>
                      </>
                    );
                  })()}
                </section>

                {/* Borrowing history + Referral tree — side by side */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1.2rem" }}>
                <section className={styles.panel}>
                  <h3>Referral tree</h3>
                  {!referralStats ? (
                    <p className={styles.muted}>Loading…</p>
                  ) : referralStats.total === 0 ? (
                    <p className={styles.muted}>No referrals yet.{selected.referral_code ? ` Code: ${selected.referral_code}` : ''}</p>
                  ) : (
                    <>
                      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginBottom: "0.8rem" }}>
                        {[
                          { label: "Referred", value: referralStats.total, color: "var(--brand)" },
                          { label: "Got advance", value: referralStats.got_advance, color: "#16a34a" },
                          { label: "Repaid", value: referralStats.repaid, color: "#16a34a" },
                          { label: "Active", value: referralStats.active, color: "#2563eb" },
                          { label: "Defaulted", value: referralStats.defaulted, color: "#dc2626" },
                        ].map(({ label, value, color }) => (
                          <div key={label} style={{ background: "var(--surface)", border: "1.5px solid var(--border)", borderRadius: "var(--r-sm)", padding: "0.5rem 0.8rem", textAlign: "center", minWidth: "5rem" }}>
                            <p style={{ fontSize: "1.6rem", fontWeight: 800, color, margin: 0 }}>{value}</p>
                            <p style={{ fontSize: "1.15rem", color: "var(--muted)", margin: 0 }}>{label}</p>
                          </div>
                        ))}
                      </div>
                      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "1.3rem" }}>
                        <thead>
                          <tr style={{ borderBottom: "1.5px solid var(--border)" }}>
                            <th style={{ textAlign: "left", padding: "0.4rem 0.6rem", color: "var(--muted)", fontWeight: 600 }}>Name</th>
                            <th style={{ textAlign: "left", padding: "0.4rem 0.6rem", color: "var(--muted)", fontWeight: 600 }}>Status</th>
                            <th style={{ textAlign: "center", padding: "0.4rem 0.6rem", color: "var(--muted)", fontWeight: 600 }}>Got advance</th>
                            <th style={{ textAlign: "center", padding: "0.4rem 0.6rem", color: "var(--muted)", fontWeight: 600 }}>Paid back</th>
                          </tr>
                        </thead>
                        <tbody>
                          {referralStats.referred.map(r => {
                            const didDefault = r.got_advance && r.status === 'written_off' && r.repayment_count === 0;
                            const paidBack = r.repayment_count > 0 || r.status === 'repaid';
                            return (
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
                                <td style={{ padding: "0.6rem", textAlign: "center" }}>{r.got_advance ? "✓" : "—"}</td>
                                <td style={{ padding: "0.6rem", textAlign: "center" }}>
                                  {!r.got_advance ? "—" : paidBack
                                    ? <span style={{ color: "#16a34a", fontWeight: 700 }}>✓ {r.repayment_count}x</span>
                                    : didDefault
                                      ? <span style={{ color: "#dc2626", fontWeight: 700 }}>✗ defaulted</span>
                                      : <span style={{ color: "#92400e" }}>pending</span>}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </>
                  )}
                </section>
                </div>{/* end borrowing+referral sub-grid */}
                </div>{/* end left column */}

                {/* RIGHT COLUMN — Bank snapshot */}
                <div style={{ display: "flex", flexDirection: "column", gap: "1.2rem" }}>
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
                </div>{/* end right column */}
              </div>
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
  hostedLinkUrl,
}: {
  linkToken: string;
  hostedLinkUrl: string;
}) => {
  const handleOpen = () => {
    // Stash the link_token so the check-completion call on return can
    // identify the right session. localStorage survives the full-page
    // redirect to Plaid and back.
    try { localStorage.setItem("plaid_hosted_link_token", linkToken); } catch {}
    window.location.href = hostedLinkUrl;
  };
  return (
    <button onClick={handleOpen}>
      Connect bank account →
    </button>
  );
};

// ── Plaid OAuth return page ───────────────────────────────────────────────────
// Dedicated route Plaid redirects back to after a bank OAuth login. We do NOT
// re-init Plaid Link here — on mobile Safari that triggers Plaid's cleanup
// which navigates the tab to about:blank and strands the user. Instead, we
// just route the popup back to the main app immediately. The original tab
// still has Plaid Link running and either auto-completes or prompts the user
// to tap "Continue" to finish the connection.

const OauthReturn = () => {
  const oauthStateId = new URLSearchParams(window.location.search).get("oauth_state_id");

  console.log("[oauth-return] mount", {
    oauthStateId,
    href: window.location.href,
  });

  useEffect(() => {
    // Clean up the stashed link token — the original tab owns the flow now.
    try { localStorage.removeItem(oauthLinkTokenStorageKey); } catch {}
    // Try to close this popup tab so the browser returns the user to the
    // original Advance tab (where Plaid Link is showing "One more step /
    // Continue"). If close is refused (typically because the tab wasn't
    // opened by JS), fall back to navigating to / so we at least don't
    // strand the user on about:blank.
    console.log("[oauth-return] attempting to close popup");
    try { window.close(); } catch (e) { console.log("[oauth-return] close threw", e); }
    const t = setTimeout(() => {
      console.log("[oauth-return] still here — navigating back to /");
      window.location.replace("/");
    }, 600);
    return () => clearTimeout(t);
  }, []);

  const wrap: React.CSSProperties = {
    padding: "4rem 2rem",
    textAlign: "center",
    fontSize: "1.6rem",
    maxWidth: "40rem",
    margin: "0 auto",
  };

  return (
    <main style={wrap}>
      <p style={{ fontSize: "1.8rem", fontWeight: 700, marginBottom: "0.8rem" }}>Returning to Advance…</p>
      <p style={{ opacity: 0.7 }}>
        {oauthStateId
          ? "Closing this tab and sending you back to the Advance app to finish bank linking."
          : "If you weren't expecting this page, head to the app:"}
      </p>
      <p style={{ marginTop: "1.6rem" }}>
        <a href="/" style={{ color: "var(--brand)", fontWeight: 600 }}>Go to the app →</a>
      </p>
    </main>
  );
};

// ── States footer ─────────────────────────────────────────────────────────────

const StatesFooter = () => (
  <div className={styles.statesFooter}>
    <p className={styles.statesFooterTitle}>Available in 35 states</p>
    <p style={{ fontSize: "1.2rem", maxWidth: "60rem", margin: "0 auto", lineHeight: 1.5 }}>
      AL · AK · AZ · CO · DE · FL · GA · HI · ID · IA · KY · ME · MI · MN · MS · MT · NE · NH · NJ · NM · NC · ND · OH · OK · OR · PA · RI · SD · TN · TX · VT · VA · WA · WV · WY
    </p>
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

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { loadStripe } from "@stripe/stripe-js";
import { Elements, CardElement, useStripe, useElements } from "@stripe/react-stripe-js";
import { motion } from "framer-motion";

import { apiUrl } from "./api";
import styles from "./App.module.css";

// Shared motion variants for pre-bank flow screens. Page fades + slides up,
// children stagger in. Spring physics on the page give a polished feel.
const flowPageVariants = {
  hidden: { opacity: 0, y: 16 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { type: "spring" as const, stiffness: 120, damping: 22, when: "beforeChildren", staggerChildren: 0.06 },
  },
};
const flowChildVariants = {
  hidden: { opacity: 0, y: 12 },
  visible: { opacity: 1, y: 0, transition: { type: "spring" as const, stiffness: 180, damping: 24 } },
};
import TermsPage from "./TermsPage";
import PrivacyPage from "./PrivacyPage";
import StoryPage from "./StoryPage";
import ConsentPage from "./ConsentPage";
import SystemDesignPage from "./SystemDesignPage";

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
  | "subscription_failed"
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
  bank_linked: boolean;
  stripe_card_saved: boolean;
  stripe_payment_method_id: string | null;
  stripe_card_pm_id: string | null;
  stripe_fc_account_id: string | null;
  stripe_charge_status: string | null;
  payout_methods: string | null;
  payout_contact: string | null;
  subscription_status: string | null;
  subscription_id: string | null;
  subscription_next_billing: string | null;
  // Stripe Connect Express (ACH payouts). Set when the user picks "Bank
  // account (ACH)" in Step 2 and completes the Stripe-hosted onboarding.
  stripe_connect_account_id: string | null;
  stripe_connect_status: string | null;
  transfer_id: string | null;
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
  "New Mexico", "New York", "North Carolina", "North Dakota", "Ohio", "Oklahoma", "Oregon",
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
  subscription_failed: "Membership payment failed",
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
  if (path === "/story") return <StoryPage />;
  if (path === "/consent") return <ConsentPage />;
  if (path === "/system-design") return <SystemDesignPage />;
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
  const [reapplyBusy, setReapplyBusy] = useState(false);
  const [showConfirmation, setShowConfirmation] = useState(false);
  const [codeCopied, setCodeCopied] = useState(false);
  const [showPayoutStep, setShowPayoutStep] = useState(false);
  const [payoutMethods, setPayoutMethods] = useState<string[]>([]);
  const [payoutContact, setPayoutContact] = useState("");
  const [payoutSaved, setPayoutSaved] = useState(false);
  const [payoutBusy, setPayoutBusy] = useState(false);
  const [payoutError, setPayoutError] = useState<string | null>(null);
  // Local override so users can re-enter Step 2 (Receive money) from Step 4
  // even though their payout preference is already saved on the server.
  // Cleared once a new preference is submitted successfully.
  const [wantsToChangePayout, setWantsToChangePayout] = useState(false);
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

  // Hydrate payout local state from the application so the post-approval
  // flow doesn't re-prompt for things the user already saved during pre-bank
  // onboarding. cardSaved is now a synonym for "has FC bank PM" since card
  // was removed; we keep the variable name for diff clarity.
  useEffect(() => {
    if (application?.stripe_payment_method_id) setCardSaved(true);
    if (application?.payout_methods && application?.payout_contact) {
      setPayoutMethods(application.payout_methods.split(','));
      setPayoutContact(application.payout_contact);
      setPayoutSaved(true);
    }
  }, [application?.stripe_payment_method_id, application?.payout_methods, application?.payout_contact]);



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
      // Skip the post-approval payout step entirely if pre-bank onboarding
      // already captured everything — bank PM (FC) + payout — go straight
      // to the confirmation screen.
      const alreadyCaptured =
        data.application.stripe_payment_method_id &&
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
    // ACH uses Stripe Connect — no contact handle needed (the backend
    // already wrote 'stripe_connect' as the contact when onboarding
    // completed). For any handle-based method (PayPal/Cash App/Zelle)
    // the contact field is required.
    const isAchPayout = payoutMethods.includes("ACH");
    const isBankTransferPayout = payoutMethods.includes("Bank transfer");
    if (!isAchPayout && !isBankTransferPayout && !payoutContact.trim()) {
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
      // Pay frequency no longer collected — derived from bank transactions later.
      // Payday: must be set, in the future, and within 30 days.
      if (!src.payday) {
        setError(`Please enter your next payday${label}`);
        return;
      }
      const paydayDate = new Date(src.payday + "T00:00:00");
      if (Number.isNaN(paydayDate.getTime())) {
        setError(`Please enter a valid payday${label}`);
        return;
      }
      const nowMs = new Date(today + "T00:00:00").getTime();
      const maxMs = new Date(thirtyDaysFromNow + "T00:00:00").getTime();
      const paydayMs = paydayDate.getTime();
      if (paydayMs < nowMs) {
        setError(`Your next payday must be today or later${label}`);
        return;
      }
      if (paydayMs > maxMs) {
        setError(`Your next payday must be within the next 30 days${label}. If your next paycheck is further out, you can apply for an advance closer to that date.`);
        return;
      }
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
        // pay_frequency dropped from signup — strip the lingering fields
        // off the form state before sending; backend treats null as fine.
        income_sources: rawSources.map(({ pay_frequency_other, pay_frequency, ...s }) => s),
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

  // After Stripe Connect Express hosted onboarding, Stripe redirects the
  // user back with ?connect_complete=1 (return) or ?connect_refresh=1
  // (session expired; we'll mint a new link). Either way, sync the
  // Connect status from the backend so the rest of the flow can advance.
  const [stripeConnectBusy, setStripeConnectBusy] = useState(false);
  const [stripeConnectError, setStripeConnectError] = useState<string | null>(null);

  // Stripe Financial Connections — replaces Plaid for bank linking. One FC
  // session gives us: chargeable bank PaymentMethod (for repayment debit),
  // transactions (for income verification), and a bank token attachable to
  // the user's Connect external_account (for ACH payouts).
  const [fcBusy, setFcBusy] = useState(false);
  const [fcError, setFcError] = useState<string | null>(null);

  const startStripeFcLink = async () => {
    if (!application || !stripePromise) {
      setFcError("Stripe is not configured yet.");
      return;
    }
    setFcBusy(true);
    setFcError(null);
    try {
      const stripe = await stripePromise;
      if (!stripe) throw new Error("Could not load Stripe");

      // 1. Backend creates a SetupIntent (type us_bank_account, FC enabled)
      const sessionRes = await fetch(apiUrl(`/api/advance/applications/${application.id}/stripe/fc/create-session`), {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      });
      const sessionData = await sessionRes.json();
      if (!sessionRes.ok) throw new Error(sessionData.error?.error_message || "Could not start bank linking");

      // 2. collectBankAccountForSetup launches FC under the hood and walks
      //    the user through bank selection + auth. Returns a SetupIntent
      //    with payment_method populated (or null if user cancelled).
      //
      //    Cast for types — @stripe/stripe-js may not declare these
      //    methods in older minor versions; runtime support is fine.
      const stripeBank = stripe as unknown as {
        collectBankAccountForSetup: (args: {
          clientSecret: string;
          params: {
            payment_method_type: "us_bank_account";
            payment_method_data: {
              billing_details: { name?: string; email?: string };
            };
          };
        }) => Promise<{
          setupIntent?: { id: string; status: string; payment_method?: string | { id: string } };
          error?: { message?: string; code?: string };
        }>;
        confirmUsBankAccountSetup: (clientSecret: string) => Promise<{
          setupIntent?: { id: string; status: string };
          error?: { message?: string; code?: string };
        }>;
      };

      const collectResult = await stripeBank.collectBankAccountForSetup({
        clientSecret: sessionData.client_secret,
        params: {
          payment_method_type: "us_bank_account",
          payment_method_data: {
            billing_details: {
              name: application.customer.name,
              email: application.customer.email,
            },
          },
        },
      });
      if (collectResult.error) {
        if (collectResult.error.code === "setup_intent_unexpected_state") {
          throw new Error("Your bank-linking session expired. Please try again.");
        }
        throw new Error(collectResult.error.message || "Bank linking was cancelled.");
      }

      // 3. If the SetupIntent is requires_confirmation, confirm it.
      //    Confirmation finalizes PM creation + attachment.
      if (collectResult.setupIntent?.status === "requires_confirmation") {
        const confirmResult = await stripeBank.confirmUsBankAccountSetup(sessionData.client_secret);
        if (confirmResult.error) {
          throw new Error(confirmResult.error.message || "Could not finalize bank setup.");
        }
      }

      // 4. Tell the backend to retrieve the SetupIntent and save the
      //    PaymentMethod + FC account id.
      const completeRes = await fetch(apiUrl(`/api/advance/applications/${application.id}/stripe/fc/complete`), {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      });
      const completeData = await completeRes.json();
      if (!completeRes.ok) throw new Error(completeData.error?.error_message || "Could not finalize bank link");

      if (completeData.application) setApplication(completeData.application);
    } catch (e) {
      setFcError(e instanceof Error ? e.message : "Something went wrong with bank linking.");
    } finally {
      setFcBusy(false);
    }
  };

  useEffect(() => {
    if (!application || !token) return;
    const search = window.location.search;
    const isReturn = search.includes("connect_complete=1");
    const isRefresh = search.includes("connect_refresh=1");
    if (!isReturn && !isRefresh) return;
    setStripeConnectBusy(true);
    fetch(apiUrl(`/api/advance/applications/${application.id}/stripe/connect/refresh-status`), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    })
      .then(r => r.json())
      .then(d => {
        if (d.application) setApplication(d.application);
        if (d.status && d.status !== "ready" && d.status !== "onboarding") {
          setStripeConnectError("Your bank account couldn't be set up. Please try again or pick a different payout method.");
        }
        window.history.replaceState({}, "", window.location.pathname);
      })
      .catch(() => setStripeConnectError("We couldn't confirm your bank setup. Please try again."))
      .finally(() => setStripeConnectBusy(false));
  }, [application?.id, token]);

  const startStripeConnectOnboarding = async () => {
    if (!application) return;
    setStripeConnectBusy(true);
    setStripeConnectError(null);
    try {
      const res = await fetch(apiUrl(`/api/advance/applications/${application.id}/stripe/connect/onboarding-link`), {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ origin: window.location.origin }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.error_message || "Could not start direct deposit setup");
      if (!data.url) throw new Error("Stripe Connect did not return a redirect URL");
      window.location.href = data.url;
    } catch (e) {
      setStripeConnectError(e instanceof Error ? e.message : "Something went wrong");
      setStripeConnectBusy(false);
    }
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

  // Membership subscription is bundled into the Card step now — the same
  // card the user saves for repayment is used to back the $3.99/mo
  // subscription. No separate Stripe Checkout step. The backend's
  // /stripe/save-payment-method endpoint creates the subscription
  // automatically when the card is saved. Standalone Stripe Checkout
  // endpoints (/subscription/checkout-session, /subscription/sync) are
  // kept on the backend as a fallback but no longer called from this UI.


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
                    <span className={styles.ldEyebrowDot} aria-hidden="true" />
                    AI-powered · No credit check · 0% interest
                  </span>
                  <h1 className={styles.ldH1}>
                    Cash before<br />
                    <span className={styles.ldH1Accent}>your paycheck.</span>
                  </h1>
                  <div className="mt-6">
          <p className={styles.ldHeroSub}>
                    Up to <strong>$300 in your account today</strong>. Repay on your next payday — 0% interest, no late fees, no credit pull. Just $3.99/month for membership.
                  </p>
                  </div>
        
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
                      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                        <circle cx="6" cy="6" r="2.5" stroke="currentColor" strokeWidth="1.4" />
                        <circle cx="11" cy="7" r="2" stroke="currentColor" strokeWidth="1.4" />
                        <path d="M2 13c0-2 2-3 4-3s4 1 4 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                        <path d="M9 13c0-1.5 1.5-2.5 3-2.5s2.5 1 2.5 2.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                      </svg>
                      <strong>700,000+</strong>&nbsp;members
                    </li>
                    <li>
                      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                        <path d="M8 1.5l1.85 4.05L14 6.2l-3.15 2.75L11.7 13 8 10.85 4.3 13l.85-4.05L2 6.2l4.15-.65L8 1.5z" fill="currentColor" />
                      </svg>
                      <strong>4.7</strong>&nbsp;on Trustpilot
                    </li>
                    <li>
                      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                        <path d="M8 1.5l1.4 3.6 3.6 1.4-3.6 1.4L8 11.5l-1.4-3.6L3 6.5l3.6-1.4L8 1.5z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" fill="none" />
                        <circle cx="13" cy="13" r="1.2" fill="currentColor" />
                      </svg>
                      AI-powered approvals
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

            {/* ── 2b. Delivery options (the #1 selling point) ──────────────── */}
            <section className={styles.ldDelivery}>
              <div className={styles.ldContainer}>
                <div className={styles.ldDeliveryHeader}>
                  <span className={styles.ldKicker}>The advance way</span>
                  <h2 className={styles.ldH2}>
                    Get your cash<br />
                    <span className={styles.ldH1Accent} style={{ background: "linear-gradient(120deg, #0d5234 0%, #1a8a55 100%)", WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent" }}>your way.</span>
                  </h2>
                  <p className={styles.ldLead}>
                    Zelle to your bank. Cash App to your $cashtag. PayPal if that&apos;s your thing. You pick how it lands.
                  </p>
                </div>
                <div className={styles.ldDeliveryGrid}>
                  {/* Zelle */}
                  <div className={`${styles.ldDeliveryCard} ${styles.ldDeliveryCardZelle}`}>
                    <div className={styles.ldDeliveryAmbient} aria-hidden="true" />
                    <div className={styles.ldDeliveryIcon}>
                      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                        <path d="M7 7h10L7 17h10" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </div>
                    <p className={styles.ldDeliveryBrand}>Zelle</p>
                    <h3>Straight to your bank</h3>
                    <p>Lands in your linked bank in minutes — no extra fees on top.</p>
                  </div>

                  {/* Cash App */}
                  <div className={`${styles.ldDeliveryCard} ${styles.ldDeliveryCardCashApp}`}>
                    <div className={styles.ldDeliveryAmbient} aria-hidden="true" />
                    <div className={styles.ldDeliveryIcon}>
                      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                        <path d="M12 4v16M16 8.5c-1.4-1-3-1.5-4.5-1.5-2 0-3.5 1-3.5 2.5s1.5 2.4 4 3 4 1.2 4 2.7-1.5 2.5-3.5 2.5c-1.5 0-3.1-.6-4.5-1.5" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </div>
                    <p className={styles.ldDeliveryBrand}>Cash App</p>
                    <h3>Hits your $cashtag</h3>
                    <p>Send the advance straight to your Cash App balance — same day.</p>
                  </div>

                  {/* PayPal */}
                  <div className={`${styles.ldDeliveryCard} ${styles.ldDeliveryCardPayPal}`}>
                    <div className={styles.ldDeliveryAmbient} aria-hidden="true" />
                    <div className={styles.ldDeliveryIcon}>
                      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                        <path d="M8 4h7c2.5 0 4.5 1.8 4.5 4.5S17.5 13 15 13h-3.5L10 20" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                        <path d="M6 7h6c2 0 3.5 1.5 3.5 3.5S14 14 12 14H8.5" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" opacity="0.6" />
                      </svg>
                    </div>
                    <p className={styles.ldDeliveryBrand}>PayPal</p>
                    <h3>To your PayPal balance</h3>
                    <p>Already on PayPal? Funds land in your wallet, no extra steps.</p>
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
                  Membership is <strong>$3.99/month</strong>. Instant transfers are <strong>$5</strong>. No interest, no late fees, no credit pull.
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

            {/* ── 6. Raffle ────────────────────────────────────────────────── */}
            <section className={styles.ldRaffle} id="raffle">
              <div className={styles.ldContainer}>
                <div className={styles.ldRaffleGrid}>
                  <div>
                    <span className={styles.ldRaffleKicker}>Member perk</span>
                    <h2 className={styles.ldRaffleHeadline}>
                      Win a trip<br />
                      <span className={styles.ldRaffleAccent}>to Cancún.</span>
                    </h2>
                    <p className={styles.ldRaffleSub}>
                      Every active member is automatically entered in our all-inclusive Cancún getaway. Stay current on your advances — you&apos;re in.
                    </p>
                    <button type="button" onClick={goSignup} className={styles.ldBtnDarkLg}>
                      Become a member <span aria-hidden="true">→</span>
                    </button>
                  </div>
                  <div className={styles.ldRaffleVisual}>
                    <div className={styles.ldTicket}>
                      <div className={styles.ldTicketTop}>
                        <span className={styles.ldTicketBrand}>advance<span>.</span></span>
                        <span className={styles.ldTicketSerial}>Q1 · 2026</span>
                      </div>
                      <div className={styles.ldTicketDivider}>
                        <span /><span /><span /><span /><span /><span /><span /><span /><span /><span /><span /><span />
                      </div>
                      <p className={styles.ldTicketLabel}>Quarterly getaway</p>
                      <div className={styles.ldTicketDest}>Cancún <span aria-hidden="true">🏖️</span></div>
                      <p className={styles.ldTicketCash}>All-inclusive · 4 days · 2 guests</p>
                      <div className={styles.ldTicketFooter}>
                        <span>Next draw</span>
                        <strong>April 1, 2026</strong>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </section>

            {/* ── 7. British angle / story teaser ──────────────────────────── */}
            <section className={styles.ldBritish}>
              <div className={styles.ldContainer}>
                <div className={styles.ldBritishGrid}>
                  <div>
                    <span className={styles.ldKicker}>Our story</span>
                    <h2 className={styles.ldH2}>
                      Built by guys in England.<br />
                      For America.
                    </h2>
                    <div className="mt-6">
        <p className={styles.ldLead}>
                      We came from England with an idea. We ran focus groups with Americans to hear how they really live between paychecks — and built what they actually needed: cash before payday, without the loan-shark nonsense.
                    </p>
                    </div>

                    <p className={styles.ldLead} style={{ marginTop: "16px" }}>
                      If we got something wrong — and we&apos;re Englishmen who drink tea, say sorry too much, and still call it football — <a href="mailto:usa@getbits.app" className={styles.ldInlineLink}>email us</a> and tell us off.
                    </p>
                    <a href="/story" className={styles.ldStoryLink}>
                      Read our story <span aria-hidden="true">→</span>
                    </a>
                  </div>
                  <div className={styles.ldBritishPhotoWrap}>
                    <div className={styles.ldBritishPhotoFrame}>
                      <img src="/founder-1.jpeg" alt="One of the advance founders." className={styles.ldBritishPhoto} />
                    </div>
                    <div className={styles.ldBritishPhotoTag}>
                      <strong>Made in England</strong>
                      <span>Built for America</span>
                    </div>
                  </div>
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
                      ["What states is advance available in?", "Currently 36 US states. If we're not in your state yet, you can join the waitlist."],
                      ["How much can I borrow?", "Up to $300 per advance. First-time members typically qualify for $50–$150 based on their pay history."],
                      ["How does repayment work?", "Automatic — on your next payday, we debit the amount you borrowed. You can also repay early at any time, free."],
                      ["Is there a membership fee?", "Yes — $3.99 per month for membership. Instant (same-hour) transfers are $5. No interest, no late fees, no credit pull."],
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
                <div className="mb-6">
                   <p className={styles.ldCtaSub}>Get started in 2 minutes. No credit check. No commitment.</p>
                </div>
    
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
    }

    // ── Referral gate ────────────────────────────────────────────────────────
    if (view === "referral") {
      return (
        <div className={styles.ldPage}>
          <header className={styles.ldNav}>
            <div className={styles.ldNavInner}>
              <a className={styles.ldBrand} href="/" onClick={(e) => { e.preventDefault(); setView("landing"); }}>
                <span className={styles.ldBrandMark}>
                  <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true">
                    <circle cx="11" cy="11" r="10" fill="#fff" />
                    <path d="M6 13l3 3 7-8" stroke="#0d5234" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
                advance<span className={styles.ldBrandDot}>.</span>
              </a>
              <div className={styles.ldNavCtas}>
                <a href="/loan" className={styles.ldLinkBtn}>Sign in</a>
              </div>
            </div>
          </header>

          <main className={styles.ldGate}>
            <div className={styles.ldGateInner}>
              <span className={styles.ldEyebrow}>
                <span className={styles.ldEyebrowDot} aria-hidden="true" />
                Invite-only early access
              </span>
              <h1 className={styles.ldGateH1}>You got the hook-up?</h1>
              <p className={styles.ldGateLead}>
                Advance is growing through word of mouth. Enter the code from whoever invited you to continue.
              </p>

              <div className={styles.ldGateCard}>
                <label htmlFor="gate-code-input" className={styles.ldGateLabel}>
                  Your invite code
                </label>
                <input
                  id="gate-code-input"
                  type="text"
                  autoComplete="off"
                  placeholder="Enter your code"
                  value={gateCode}
                  onChange={(e) => { setGateCode(e.target.value); setGateValid(null); setError(null); }}
                  onKeyDown={(e) => e.key === "Enter" && document.getElementById("gate-continue")?.click()}
                  className={`${styles.ldGateInput} ${gateValid === false ? styles.ldGateInputInvalid : ""} ${gateValid === true ? styles.ldGateInputValid : ""}`}
                />
                {gateValid === true && (
                  <p className={styles.ldGateValidMsg}>
                    <span aria-hidden="true">✓</span> {gateReferrerName ? `Referred by ${gateReferrerName}` : "Code accepted"}
                  </p>
                )}
                {gateValid === false && (
                  <p className={styles.ldGateInvalidMsg}>
                    That code isn&apos;t recognized. Check with whoever referred you and try again.
                  </p>
                )}
                {error && <p className={styles.ldGateError}>{error}</p>}
                <button
                  id="gate-continue"
                  type="button"
                  className={styles.ldGateBtn}
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
                  {gateBusy ? "Checking…" : <>Continue <span aria-hidden="true">→</span></>}
                </button>
              </div>

              <p className={styles.ldGateFootNote}>
                Already have an account? <a href="/loan" className={styles.ldGateFootLink}>Sign in →</a>
              </p>

              <ul className={styles.ldGateTrust} aria-label="What you get">
                <li>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="M5 12l4 4L19 6" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  No credit check
                </li>
                <li>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="M5 12l4 4L19 6" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  0% interest
                </li>
                <li>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="M5 12l4 4L19 6" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  Cancel anytime
                </li>
              </ul>
            </div>
          </main>
        </div>
      );
    }

    // ── Signup ────────────────────────────────────────────────────────────────
    return (
      <div className={styles.ldPage}>
        {isDateFocused && <div className={styles.backdrop} />}

        <header className={styles.ldNav}>
          <div className={styles.ldNavInner}>
            <a className={styles.ldBrand} href="/" onClick={(e) => { e.preventDefault(); setView("landing"); }}>
              <span className={styles.ldBrandMark}>
                <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true">
                  <circle cx="11" cy="11" r="10" fill="#fff" />
                  <path d="M6 13l3 3 7-8" stroke="#0d5234" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
              advance<span className={styles.ldBrandDot}>.</span>
            </a>
            <a href="/loan" className={styles.ldLinkBtn}>Sign in</a>
          </div>
        </header>

        <main className={styles.ldSignup}>
          <div className={styles.ldSignupInner}>
            {/* Slim single progress bar replaces the redundant 3-dot+eyebrow combo */}
            <div className={styles.ldSignupProgressBar} aria-label="Signup progress">
              <div className={styles.ldSignupProgressMeta}>
                <span className={styles.ldSignupProgressStep}>Step 1 of 3</span>
                <span className={styles.ldSignupProgressNext}>Next: Connect bank</span>
              </div>
              <div className={styles.ldSignupProgressTrack} aria-hidden="true">
                <div className={styles.ldSignupProgressFill} style={{ width: `${(1 / 3) * 100}%` }} />
              </div>
            </div>

            <div className={styles.ldSignupHeader}>
              <h1 className={styles.ldSignupH1}>Tell us about yourself</h1>
              <p className={styles.ldSignupLead}>
                Takes about 2 minutes — your info is encrypted and never sold.
              </p>
              <p className={styles.ldSignupReassure}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <rect x="5" y="11" width="14" height="9" rx="2" stroke="currentColor" strokeWidth="2" />
                  <path d="M8 11V8a4 4 0 018 0v3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
                No hard credit check — ever. Zero impact on your credit score.
              </p>
            </div>

            <form className={styles.ldSignupForm} onSubmit={handleSignupSubmit}>
              <section className={styles.ldSignupSection}>
                <header className={styles.ldSignupSectionHead}>
                  <span className={styles.ldSignupSectionIcon} aria-hidden="true">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                      <circle cx="12" cy="8" r="4" stroke="currentColor" strokeWidth="2" />
                      <path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                    </svg>
                  </span>
                  <div>
                    <h2 className={styles.ldSignupSectionTitle}>Personal information</h2>
                    <p className={styles.ldSignupSectionSub}>Who you are — for ID verification.</p>
                  </div>
                </header>
                <div className={styles.ldSignupGrid}>
                  <label className={styles.ldSignupField}>
                    <span className={styles.ldSignupFieldLabel}>Full name</span>
                    <input className={styles.ldSignupInput} required value={form.name} placeholder="Jane Smith"
                      onChange={(event) => setForm({ ...form, name: event.target.value })} />
                  </label>
                  <label className={styles.ldSignupField}>
                    <span className={styles.ldSignupFieldLabel}>Email address</span>
                    <input className={styles.ldSignupInput} required type="email" value={form.email} placeholder="jane@example.com"
                      onChange={(event) => setForm({ ...form, email: event.target.value })} />
                  </label>
                  <label className={styles.ldSignupField}>
                    <span className={styles.ldSignupFieldLabel}>Phone number</span>
                    <input className={styles.ldSignupInput} required value={form.phone} placeholder="(555) 000-0000"
                      onChange={(event) => setForm({ ...form, phone: event.target.value })} />
                  </label>
                  <label className={styles.ldSignupField}>
                    <span className={styles.ldSignupFieldLabel}>Date of birth</span>
                    <input className={styles.ldSignupInput} required type="date" value={form.dob}
                      max={new Date(new Date().setFullYear(new Date().getFullYear() - 18)).toISOString().slice(0, 10)}
                      onChange={(event) => setForm({ ...form, dob: event.target.value })} />
                  </label>
                  <label className={`${styles.ldSignupField} ${styles.ldSignupFieldFull}`}>
                    <span className={styles.ldSignupFieldLabel}>State</span>
                    <div className={styles.ldSignupSelectWrap}>
                      <select
                        className={styles.ldSignupSelect}
                        required
                        value={form.state}
                        onChange={(e) => setForm({ ...form, state: e.target.value })}
                      >
                        <option value="" disabled>Select state…</option>
                        {US_STATES.map(s => <option key={s} value={s}>{s}</option>)}
                      </select>
                      <svg className={styles.ldSignupSelectCaret} width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                        <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </div>
                  </label>
                </div>
              </section>

              <section className={styles.ldSignupSection}>
                <header className={styles.ldSignupSectionHead}>
                  <span className={styles.ldSignupSectionIcon} aria-hidden="true">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                      <path d="M12 6v12M9 9h4.5a2.5 2.5 0 010 5h-3a2.5 2.5 0 000 5H15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                    </svg>
                  </span>
                  <div>
                    <h2 className={styles.ldSignupSectionTitle}>Income</h2>
                    <p className={styles.ldSignupSectionSub}>How you get paid.</p>
                  </div>
                </header>
                <div className={styles.ldSignupIncomeList}>
                  {form.income_sources.map((src, i) => (
                    <div key={i} className={styles.ldSignupIncomeCard}>
                      {form.income_sources.length > 1 && (
                        <div className={styles.ldSignupIncomeHead}>
                          <strong>Income source {i + 1}</strong>
                          <button type="button" onClick={() => removeSource(i)} className={styles.ldSignupIncomeRemove}>
                            Remove
                          </button>
                        </div>
                      )}
                      <div className={styles.ldSignupGrid}>
                        <label className={styles.ldSignupField}>
                          <span className={styles.ldSignupFieldLabel}>Employer</span>
                          <input className={styles.ldSignupInput} required value={src.employer} placeholder="Acme Corp"
                            onChange={e => updateSource(i, "employer", e.target.value)} />
                        </label>
                        <label className={styles.ldSignupField}>
                          <span className={styles.ldSignupFieldLabel}>
                            Next payday <span className={styles.ldSignupHint}>(within the next 30 days)</span>
                          </span>
                          <input className={styles.ldSignupInput} required min={today} max={thirtyDaysFromNow} type="date" value={src.payday}
                            onChange={e => updateSource(i, "payday", e.target.value)} />
                        </label>
                      </div>
                    </div>
                  ))}
                  <button type="button" onClick={addSource} className={styles.ldSignupAddSource}>
                    <span className={styles.ldSignupAddSourceIcon} aria-hidden="true">+</span>
                    Add another income source
                  </button>
                </div>
              </section>

              <section className={styles.ldSignupSection}>
                <header className={styles.ldSignupSectionHead}>
                  <span className={styles.ldSignupSectionIcon} aria-hidden="true">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                      <path d="M12 3l8 4v6c0 5-3.5 9-8 10-4.5-1-8-5-8-10V7l8-4z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
                      <path d="M9 12l2 2 4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </span>
                  <div>
                    <h2 className={styles.ldSignupSectionTitle}>Verification &amp; security</h2>
                    <p className={styles.ldSignupSectionSub}>Required to legally send money. Encrypted in transit.</p>
                  </div>
                </header>
                <div className={styles.ldSignupGrid}>
                  <label className={`${styles.ldSignupField} ${styles.ldSignupFieldFull}`}>
                    <span className={styles.ldSignupFieldLabel}>Social Security Number</span>
                    <input
                      className={styles.ldSignupInput}
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
                  <label className={styles.ldSignupField}>
                    <span className={styles.ldSignupFieldLabel}>Create a password</span>
                    <input className={styles.ldSignupInput} required type="password" minLength={6} placeholder="Min. 6 characters"
                      autoComplete="new-password"
                      value={form.password}
                      onChange={(event) => setForm({ ...form, password: event.target.value })} />
                  </label>
                  <label className={styles.ldSignupField}>
                    <span className={styles.ldSignupFieldLabel}>Confirm password</span>
                    <input className={styles.ldSignupInput} required type="password" autoComplete="new-password"
                      value={form.confirmPassword}
                      onChange={(event) => setForm({ ...form, confirmPassword: event.target.value })} />
                  </label>
                </div>
              </section>

              {error && <p className={styles.ldSignupError}>{error}</p>}

              <p className={styles.ldSignupTerms}>
                By submitting this form and creating an account, you confirm that you have read, understood, and agree to be bound by our{" "}
                <a href="/terms" target="_blank" rel="noopener noreferrer" className={styles.ldSignupTermsLink}>Terms &amp; Conditions</a>
                ,{" "}
                <a href="/privacy" target="_blank" rel="noopener noreferrer" className={styles.ldSignupTermsLink}>Privacy Policy</a>
                , and{" "}
                <a href="/consent" target="_blank" rel="noopener noreferrer" className={styles.ldSignupTermsLink}>Consent to the Use of Electronic Documents and Signatures</a>
                , including the state-specific provisions that apply to your state of residence. We never pull your credit and we will never send your account to collections.
              </p>

              <button disabled={isBusy} className={styles.ldSignupSubmit}>
                {isBusy ? "Creating account…" : <>Continue <span aria-hidden="true">→</span></>}
              </button>
            </form>
          </div>
        </main>
      </div>
    );

  }

  // ── Waitlist screen (non-eligible state — cannot proceed past here) ─────────
  // Backend sets subscription_status='waitlisted' for non-eligible states without a personal referral.
  // neworleans (master gate key) grants signup access but does NOT bypass state eligibility.
  const stateIsIneligible = application.subscription_status === 'waitlisted';
  if (stateIsIneligible) {
    const stateName = application.customer.state || "your state";
    return (
      <div className={styles.ldPage}>
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
            <button type="button" className={styles.ldLinkBtn} onClick={handleLogout}>Sign out</button>
          </div>
        </header>

        <main className={styles.ldFlow}>
          <motion.div className={styles.ldFlowInner} data-wide="true" variants={flowPageVariants} initial="hidden" animate="visible">
            <div className={styles.ldFlowHeader}>
              <span className={styles.ldEyebrow}>
                <span className={styles.ldEyebrowDot} aria-hidden="true" />
                You&apos;re in line
              </span>
              <h1 className={styles.ldFlowH1}>
                We&apos;re coming to <span className={styles.ldFlowH1Accent}>{stateName}!</span>
              </h1>
              <p className={styles.ldFlowLead}>
                Advance is live in 36 states today. We&apos;re expanding fast — {stateName} is on the roadmap. You&apos;ll get an email the moment we go live.
              </p>
            </div>

            <div className={styles.ldFlowInfoCard}>
              <p className={styles.ldFlowInfoCardTitle}>
                <span aria-hidden="true">✅</span> You&apos;re confirmed
              </p>
              <p className={styles.ldFlowInfoCardBody}>
                We&apos;ll email <strong>{application.customer.email}</strong> as soon as Advance launches in {stateName}.
              </p>
            </div>

            <div className={styles.ldFlowBenefitsGrid}>
              {[
                { icon: "🚫", title: "No credit check, ever", sub: "We won't pull your credit now or when we launch. Your score is safe." },
                { icon: "💸", title: "Instant access at launch", sub: "When we go live in your state, you'll skip the line — your account is ready to go." },
                { icon: "🔒", title: "Your data is safe", sub: "We've stored your information securely. We will never sell it or share it with advertisers." },
                { icon: "🎰", title: "Weekly $300 raffle", sub: "Once Advance is live in your state, you'll be automatically entered in our weekly cash raffle." },
              ].map(({ icon, title, sub }) => (
                <div key={title} className={styles.ldFlowBenefitCard}>
                  <span className={styles.ldFlowBenefitIcon} aria-hidden="true">{icon}</span>
                  <p className={styles.ldFlowBenefitTitle}>{title}</p>
                  <p className={styles.ldFlowBenefitSub}>{sub}</p>
                </div>
              ))}
            </div>

            <p className={styles.ldFlowContact}>
              Questions? Reach us at <a href="mailto:usa@getbits.app" className={styles.ldFlowContactLink}>usa@getbits.app</a>
            </p>
          </motion.div>
        </main>
      </div>
    );
  }

  // ── Denied screen (shown instead of raw "Denied" status) ────────────────────
  if (application.status === 'denied') {
    return (
      <div className={styles.ldPage}>
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
            <button type="button" className={styles.ldLinkBtn} onClick={handleLogout}>Sign out</button>
          </div>
        </header>

        <main className={styles.ldFlow}>
          <motion.div className={styles.ldFlowInner} data-wide="true" variants={flowPageVariants} initial="hidden" animate="visible">
            <div className={styles.ldFlowHeader}>
              <span className={styles.ldEyebrow}>
                <span className={styles.ldEyebrowDot} aria-hidden="true" />
                Application update
              </span>
              <h1 className={styles.ldFlowH1}>Not quite ready yet.</h1>
              <p className={styles.ldFlowLead}>
                We weren&apos;t able to approve your advance at this time — but this isn&apos;t permanent. Many members get approved on a second try once their income history builds up.
              </p>
            </div>

            <div className={styles.ldFlowInfoCard}>
              <p className={styles.ldFlowInfoCardTitle}>
                <span aria-hidden="true">💌</span> No mark on your credit
              </p>
              <p className={styles.ldFlowInfoCardBody}>
                We never reported anything to any credit bureau. Your score is exactly where it was.
              </p>
            </div>

            <div className={styles.ldFlowBenefitsGrid}>
              {[
                { icon: "📅", title: "Consistent deposit history", sub: "A few more pay cycles showing regular deposits can make a big difference. Try again in 30–60 days." },
                { icon: "🏦", title: "Keep your bank connected", sub: "Your account is still active. When you're ready to reapply, your bank connection will still be in place." },
                { icon: "🚫", title: "No collections, ever", sub: "We'll never refer you to a debt collector, sell your information, or file a lawsuit — unconditionally." },
                { icon: "📩", title: "Get in touch", sub: "If you think this was a mistake or have questions, email us. We review every message personally." },
              ].map(({ icon, title, sub }) => (
                <div key={title} className={styles.ldFlowBenefitCard}>
                  <span className={styles.ldFlowBenefitIcon} aria-hidden="true">{icon}</span>
                  <p className={styles.ldFlowBenefitTitle}>{title}</p>
                  <p className={styles.ldFlowBenefitSub}>{sub}</p>
                </div>
              ))}
            </div>

            <button
              type="button"
              className={styles.ldFlowBtn}
              disabled={reapplyBusy}
              onClick={handleReapply}
            >
              {reapplyBusy ? "Resubmitting…" : <>Reapply <span aria-hidden="true">→</span></>}
            </button>
            {error && <p className={styles.ldFlowError} style={{ marginTop: "12px", textAlign: "center" }}>{error}</p>}

            <p className={styles.ldFlowContact}>
              Questions? Email <a href="mailto:usa@getbits.app" className={styles.ldFlowContactLink}>usa@getbits.app</a>
            </p>
          </motion.div>
        </main>
      </div>
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
      <div className={styles.ldPage}>
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
            <button type="button" className={styles.ldLinkBtn} onClick={handleLogout}>Sign out</button>
          </div>
        </header>

        <main className={styles.ldFlow}>
          <motion.div className={styles.ldFlowInner} data-wide="true" variants={flowPageVariants} initial="hidden" animate="visible">
            <div className={styles.ldFlowHeader}>
              <span className={styles.ldEyebrow}>
                <span className={styles.ldEyebrowDot} aria-hidden="true" />
                You&apos;re approved
              </span>
              <h1 className={styles.ldFlowH1}>
                <span className={styles.ldFlowH1Accent}>$25</span> is on its way <span aria-hidden="true">🎉</span>
              </h1>
              <p className={styles.ldFlowLead}>
                Your first advance is <strong>$25</strong>. Pay it back on time and your limit grows — all the way up to $200.
              </p>
            </div>

            {application.offer_expires_at && (() => {
              const exp = new Date(application.offer_expires_at);
              const timeStr = exp.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", timeZoneName: "short" });
              return (
                <div className={styles.ldFlowExpiry}>
                  <span aria-hidden="true">⏰</span>
                  <p>
                    <strong>This offer expires tonight at {timeStr}.</strong> If you don&apos;t choose a delivery method before then, your offer will be cancelled and you&apos;ll need to reapply.
                  </p>
                </div>
              );
            })()}

            <div className={styles.ldFlowInfoCard}>
              <p className={styles.ldFlowInfoCardTitle}>How trust-building works</p>
              <p className={styles.ldFlowInfoCardBody}>
                Every on-time repayment earns you a higher limit on your next advance. We start small because we&apos;re just getting to know each other — but the more history we build together, the more we can offer you.
              </p>
            </div>

            <p className={styles.ldFlowLadderLabel}>Your advance limit roadmap</p>
            <div className={styles.ldFlowLadder}>
              {milestones.map((m) => (
                <div
                  key={m.amount}
                  className={styles.ldFlowLadderRung}
                  data-current={m.current}
                >
                  {m.current && (
                    <span className={styles.ldFlowLadderPin}>You are here</span>
                  )}
                  <p className={styles.ldFlowLadderAmount}>{m.amount}</p>
                  <p className={styles.ldFlowLadderLabelText}>{m.label}</p>
                </div>
              ))}
            </div>

            <div className={styles.ldFlowBenefitsGrid}>
              {[
                { icon: "📅", title: "Repay on payday", sub: "Your advance is automatically due on your next payday. Repay on time to unlock a higher limit." },
                { icon: "🚫", title: "No credit bureau reporting", sub: "We never report anything to any credit bureau — good or bad. Your score is always safe." },
                { icon: "🔄", title: "No rollover, no interest", sub: "This isn't a loan. There's zero interest and you can't roll over your balance. Just pay back what you got." },
                { icon: "🛡️", title: "We never chase you", sub: "If repayment fails, we write it off. No collections, no lawsuits, no debt buyers — ever." },
              ].map(({ icon, title, sub }) => (
                <div key={title} className={styles.ldFlowBenefitCard}>
                  <span className={styles.ldFlowBenefitIcon} aria-hidden="true">{icon}</span>
                  <p className={styles.ldFlowBenefitTitle}>{title}</p>
                  <p className={styles.ldFlowBenefitSub}>{sub}</p>
                </div>
              ))}
            </div>

            <button
              type="button"
              className={styles.ldFlowBtn}
              onClick={() => setTrustScreenSeen(true)}
            >
              Choose how to receive my $25 <span aria-hidden="true">→</span>
            </button>
          </motion.div>
        </main>
      </div>
    );
  }

  // ── Pre-bank onboarding pages ─────────────────────────────────────────────
  // 6-step linear flow between signup and the main dashboard. Each step has
  // its own gate; the order in this file determines the order users see.
  //   1. Benefits        — pitch what they're signing up for
  //   2. Receive money   — pick payout method (PayPal/Cash App/Zelle) + confirm
  //   3. Trust           — milestone ladder, how trust-building works
  //   4. Card            — backup repayment card (Stripe). Saving the card
  //                        ALSO activates the $3.99/mo membership subscription
  //                        (handled server-side in /stripe/save-payment-method).
  //   5. Delivery speed  — same-day ($5) vs 3-5 days (free)
  //   6. Bank            — verify income via Plaid Hosted Link
  // Eligible users land in subscription_status='pending_payment' at signup;
  // saving a card flips them to 'active'. Pre-bank screens render for both
  // states so the user can progress through Steps 1-4 before card save.
  const preBankActive =
    application.status === "intake" &&
    (application.subscription_status === "active" || application.subscription_status === "pending_payment") &&
    !application.plaid_connected;

  // Benefits + Trust pitch screens removed per client — users go straight to action.

  // Step 1 of 4: receive money — single-select PayPal/Cash App/Zelle/ACH
  const payoutAlreadySaved = !!(application.payout_methods && application.payout_contact);
  if (preBankActive && (!payoutAlreadySaved || wantsToChangePayout)) {
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
      {
        id: "ACH",
        name: "Bank account (ACH)",
        placeholder: "",
        label: "",
        logo: (
          <span style={{
            display: "inline-flex", alignItems: "center", justifyContent: "center",
            width: "3.6rem", height: "3.6rem", borderRadius: "0.8rem",
            background: "var(--brand)", color: "white", fontSize: "2rem",
            flexShrink: 0,
          }}>🏦</span>
        ),
      },
    ];
    const selectedId = payoutMethods[0];
    const selectedMethod = methods.find(m => m.id === selectedId);
    const isAch = selectedId === "ACH";
    const achStatus = application.stripe_connect_status;
    const achReady = isAch && achStatus === "ready";
    return (
      <div className={styles.ldPage}>
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
            <button type="button" className={styles.ldLinkBtn} onClick={handleLogout}>Sign out</button>
          </div>
        </header>

        <main className={styles.ldFlow}>
          <div className={styles.ldFlowAmbient} aria-hidden="true" />
          <motion.div
            className={styles.ldFlowInner}
            variants={flowPageVariants}
            initial="hidden"
            animate="visible"
          >
            <motion.div className={styles.ldFlowProgress} variants={flowChildVariants} aria-label="Onboarding progress">
              <div className={styles.ldFlowProgressMeta}>
                <span className={styles.ldFlowProgressStep}>Step 1 of 4</span>
                <span className={styles.ldFlowProgressNext}>Receive money</span>
              </div>
              <div className={styles.ldFlowProgressTrack} aria-hidden="true">
                <motion.div
                  className={styles.ldFlowProgressFill}
                  initial={{ width: 0 }}
                  animate={{ width: `${(1 / 4) * 100}%` }}
                  transition={{ delay: 0.2, duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
                />
              </div>
            </motion.div>

            <motion.div className={styles.ldFlowHeader} variants={flowChildVariants}>
              <span className={styles.ldEyebrow}>
                <span className={styles.ldEyebrowDot} aria-hidden="true" />
                Receive money
              </span>
              <h1 className={styles.ldFlowH1}>Where should we send the cash?</h1>
              <p className={styles.ldFlowLead}>
                Pick one — we&apos;ll send your advance here once you&apos;re approved.
              </p>
            </motion.div>

            <motion.div className={styles.ldFlowMethods} variants={flowChildVariants}>
              {methods.map((m, i) => {
                const selected = selectedId === m.id;
                return (
                  <motion.button
                    key={m.id}
                    type="button"
                    onClick={() => {
                      setPayoutMethods([m.id]);
                      setPayoutSaved(false);
                      setPayoutError(null);
                    }}
                    className={styles.ldFlowMethod}
                    data-selected={selected}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.2 + i * 0.05, type: "spring", stiffness: 200, damping: 22 }}
                    whileTap={{ scale: 0.98 }}
                  >
                    {m.logo}
                    <span className={styles.ldFlowMethodName}>{m.name}</span>
                    {selected && (
                      <motion.span
                        className={styles.ldFlowMethodCheck}
                        initial={{ scale: 0, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        transition={{ type: "spring", stiffness: 400, damping: 22 }}
                        aria-hidden="true"
                      >
                        ✓
                      </motion.span>
                    )}
                  </motion.button>
                );
              })}
            </motion.div>

            {selectedMethod && !isAch && (
              <motion.label
                className={styles.ldFlowField}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ type: "spring", stiffness: 220, damping: 22 }}
              >
                <span className={styles.ldFlowFieldLabel}>{selectedMethod.label}</span>
                <input
                  type="text"
                  placeholder={selectedMethod.placeholder}
                  value={payoutContact}
                  onChange={(e) => { setPayoutContact(e.target.value); setPayoutSaved(false); setPayoutError(null); }}
                  className={styles.ldFlowInput}
                  autoFocus
                />
              </motion.label>
            )}

            {selectedMethod && !isAch && payoutContact.trim() && (
              <motion.div
                className={styles.ldFlowConfirmCard}
                initial={{ opacity: 0, scale: 0.98 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ type: "spring", stiffness: 240, damping: 22 }}
              >
                <p className={styles.ldFlowConfirmKicker}>Please confirm</p>
                <p className={styles.ldFlowConfirmBody}>
                  We&apos;ll send your advance to <strong>{selectedMethod.name}</strong> at <strong>{payoutContact.trim()}</strong>. Make sure this is correct — we can&apos;t recover funds sent to the wrong address.
                </p>
              </motion.div>
            )}

            {isAch && (
              <motion.div
                className={styles.ldFlowInfoCard}
                initial={{ opacity: 0, scale: 0.98 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ type: "spring", stiffness: 240, damping: 22 }}
              >
                <p className={styles.ldFlowInfoCardTitle}>Straight to your bank account</p>
                <p className={styles.ldFlowInfoCardBody}>
                  We&apos;ll send your advance via ACH. You&apos;ll connect your bank in the next step — one secure connection covers income verification, payout, and repayment.
                </p>
                <p className={styles.ldFlowInfoCardBody} style={{ marginTop: "6px" }}>
                  After connecting, we&apos;ll ask for a quick identity check (~30 seconds) so we can legally send you money.
                </p>
              </motion.div>
            )}

            {payoutError && <p className={styles.ldFlowError}>{payoutError}</p>}

            <motion.button
              type="button"
              className={styles.ldFlowBtn}
              disabled={payoutBusy || !selectedMethod || (!isAch && !payoutContact.trim())}
              onClick={async () => {
                await submitPayoutPreference();
                if (application) await loadApplication(application.id);
                setWantsToChangePayout(false);
              }}
              variants={flowChildVariants}
              whileTap={{ scale: 0.98 }}
            >
              {payoutBusy ? "Saving…" : isAch ? <>Continue <span aria-hidden="true">→</span></> : <>Yes, this is correct <span aria-hidden="true">→</span></>}
            </motion.button>

            {payoutAlreadySaved && (
              <div className={styles.ldFlowBackRow}>
                <button
                  type="button"
                  className={styles.ldFlowBackLink}
                  onClick={() => setWantsToChangePayout(false)}
                >
                  Cancel — keep my existing choice
                </button>
              </div>
            )}
          </motion.div>
        </main>
      </div>
    );
  }

  // Trust-ladder pitch removed per client. Approval-trust screen below still uses
  // trustScreenSeen as its own gate after approval (different page, kept).

  // Step 2 of 4: bank link via Stripe Financial Connections
  // ONE bank link powers: repayment debit, income verification, and ACH
  // payout (if user picked ACH at Step 2). Replaces both the old card
  // collection step AND the Plaid bank verification step (Step 6 below
  // becomes a no-op when stripe_fc_account_id is set).
  const hasBankPm = !!application.stripe_payment_method_id;
  const hasCardPm = !!application.stripe_card_pm_id;
  const isAchPayout = application.payout_methods === "ACH";
  const needsBankLink = !hasBankPm && !hasCardPm;
  const needsConnectIdentity = isAchPayout && hasBankPm && application.stripe_connect_status !== "ready";

  if (preBankActive && (needsBankLink || needsConnectIdentity)) {
    // Phase 4a: bank not linked yet → show FC link UI
    // Phase 4b: bank linked, but ACH user needs Connect identity → show identity-verify UI
    const showFc = needsBankLink;
    const showConnect = !needsBankLink && needsConnectIdentity;
    return (
      <div className={styles.ldPage}>
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
            <button type="button" className={styles.ldLinkBtn} onClick={handleLogout}>Sign out</button>
          </div>
        </header>

        <main className={styles.ldFlow}>
          <motion.div className={styles.ldFlowInner} variants={flowPageVariants} initial="hidden" animate="visible">
            <div className={styles.ldFlowProgress} aria-label="Onboarding progress">
              <div className={styles.ldFlowProgressMeta}>
                <span className={styles.ldFlowProgressStep}>Step 2 of 4</span>
                <span className={styles.ldFlowProgressNext}>{showConnect ? "Identity check" : "Connect bank"}</span>
              </div>
              <div className={styles.ldFlowProgressTrack} aria-hidden="true">
                <div className={styles.ldFlowProgressFill} style={{ width: `${(2 / 4) * 100}%` }} />
              </div>
            </div>

            <div className={styles.ldFlowHeader}>
              <span className={styles.ldEyebrow}>
                <span className={styles.ldEyebrowDot} aria-hidden="true" />
                {showConnect ? "Identity verification" : "Bank account & membership"}
              </span>
              <h1 className={styles.ldFlowH1}>
                {showConnect ? "One quick identity check." : "Connect your bank."}
              </h1>
              <p className={styles.ldFlowLead}>
                {showConnect
                  ? "We legally need to verify it's you before we can send money to your bank. Takes about 30 seconds on Stripe's secure form."
                  : "We use your bank to verify your income, send your advance, and collect repayment — all from one secure connection."}
              </p>
            </div>

            {showFc && (
              <>
                <div className={styles.ldFlowFeesCard}>
                  <p className={styles.ldFlowFeesKicker}>Your bank will be used for</p>
                  <ul className={styles.ldFlowFeesList}>
                    <li>
                      <span>Income verification <span className={styles.ldFlowFeesHint}>(read-only)</span></span>
                      <strong>Free</strong>
                    </li>
                    <li>
                      <span>Each advance repayment <span className={styles.ldFlowFeesHint}>(on your payday)</span></span>
                      <strong>$25–$30</strong>
                    </li>
                    <li>
                      <span>Monthly membership <span className={styles.ldFlowFeesHint}>(starts on first repayment)</span></span>
                      <strong>$3.99/mo</strong>
                    </li>
                  </ul>
                  <p className={styles.ldFlowFeesFootnote}>
                    Membership and repayments are separate charges. Cancel membership any time. We never charge interest, late fees, or hidden fees.
                  </p>
                </div>

                {fcError && <p className={styles.ldFlowError}>{fcError}</p>}

                <button
                  type="button"
                  className={styles.ldFlowBtn}
                  disabled={fcBusy || !stripeKey}
                  onClick={startStripeFcLink}
                >
                  {fcBusy ? "Opening secure bank link…" : <>Connect bank <span aria-hidden="true">→</span></>}
                </button>

                {!stripeKey && (
                  <p className={styles.ldFlowError} style={{ marginTop: "10px" }}>
                    Bank linking is not configured yet.
                  </p>
                )}

                <div className={styles.ldFlowInfoCard} style={{ marginTop: "20px", marginBottom: 0 }}>
                  <p className={styles.ldFlowInfoCardBody}>
                    <span aria-hidden="true">✅</span> <strong>As long as you receive regular income, you should be approved.</strong>
                  </p>
                </div>

                <p className={styles.ldFlowTrustLine}>
                  <span aria-hidden="true">🔒</span> Bank linking is powered by Stripe. Your credentials are never shared with us.
                </p>

                <div className={styles.ldFlowBackRow}>
                  <button
                    type="button"
                    className={styles.ldFlowBackLink}
                    onClick={() => setWantsToChangePayout(true)}
                  >
                    ← Change payout method
                  </button>
                </div>
              </>
            )}

            {showConnect && (
              <>
                <div className={styles.ldFlowInfoCard}>
                  <p className={styles.ldFlowInfoCardTitle}>
                    <span aria-hidden="true">✓</span> Bank connected
                  </p>
                  <p className={styles.ldFlowInfoCardBody}>
                    We have your bank for income verification, repayment, and ACH payouts. One more step.
                  </p>
                </div>

                <div className={styles.ldFlowFeesCard}>
                  <p className={styles.ldFlowFeesKicker}>Stripe will ask you to confirm</p>
                  <ul className={styles.ldFlowBulletList}>
                    <li>Name, date of birth, last 4 of SSN (we pre-fill)</li>
                    <li>Address</li>
                  </ul>
                  <p className={styles.ldFlowFeesFootnote}>
                    Your bank is already attached — no need to re-enter routing/account numbers.
                  </p>
                </div>

                {stripeConnectError && <p className={styles.ldFlowError}>{stripeConnectError}</p>}

                <button
                  type="button"
                  className={styles.ldFlowBtn}
                  disabled={stripeConnectBusy}
                  onClick={startStripeConnectOnboarding}
                >
                  {stripeConnectBusy ? "Redirecting to Stripe…" : <>Verify identity <span aria-hidden="true">→</span></>}
                </button>
              </>
            )}
          </motion.div>
        </main>
      </div>
    );
  }

  // Step 4c (between bank link and delivery): debit card as a backup
  // repayment rail. Framed as a required-looking step but allows a
  // small Skip link — most users add a card, the few who don't fall
  // through to ACH-only collection. The card-first-then-ACH cascade in
  // the backend (chargeRepaymentWithCascade) tries card first when
  // available; if no card, goes straight to ACH.
  const cardSkippedKey = `advance_card_skipped_${application.id}`;
  const cardSkipped = typeof window !== "undefined" && sessionStorage.getItem(cardSkippedKey) === "1";
  if (preBankActive && hasBankPm && !application.stripe_card_pm_id && !cardSkipped && !needsConnectIdentity) {
    return (
      <main className={styles.page}>
        <NavBar onLogout={handleLogout} />
        <div className={styles.benefitsHeader} style={{ paddingBottom: "5.6rem" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "4rem", maxWidth: "80rem", margin: "0 auto", flexWrap: "wrap" }}>
            <div style={{ flex: "1 1 32rem", textAlign: "left" }}>
              <p className={styles.benefitsHeaderKicker}>Step 5 · Backup card for repayment</p>
              <h1 className={styles.benefitsHeaderTitle} style={{ marginBottom: "1.6rem" }}>
                Add a debit card.
              </h1>
              <p className={styles.benefitsHeaderSub}>
                We'll use this card first to collect your repayment on your payday — typically faster than bank ACH. If the card declines, we'll fall back to your bank automatically.
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
          <p style={{ fontSize: "1.25rem", color: "var(--muted)", marginTop: "1.6rem", textAlign: "center" }}>
            🔒 Card details are encrypted and stored by Stripe — we never see them.
          </p>
          <p style={{ marginTop: "2rem", textAlign: "center", fontSize: "1.15rem" }}>
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                if (typeof window !== "undefined") sessionStorage.setItem(cardSkippedKey, "1");
                // Force a re-render by reloading the application data.
                loadApplication(application.id);
              }}
              style={{ color: "var(--muted)", textDecoration: "underline" }}
            >
              I'll skip this for now
            </a>
          </p>
        </div>
        <StatesFooter />
      </main>
    );
  }

  // Step 5 of 6: delivery speed (same-day vs 3-5 days)
  if (preBankActive && !application.delivery_type) {
    return (
      <div className={styles.ldPage}>
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
            <button type="button" className={styles.ldLinkBtn} onClick={handleLogout}>Sign out</button>
          </div>
        </header>

        <main className={styles.ldFlow}>
          <motion.div className={styles.ldFlowInner} variants={flowPageVariants} initial="hidden" animate="visible">
            <div className={styles.ldFlowProgress} aria-label="Onboarding progress">
              <div className={styles.ldFlowProgressMeta}>
                <span className={styles.ldFlowProgressStep}>Step 3 of 4</span>
                <span className={styles.ldFlowProgressNext}>Delivery speed</span>
              </div>
              <div className={styles.ldFlowProgressTrack} aria-hidden="true">
                <div className={styles.ldFlowProgressFill} style={{ width: `${(3 / 4) * 100}%` }} />
              </div>
            </div>

            <div className={styles.ldFlowHeader}>
              <span className={styles.ldEyebrow}>
                <span className={styles.ldEyebrowDot} aria-hidden="true" />
                Delivery speed
              </span>
              <h1 className={styles.ldFlowH1}>How fast do you need it?</h1>
              <p className={styles.ldFlowLead}>
                Same-day costs an extra <strong>$5</strong>, added to your repayment. 3–5 day delivery is free.
              </p>
            </div>

            <div className={styles.ldFlowDeliveryGrid}>
              <button
                type="button"
                className={styles.ldFlowDeliveryOption}
                data-selected={deliveryChoice === "instant"}
                onClick={() => setDeliveryChoice("instant")}
              >
                <span className={styles.ldFlowDeliveryBadge} data-tone="fee">$5 fee</span>
                <p className={styles.ldFlowDeliveryEmoji} aria-hidden="true">⚡</p>
                <p className={styles.ldFlowDeliveryTitle}>Same day</p>
                <p className={styles.ldFlowDeliverySub}>
                  Money sent the same day, straight to your PayPal, Cash App, or Zelle.
                </p>
              </button>
              <button
                type="button"
                className={styles.ldFlowDeliveryOption}
                data-selected={deliveryChoice === "standard"}
                onClick={() => setDeliveryChoice("standard")}
              >
                <span className={styles.ldFlowDeliveryBadge} data-tone="free">Free</span>
                <p className={styles.ldFlowDeliveryEmoji} aria-hidden="true">📬</p>
                <p className={styles.ldFlowDeliveryTitle}>3–5 days</p>
                <p className={styles.ldFlowDeliverySub}>
                  No extra charge. Funds arrive in 3–5 business days.
                </p>
              </button>
            </div>

            {deliveryChoice && (() => {
              const advance = application.requested_amount;
              const instantFee = deliveryChoice === "instant" ? 5 : 0;
              const repayOnPayday = advance + instantFee;
              const firstMonthTotal = repayOnPayday + 3.99;
              return (
                <div className={styles.ldFlowCostCard}>
                  <p className={styles.ldFlowCostKicker}>Your first month</p>
                  <div className={styles.ldFlowCostList}>
                    <div className={styles.ldFlowCostRow}><span>Advance</span><span>${advance}.00</span></div>
                    {instantFee > 0 && <div className={styles.ldFlowCostRow}><span>Same-day fee</span><span>$5.00</span></div>}
                    <div className={styles.ldFlowCostRow}><span>Membership (monthly)</span><span>$3.99</span></div>
                    <div className={styles.ldFlowCostTotal}>
                      <span>Total first month</span><span>${firstMonthTotal.toFixed(2)}</span>
                    </div>
                  </div>
                </div>
              );
            })()}

            {deliveryError && <p className={styles.ldFlowError}>{deliveryError}</p>}

            <button
              type="button"
              className={styles.ldFlowBtn}
              disabled={deliveryBusy || !deliveryChoice}
              onClick={saveDelivery}
            >
              {deliveryBusy ? "Saving…" : <>Continue <span aria-hidden="true">→</span></>}
            </button>

            <div className={styles.ldFlowBackRow}>
              <button
                type="button"
                className={styles.ldFlowBackLink}
                onClick={() => setWantsToChangePayout(true)}
              >
                ← Change payout method
              </button>
            </div>
          </motion.div>
        </main>
      </div>
    );
  }

  // Step 6 of 6: bank connection (the final gate before review)
  // SKIPPED for FC users — their bank is already linked at Step 4.
  // Legacy Plaid path stays for users mid-flight on the old flow.
  if (preBankActive && !application.stripe_fc_account_id) {
    return (
      <div className={styles.ldPage}>
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
            <button type="button" className={styles.ldLinkBtn} onClick={handleLogout}>Sign out</button>
          </div>
        </header>

        <main className={styles.ldFlow}>
          <motion.div className={styles.ldFlowInner} variants={flowPageVariants} initial="hidden" animate="visible">
            <div className={styles.ldFlowProgress} aria-label="Onboarding progress">
              <div className={styles.ldFlowProgressMeta}>
                <span className={styles.ldFlowProgressStep}>Step 4 of 4</span>
                <span className={styles.ldFlowProgressNext}>Bank verification</span>
              </div>
              <div className={styles.ldFlowProgressTrack} aria-hidden="true">
                <div className={styles.ldFlowProgressFill} style={{ width: "100%" }} />
              </div>
            </div>

            <div className={styles.ldFlowHeader}>
              <span className={styles.ldEyebrow}>
                <span className={styles.ldEyebrowDot} aria-hidden="true" />
                Bank verification
              </span>
              <h1 className={styles.ldFlowH1}>
                Let&apos;s see if you&apos;re <span className={styles.ldFlowH1Accent}>approved.</span>
              </h1>
              <p className={styles.ldFlowLead}>
                Connect your bank so we can verify income and finish your application. We never share your login — Plaid handles it securely.
              </p>
            </div>

            <div className={styles.ldFlowPlaidArea}>
              {plaidCheckingCompletion ? (
                <button type="button" className={styles.ldFlowBtn} disabled>Finishing connection…</button>
              ) : plaidLinkToken && hostedLinkUrl ? (
                <PlaidConnectButton
                  linkToken={plaidLinkToken}
                  hostedLinkUrl={hostedLinkUrl}
                />
              ) : plaidLinkError ? (
                <>
                  <p className={styles.ldFlowError}>{plaidLinkError}</p>
                  <button type="button" className={styles.ldFlowBtn} onClick={fetchPlaidLinkToken}>
                    Retry <span aria-hidden="true">→</span>
                  </button>
                </>
              ) : (
                <button type="button" className={styles.ldFlowBtn} disabled>Loading…</button>
              )}
            </div>

            {error && <p className={styles.ldFlowError} style={{ marginTop: "12px" }}>{error}</p>}

            <p className={styles.ldFlowTrustLine}>
              <span aria-hidden="true">🔒</span> Bank-grade encryption · We never store your password · 256-bit TLS
            </p>

            <div className={styles.ldFlowBackRow}>
              <button
                type="button"
                className={styles.ldFlowBackLink}
                onClick={() => setWantsToChangePayout(true)}
              >
                ← Change payout method
              </button>
            </div>
          </motion.div>
        </main>
      </div>
    );
  }

  // ── Authenticated application view ────────────────────────────────────────
  const needsBank = !application.plaid_connected;
  // needsCard is permanently false — card backup was removed; ACH-only.
  // Kept as a variable for diff clarity; can be inlined later.
  const needsCard = false;

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
              const advance = application.requested_amount;
              const instantFee = deliveryChoice === "instant" ? 5 : 0;
              const membership = 3.99;
              const repayOnPayday = advance + instantFee;
              const firstMonthTotal = repayOnPayday + membership;
              return (
                <div style={{ marginTop: "1.6rem", padding: "1.4rem 1.8rem", background: "var(--surface)", border: "1.5px solid var(--border)", borderRadius: "var(--r-lg)" }}>
                  <p style={{ fontSize: "1.2rem", fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.08em", margin: "0 0 0.8rem" }}>Your first month</p>
                  <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem", fontSize: "1.35rem", color: "var(--ink-2)" }}>
                    <div style={{ display: "flex", justifyContent: "space-between" }}><span>Advance</span><span>${advance}.00</span></div>
                    {instantFee > 0 && (
                      <div style={{ display: "flex", justifyContent: "space-between" }}><span>Same-day fee</span><span>$5.00</span></div>
                    )}
                    <div style={{ display: "flex", justifyContent: "space-between" }}><span>Membership (monthly)</span><span>$3.99</span></div>
                    <div style={{ display: "flex", justifyContent: "space-between", borderTop: "1.5px solid var(--border)", paddingTop: "0.5rem", marginTop: "0.2rem", fontSize: "1.55rem", fontWeight: 800, color: "var(--ink)" }}>
                      <span>Total first month</span><span>${firstMonthTotal.toFixed(2)}</span>
                    </div>
                  </div>
                  <p style={{ fontSize: "1.15rem", color: "var(--muted)", margin: "0.8rem 0 0", lineHeight: 1.5 }}>
                    ${repayOnPayday}.00 due on payday for this advance · $3.99 billed monthly going forward
                  </p>
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

          {/* Card-for-repayment section removed — ACH-only collection.
              Repayment is debited from the FC-linked bank PaymentMethod
              that was set up at Step 4. No backup card on file. */}

          <button
            disabled={!payoutSaved}
            style={{ width: "100%" }}
            onClick={() => { setShowPayoutStep(false); setShowConfirmation(true); }}
          >
            Continue →
          </button>
          {!payoutSaved && (
            <p style={{ textAlign: "center", fontSize: "1.3rem", color: "var(--muted)", marginTop: "0.8rem" }}>
              Save your payout info to continue.
            </p>
          )}
        </div>
      )}

      {showConfirmation && application.referral_code && (
        <div style={{ maxWidth: "56rem", margin: "0 auto", padding: "4rem 2.4rem 8rem" }}>

          {/* Hero */}
          {(() => {
            const advance = application.requested_amount;
            const instantFee = application.delivery_type === "instant" ? 5 : 0;
            const repayOnPayday = advance + instantFee;
            const firstMonthTotal = repayOnPayday + 3.99;
            return (
              <div style={{ textAlign: "center", marginBottom: "3.2rem" }}>
                <div style={{ fontSize: "4.8rem", marginBottom: "1.2rem" }}>🎉</div>
                <h1 style={{ fontSize: "3rem", fontWeight: 800, color: "var(--ink)", marginBottom: "0.8rem" }}>
                  You're all set!
                </h1>
                <p style={{ fontSize: "1.6rem", color: "var(--muted)", lineHeight: 1.6, marginBottom: "1.6rem" }}>
                  Your <strong style={{ color: "var(--ink)" }}>${advance} advance</strong> is{" "}
                  {application.delivery_type === "instant" ? "on its way — same-day delivery." : "on its way — arriving in 3–5 business days."}
                </p>
                <div style={{ display: "inline-block", padding: "1.4rem 2rem", background: "var(--surface)", border: "1.5px solid var(--border)", borderRadius: "var(--r-lg)", textAlign: "left", minWidth: "28rem" }}>
                  <p style={{ fontSize: "1.15rem", fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.08em", margin: "0 0 0.6rem" }}>First month</p>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: "1.3rem", color: "var(--ink-2)" }}>
                    <span>Advance + {instantFee > 0 ? "same-day fee" : "delivery (free)"}</span>
                    <span>${repayOnPayday}.00 on payday</span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: "1.3rem", color: "var(--ink-2)", marginTop: "0.3rem" }}>
                    <span>Membership</span>
                    <span>$3.99 monthly</span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", borderTop: "1.5px solid var(--border)", paddingTop: "0.5rem", marginTop: "0.5rem", fontWeight: 800, fontSize: "1.45rem", color: "var(--ink)" }}>
                    <span>Total first month</span>
                    <span>${firstMonthTotal.toFixed(2)}</span>
                  </div>
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
              <dt>Membership</dt>
              <dd>
                $3.99/mo{" "}
                {application.status === "subscription_failed"
                  ? "· payment failed"
                  : application.subscription_id
                    ? `· active${application.subscription_next_billing ? ` · next: ${application.subscription_next_billing}` : ""}`
                    : application.stripe_card_saved
                      ? "· starts on first repayment"
                      : "· card needed"}
              </dd>
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
  // Admin tabs: filter the inbox by lifecycle bucket so reviewers can
  // focus on what's actually their work right now.
  //   intake   → pre-decision (intake / bank_connected / reviewing)
  //   approved → post-approve, pre-money (approved / expired)
  //   funded   → money out the door (funded / repayment_scheduled /
  //              repaid / repayment_failed / subscription_failed /
  //              written_off)
  type AdminTab = "intake" | "approved" | "funded";
  const [activeTab, setActiveTab] = useState<AdminTab>("intake");
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

  // Status → tab bucket mapping. Anything not in these sets falls into
  // 'intake' as a safe default (e.g. unknown future status values).
  const TAB_STATUSES: Record<AdminTab, Set<string>> = {
    intake: new Set(["intake", "bank_connected", "reviewing"]),
    approved: new Set(["approved", "expired", "denied"]),
    funded: new Set(["funded", "repayment_scheduled", "repaid", "repayment_failed", "subscription_failed", "written_off"]),
  };
  const tabFor = (status: string): AdminTab => {
    if (TAB_STATUSES.approved.has(status)) return "approved";
    if (TAB_STATUSES.funded.has(status)) return "funded";
    return "intake";
  };
  const filteredApplications = applications.filter(a => tabFor(a.status) === activeTab);
  const tabCounts: Record<AdminTab, number> = {
    intake: applications.filter(a => tabFor(a.status) === "intake").length,
    approved: applications.filter(a => tabFor(a.status) === "approved").length,
    funded: applications.filter(a => tabFor(a.status) === "funded").length,
  };

  // Days-until-due helper. Returns null if no due date set.
  // Negative = overdue, 0 = today, positive = days from now.
  const daysUntilDue = (dueDateStr: string | null | undefined): number | null => {
    if (!dueDateStr) return null;
    const due = new Date(dueDateStr);
    if (Number.isNaN(due.getTime())) return null;
    const now = new Date();
    // Compare at YYYY-MM-DD granularity so timezones don't off-by-one us.
    const dueDay = new Date(due.getFullYear(), due.getMonth(), due.getDate()).getTime();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    return Math.round((dueDay - today) / 86400000);
  };

  // Friendly subscription-status badge for the Funded tab.
  type SubBadge = { label: string; color: string; bg: string };
  const subscriptionBadge = (app: Application): SubBadge => {
    // subscription_status reflects what our webhook has seen from
    // Stripe. 'active' = healthy, 'subscription_failed' = locked out,
    // 'cancelled' = user-cancelled, anything else = setup not done.
    if (app.subscription_status === "active" && app.subscription_id) {
      return { label: "✓ Active subscription", color: "#065f46", bg: "#d1fae5" };
    }
    if (app.subscription_status === "subscription_failed") {
      return { label: "✗ Membership failed", color: "#991b1b", bg: "#fee2e2" };
    }
    if (app.subscription_status === "cancelled") {
      return { label: "⊘ Cancelled", color: "#404040", bg: "#e5e5e5" };
    }
    if (app.subscription_id) {
      return { label: "⋯ Sub setup in progress", color: "#92400e", bg: "#fef3c7" };
    }
    return { label: "⚠ No subscription", color: "#92400e", bg: "#fef3c7" };
  };

  // Friendly due-date phrase for the Funded tab.
  const dueDatePhrase = (app: Application): string => {
    if (!app.repayment) return "No repayment scheduled";
    const days = daysUntilDue(app.repayment.due_date);
    if (days === null) return "Due date unknown";
    if (days === 0) return "Due today";
    if (days === 1) return "Due tomorrow";
    if (days > 1) return `Due in ${days} days`;
    if (days === -1) return "Overdue 1 day";
    return `Overdue ${Math.abs(days)} days`;
  };

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
    // Default selection: keep the current one if still around, otherwise
    // pick the first application visible in the currently-active tab.
    setSelectedId((current) => {
      if (current && data.applications.some((a: Application) => a.id === current)) return current;
      const firstInTab = data.applications.find((a: Application) => tabFor(a.status) === activeTab);
      return firstInTab?.id || data.applications[0]?.id || null;
    });
  }, [adminHeaders, activeTab]);

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

  const setupMembership = async () => {
    if (!selected) return;
    setIsBusy(true);
    setError(null);
    try {
      const res = await fetch(apiUrl(`/api/advance/admin/applications/${selected.id}/membership/setup`), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...adminHeaders },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.error_message || "Membership setup failed");
      await loadApplications();
      await loadMessages(selected.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Membership setup failed");
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
            {/* Tab bar — filters the inbox by lifecycle bucket. Each tab
                shows a count so reviewers can see backlog at a glance. */}
            <div style={{ display: "flex", gap: "0.4rem", marginBottom: "1rem", flexWrap: "wrap" }}>
              {(["intake", "approved", "funded"] as AdminTab[]).map(tab => {
                const active = tab === activeTab;
                const labels: Record<AdminTab, string> = { intake: "Intake", approved: "Approved", funded: "Funded" };
                return (
                  <button
                    key={tab}
                    type="button"
                    onClick={() => {
                      setActiveTab(tab);
                      // If the currently selected app isn't in this tab, auto-pick the first one that is.
                      const stillVisible = selected && tabFor(selected.status) === tab;
                      if (!stillVisible) {
                        const first = applications.find(a => tabFor(a.status) === tab);
                        setSelectedId(first?.id || null);
                      }
                    }}
                    style={{
                      flex: 1,
                      padding: "0.6rem 0.8rem",
                      fontSize: "1.25rem",
                      fontWeight: 600,
                      background: active ? "var(--brand)" : "var(--white)",
                      color: active ? "white" : "var(--ink)",
                      border: `1.5px solid ${active ? "var(--brand)" : "var(--border)"}`,
                      borderRadius: "var(--r-sm)",
                      cursor: "pointer",
                    }}
                  >
                    {labels[tab]} ({tabCounts[tab]})
                  </button>
                );
              })}
            </div>
            {filteredApplications.length === 0 && (
              <p style={{ fontSize: "1.3rem", color: "var(--muted)", padding: "1rem 0", textAlign: "center" }}>
                No applications in this bucket.
              </p>
            )}
            {filteredApplications.map((application) => {
              const isFundedTab = activeTab === "funded";
              const badge = isFundedTab ? subscriptionBadge(application) : null;
              const due = isFundedTab ? dueDatePhrase(application) : null;
              return (
                <button
                  key={application.id}
                  className={application.id === selectedId ? styles.activeRow : styles.row}
                  onClick={() => setSelectedId(application.id)}
                >
                  <span>{application.customer.name || "Unnamed applicant"}</span>
                  <small>{statusLabel[application.status]}</small>
                  {isFundedTab && badge && (
                    <small style={{
                      display: "inline-block",
                      marginTop: "0.3rem",
                      padding: "0.15rem 0.6rem",
                      borderRadius: "10px",
                      fontSize: "1.05rem",
                      fontWeight: 600,
                      background: badge.bg,
                      color: badge.color,
                      alignSelf: "flex-start",
                    }}>
                      {badge.label}
                    </small>
                  )}
                  {isFundedTab && due && (
                    <small style={{ color: "var(--muted)", fontSize: "1.15rem", marginTop: "0.15rem" }}>
                      {due}
                    </small>
                  )}
                  <small style={{ color: "var(--muted)", fontSize: "1.2rem", marginTop: "0.2rem" }}>
                    {new Date(application.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                  </small>
                </button>
              );
            })}
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
                      {(selected.plaid_connected || selected.stripe_card_saved || selected.stripe_payment_method_id) ? (
                        <button disabled={isBusy} onClick={chargeCard} style={{ fontSize: "1.3rem", padding: "0.7rem 1.2rem" }}>
                          {isBusy ? "Processing…" : "Collect repayment now"}
                        </button>
                      ) : (
                        <p className={styles.muted} style={{ margin: 0, fontSize: "1.3rem" }}>No payment method on file yet.</p>
                      )}
                      {/* Backfill: create $3.99 membership subscription for users
                          missing one (e.g. funded before subscription code, or
                          previous attempt failed silently). Only shows when the
                          user has a bank PM but no subscription_id. */}
                      {selected.stripe_payment_method_id && !selected.subscription_id && (
                        <button
                          disabled={isBusy}
                          onClick={setupMembership}
                          style={{ fontSize: "1.3rem", padding: "0.7rem 1.2rem", background: "var(--brand-tint)", color: "var(--brand)", border: "1.5px solid var(--brand)" }}
                        >
                          {isBusy ? "Setting up…" : "Set up $3.99 membership"}
                        </button>
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

  const firstName = (application.customer.name || "").trim().split(/\s+/)[0] || "there";
  const initials = (application.customer.name || "?").trim().split(/\s+/).map(p => p[0]).slice(0, 2).join("").toUpperCase() || "?";
  const positiveStatuses = ["approved", "funded", "repaid"];
  const inProgressStatuses = ["reviewing", "repayment_scheduled", "bank_connected"];
  const negativeStatuses = ["denied", "expired", "repayment_failed", "subscription_failed", "written_off"];
  const statusTone = positiveStatuses.includes(application.status)
    ? "positive"
    : negativeStatuses.includes(application.status)
      ? "negative"
      : inProgressStatuses.includes(application.status)
        ? "progress"
        : "neutral";
  const showPayoutSection = application.status === "approved"
    || application.status === "funded"
    || application.status === "repayment_scheduled"
    || application.status === "repaid";
  const showCardSetup = application.status === "approved"
    || application.status === "funded"
    || application.status === "repayment_scheduled";

  return (
    <div className={styles.ldPage}>
      <header className={styles.ldDashNav}>
        <div className={styles.ldDashNavInner}>
          <a className={styles.ldBrand} href="/" onClick={(e) => { e.preventDefault(); window.location.href = "/"; }}>
            <span className={styles.ldBrandMark}>
              <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true">
                <circle cx="11" cy="11" r="10" fill="#fff" />
                <path d="M6 13l3 3 7-8" stroke="#0d5234" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
            advance<span className={styles.ldBrandDot}>.</span>
          </a>
          <div className={styles.ldDashNavRight}>
            <div className={styles.ldDashNavUser}>
              <span className={styles.ldDashAvatar} aria-hidden="true">{initials}</span>
              <span className={styles.ldDashNavUserText}>
                <span className={styles.ldDashNavUserName}>{application.customer.name}</span>
                <span className={styles.ldDashNavUserEmail}>{application.customer.email}</span>
              </span>
            </div>
            <button type="button" className={styles.ldDashSignOut} onClick={logout}>Sign out</button>
          </div>
        </div>
      </header>

      <main className={styles.ldDash}>
        <div className={styles.ldDashInner}>
          {/* Hero — greeting, amount, status */}
          <section className={styles.ldDashHero} data-status={statusTone}>
            <div className={styles.ldDashHeroBgGlow} aria-hidden="true" />
            <div className={styles.ldDashHeroBgGrid} aria-hidden="true" />
            <div className={styles.ldDashHeroContent}>
              <p className={styles.ldDashGreeting}>Hi, {firstName} <span aria-hidden="true">👋</span></p>
              <p className={styles.ldDashHeroLabel}>You&apos;re approved for</p>
              <p className={styles.ldDashAmount}>$25</p>
              <div className={styles.ldDashStatus} data-tone={statusTone}>
                <span className={styles.ldDashStatusDot} aria-hidden="true" />
                {statusLabel[application.status]}
              </div>
            </div>
          </section>

          {/* Detail cards */}
          <div className={styles.ldDashGrid}>
            {/* Loan details */}
            <section className={styles.ldDashCard}>
              <header className={styles.ldDashCardHead}>
                <span className={styles.ldDashCardIcon} aria-hidden="true">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                    <rect x="3" y="6" width="18" height="13" rx="2" stroke="currentColor" strokeWidth="2" />
                    <path d="M3 10h18" stroke="currentColor" strokeWidth="2" />
                  </svg>
                </span>
                <h2 className={styles.ldDashCardTitle}>Loan details</h2>
              </header>
              <dl className={styles.ldDashDl}>
                <div className={styles.ldDashDlRow}>
                  <dt>Employer{(application.income_sources?.length ?? 0) > 1 ? "s" : ""}</dt>
                  <dd>{(application.income_sources?.length > 0 ? application.income_sources.map(s => s.employer) : [application.customer.employer]).join(", ") || "—"}</dd>
                </div>
                <div className={styles.ldDashDlRow}>
                  <dt>Next payday</dt>
                  <dd>{application.income_sources?.[0]?.payday ?? application.payday}</dd>
                </div>
                <div className={styles.ldDashDlRow}>
                  <dt>Bank</dt>
                  <dd>
                    {application.plaid_connected ? (
                      <span className={styles.ldDashChipOk}>
                        <span aria-hidden="true">✓</span> Connected
                      </span>
                    ) : (
                      <span className={styles.ldDashChipNeutral}>Not connected</span>
                    )}
                  </dd>
                </div>
              </dl>
            </section>

            {/* Repayment */}
            <section className={styles.ldDashCard}>
              <header className={styles.ldDashCardHead}>
                <span className={styles.ldDashCardIcon} aria-hidden="true">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                    <path d="M4 7h16M4 12h10M4 17h7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  </svg>
                </span>
                <h2 className={styles.ldDashCardTitle}>Repayment</h2>
              </header>

              {application.status === "repaid" ? (
                <p className={styles.ldDashNoteOk}>
                  <span aria-hidden="true">✓</span> Repayment collected — thank you!
                </p>
              ) : application.plaid_connected ? (
                <>
                  <p className={styles.ldDashNoteOk}>
                    <span aria-hidden="true">✓</span> Bank verified via Plaid.
                  </p>
                  {rep && (
                    <dl className={styles.ldDashDl} style={{ marginTop: "16px" }}>
                      <div className={styles.ldDashDlRow}>
                        <dt>Due date</dt>
                        <dd className={styles.ldDashDueDate}>{rep.due_date}</dd>
                      </div>
                      <div className={styles.ldDashDlRow}>
                        <dt>Status</dt>
                        <dd>
                          {rep.status === "paid" ? (
                            <span className={styles.ldDashChipOk}><span aria-hidden="true">✓</span> Paid</span>
                          ) : (
                            <span className={styles.ldDashChipProgress}>Pending</span>
                          )}
                        </dd>
                      </div>
                    </dl>
                  )}
                  {/* Card setup removed — ACH-only collection.
                      Repayment is debited from the FC-linked bank on the due date. */}
                  {showCardSetup && application.stripe_payment_method_id && (
                    <div style={{ marginTop: "20px" }}>
                      <p className={styles.ldDashNoteOk}>
                        <span aria-hidden="true">✓</span> Bank on file — repayment will be collected automatically via ACH on the due date.
                      </p>
                    </div>
                  )}
                </>
              ) : application.stripe_card_saved ? (
                <>
                  {rep && (
                    <dl className={styles.ldDashDl}>
                      <div className={styles.ldDashDlRow}>
                        <dt>Due date</dt>
                        <dd className={styles.ldDashDueDate}>{rep.due_date}</dd>
                      </div>
                      <div className={styles.ldDashDlRow}>
                        <dt>Status</dt>
                        <dd>
                          {rep.status === "paid" ? (
                            <span className={styles.ldDashChipOk}><span aria-hidden="true">✓</span> Paid</span>
                          ) : (
                            <span className={styles.ldDashChipProgress}>Pending</span>
                          )}
                        </dd>
                      </div>
                    </dl>
                  )}
                  <p className={styles.ldDashNoteOk}>
                    <span aria-hidden="true">✓</span> Bank on file — repayment will be collected automatically via ACH on the due date.
                  </p>
                </>
              ) : (
                <p className={styles.ldDashMuted}>No repayment scheduled yet. A reviewer will reach out once your advance is funded.</p>
              )}
              {error && <p className={styles.ldDashError}>{error}</p>}
            </section>
          </div>

          {/* Payout section — full width below the grid */}
          {showPayoutSection && (
            <section className={styles.ldDashCard}>
              <header className={styles.ldDashCardHead}>
                <span className={styles.ldDashCardIcon} aria-hidden="true">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                    <path d="M3 10h18M3 7a2 2 0 012-2h14a2 2 0 012 2v10a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" stroke="currentColor" strokeWidth="2" />
                  </svg>
                </span>
                <div className={styles.ldDashCardHeadText}>
                  <h2 className={styles.ldDashCardTitle}>How should we send you the money?</h2>
                  <p className={styles.ldDashCardSub}>Select one or more and enter your contact info.</p>
                </div>
              </header>

              <div className={styles.ldDashPayoutMethods}>
                {[
                  { id: "PayPal", label: "PayPal", emoji: "🅿️" },
                  { id: "CashApp", label: "Cash App", emoji: "💚" },
                  { id: "Zelle", label: "Zelle", emoji: "💜" },
                  { id: "Bank transfer", label: "Bank transfer", emoji: "🏦" },
                ].map(method => {
                  const selected = payoutMethods.includes(method.id);
                  return (
                    <button
                      key={method.id}
                      type="button"
                      onClick={() => togglePayoutMethod(method.id)}
                      className={styles.ldDashPayoutMethod}
                      data-selected={selected}
                    >
                      <span className={styles.ldDashPayoutMethodEmoji} aria-hidden="true">{method.emoji}</span>
                      <span>{method.label}</span>
                      {selected && (
                        <span className={styles.ldDashPayoutMethodCheck} aria-hidden="true">✓</span>
                      )}
                    </button>
                  );
                })}
              </div>

              {isBankTransferPayout ? (
                <div className={styles.ldDashPayoutBankNote}>
                  <p>
                    <span aria-hidden="true">✓</span> We&apos;ll send funds directly to your connected bank account — no extra info needed.
                  </p>
                  {!application.plaid_connected && (
                    <p className={styles.ldDashPayoutBankWarn}>
                      You&apos;ll need to connect your bank first from this page.
                    </p>
                  )}
                </div>
              ) : (
                <label className={styles.ldDashField}>
                  <span className={styles.ldDashFieldLabel}>
                    {payoutMethods.length === 1 ? `Your ${payoutMethods[0]} username / email / phone` : "Your username, email, or phone number"}
                  </span>
                  <input
                    className={styles.ldDashInput}
                    value={payoutContact}
                    placeholder="e.g. @username or email@example.com"
                    onChange={e => { setPayoutContact(e.target.value); setPayoutSaved(false); }}
                  />
                </label>
              )}

              {payoutError && <p className={styles.ldDashError}>{payoutError}</p>}
              {payoutSaved && (
                <p className={styles.ldDashNoteOk}>
                  <span aria-hidden="true">✓</span> Payout preference saved!
                </p>
              )}
              <button
                type="button"
                disabled={payoutBusy}
                onClick={submitPayoutPreference}
                className={styles.ldDashSubmit}
              >
                {payoutBusy ? "Saving…" : <>Submit <span aria-hidden="true">→</span></>}
              </button>
            </section>
          )}
        </div>
      </main>
    </div>
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
      if (!saveRes.ok) {
        // Surface the backend's actual error message (e.g. the
        // debit-only rejection) instead of a generic "could not save".
        const saveData = await saveRes.json().catch(() => ({}));
        throw new Error(saveData.error?.error_message || "Could not save card. Please try again.");
      }
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
    <p className={styles.statesFooterTitle}>Available in 36 states</p>
    <p style={{ fontSize: "1.2rem", maxWidth: "60rem", margin: "0 auto", lineHeight: 1.5 }}>
      AL · AK · AZ · CO · DE · FL · GA · HI · ID · IA · KY · ME · MI · MN · MS · MT · NE · NH · NJ · NM · NC · ND · OH · OK · OR · PA · RI · SD · TN · TX · VT · VA · WA · WV · WY
    </p>
    <p style={{ marginTop: "0.8rem", fontSize: "1.25rem" }}>
      <a href="/terms" style={{ color: "var(--muted)", textDecoration: "underline" }}>Terms &amp; Conditions</a>
      {" · "}
      <a href="/privacy" style={{ color: "var(--muted)", textDecoration: "underline" }}>Privacy Policy</a>
      {" · "}
      <a href="/consent" style={{ color: "var(--muted)", textDecoration: "underline" }}>Electronic Consent</a>
      {" · "}
      <a href="mailto:usa@getbits.app" style={{ color: "var(--muted)", textDecoration: "underline" }}>usa@getbits.app</a>
    </p>
  </div>
);


export default App;

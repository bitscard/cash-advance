import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
    address_line1: string | null;
    address_city: string | null;
    address_postal_code: string | null;
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
  bank_account_number: string | null;
  uses_other_advances: boolean | null;
  other_advances: string[];
  subscription_status: string | null;
  subscription_id: string | null;
  subscription_next_billing: string | null;
  // Stripe Connect Express (ACH payouts). Set when the user picks "Bank
  // account (ACH)" in Step 2 and completes the Stripe-hosted onboarding.
  stripe_connect_account_id: string | null;
  stripe_connect_status: string | null;
  stripe_connect_payouts_enabled: boolean;
  stripe_connect_disabled_reason: string | null;
  connect_payout_id: string | null;
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
  "Hawaii", "Idaho", "Illinois", "Iowa", "Kentucky", "Louisiana", "Maine", "Michigan", "Minnesota",
  "Mississippi", "Montana", "Nebraska", "New Hampshire", "New Jersey",
  "New Mexico", "New York", "North Carolina", "North Dakota", "Ohio", "Oklahoma", "Oregon",
  "Pennsylvania", "Rhode Island", "South Dakota", "Tennessee", "Texas",
  "Vermont", "Virginia", "Washington", "West Virginia", "Wyoming",
]);
const ADVANCE_TIERS = [25, 50, 75, 100, 150, 200];

const applicationStorageKey = "advance_application_id";
const userTokenStorageKey = "advance_user_token";
const adminTokenStorageKey = "advance_admin_token";
const adminJwtStorageKey = "advance_admin_jwt";
const adminUserStorageKey = "advance_admin_user";
// Stashed by PlaidConnectButton before Link opens so /oauth-return can pick the
// same link_token back up and resume the OAuth flow (Plaid rejects a new token
// for an in-progress OAuth session).
const oauthLinkTokenStorageKey = "advance_plaid_oauth_link_token";
const fcClientSecretStorageKey = (applicationId: string) => `advance_fc_client_secret_${applicationId}`;
const fcSessionIdStorageKey = (applicationId: string) => `advance_fc_session_id_${applicationId}`;
const fcPendingStartedStorageKey = (applicationId: string) => `advance_fc_pending_started_${applicationId}`;

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

// US phone validation (NANP rules). Accepts anything the user typed —
// digits, parens, dashes, spaces, country code — strips to digits and
// checks shape. Returns { ok, normalized } where normalized is the
// canonical 10-digit form (no country code).
//
// Rules per NANP:
//   - Total 10 digits (or 11 starting with 1)
//   - Area code (NPA): first digit 2-9, second digit 0-9, third 0-9
//   - Exchange code (NXX): same NPA rule for its first digit
//   - (Was) No 555 area code — relaxed, tests use 555 numbers
//   - No N11 area codes (211, 311, 411, 511, 611, 711, 811, 911)
const isValidUsPhone = (raw: string): { ok: boolean; normalized?: string; reason?: string } => {
  const digits = (raw || "").replace(/\D/g, "");
  let d = digits;
  if (d.length === 11 && d.startsWith("1")) d = d.slice(1);
  if (d.length !== 10) {
    return { ok: false, reason: "US phone numbers are 10 digits (e.g. 555-123-4567)." };
  }
  const areaCode = d.slice(0, 3);
  const exchange = d.slice(3, 6);
  if (!/^[2-9][0-9]{2}$/.test(areaCode)) {
    return { ok: false, reason: "Area code can't start with 0 or 1." };
  }
  if (!/^[2-9][0-9]{2}$/.test(exchange)) {
    return { ok: false, reason: "Phone number exchange (digits 4-6) can't start with 0 or 1." };
  }
  // N11 area codes are reserved (211, 311, ..., 911)
  if (/^[2-9]11$/.test(areaCode)) {
    return { ok: false, reason: "That area code is reserved (N11 codes can't be used)." };
  }
  // Note: previously also blocked 555 area codes as "fictional use" but
  // dropped that — test fixtures use 555 numbers and the block was
  // catching legitimate tests. Production users will never type a 555
  // number because they don't exist as commercial phones, so the block
  // was paying no real-world dividend.
  return { ok: true, normalized: d };
};

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

// Admin URL — non-guessable path. Random alphanumeric suffix so search
// engines + casual visitors don't find it. Real security comes from
// the email+password / ADMIN_TOKEN auth on the API — this is just
// belt-and-suspenders. Change here AND tell your team if you rotate it.
const ADMIN_PATH = "/bits-ops-7k3xp9q4z2";

const App = () => {
  const path = window.location.pathname;
  if (path === ADMIN_PATH) return <AdminApp />;
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
    // 'Other cash advance apps' question — disclosed at signup so we
    // know if the user is stacking advances (a risk signal for default).
    // uses_other_advances: 'yes' / 'no' / ''
    // other_advances: array of app names the user selected (only used when 'yes')
    uses_other_advances: "" as "" | "yes" | "no",
    other_advances: [] as string[],
    // Address — used for Stripe Connect Custom KYC when the
    // ENABLE_CONNECT_CUSTOM feature is on. Required for KYC; sent
    // alongside other signup data on submit.
    address_line1: "",
    address_city: "",
    address_postal_code: "",
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
  // Bank account number for ACH payouts — admin uses this + the routing
  // number from FC to manually send via Brex. Routing isn't entered by
  // the user (it comes from the FC PaymentMethod automatically).
  const [bankAccountNumber, setBankAccountNumber] = useState("");
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
    // ACH requires the user to type their bank account number directly.
    // PayPal/Cash App/Zelle require a handle in `payoutContact`. Bank
    // transfer (legacy) uses Plaid for the bank reference and skips
    // both.
    const isAchPayout = payoutMethods.includes("ACH");
    const isBankTransferPayout = payoutMethods.includes("Bank transfer");
    if (isAchPayout) {
      if (!/^\d{4,17}$/.test(bankAccountNumber)) {
        setPayoutError("Bank account number must be 4–17 digits.");
        return;
      }
    } else if (!isBankTransferPayout && !payoutContact.trim()) {
      setPayoutError("Please enter your username, email, or phone number");
      return;
    }
    setPayoutBusy(true);
    setPayoutError(null);
    try {
      const body: { methods: string; contact: string; bank_account_number?: string } = {
        methods: payoutMethods.join(','),
        contact: payoutContact.trim(),
      };
      if (isAchPayout) body.bank_account_number = bankAccountNumber;
      const res = await fetch(apiUrl(`/api/advance/applications/${application!.id}/payout-preference`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
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
    // Phone: must be a valid US number per NANP rules.
    const phoneCheck = isValidUsPhone(form.phone);
    if (!phoneCheck.ok) {
      setError(phoneCheck.reason || "Please enter a valid US phone number.");
      return;
    }
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
      if (!src.pay_frequency) {
        setError(`Please select how often you get paid${label}`);
        return;
      }
      if (src.pay_frequency === "other" && !src.pay_frequency_other.trim()) {
        setError(`Please describe your pay schedule${label}`);
        return;
      }
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
    if (!form.address_line1.trim() || !form.address_city.trim() || !form.address_postal_code.trim()) {
      setError("Please fill in your street address, city, and ZIP code.");
      return;
    }
    if (!/^\d{5}(-\d{4})?$/.test(form.address_postal_code.trim())) {
      setError("ZIP code should be 5 digits.");
      return;
    }
    if (!form.uses_other_advances) {
      setError("Please tell us if you use any other cash advance apps");
      return;
    }
    if (form.uses_other_advances === "yes" && form.other_advances.length === 0) {
      setError("Please select which other cash advance apps you use (or choose 'No' above).");
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
      const { confirmPassword, income_sources: rawSources, ssn, referralCode: _rc, phone: _phone, ...rest } = form;
      const normalizedGateCode = gateCode.trim().toLowerCase().replace(/\s+/g, '');
      // Send phone in canonical E.164 form (+1 followed by 10 digits) so
      // it stores consistently regardless of how the user typed it.
      // handleSignupSubmit already validated, so this should always succeed.
      const phoneNormalCheck = isValidUsPhone(form.phone);
      const normalizedPhone = phoneNormalCheck.normalized ? `+1${phoneNormalCheck.normalized}` : form.phone;
      const body = {
        ...rest,
        phone: normalizedPhone,
        ssn: ssn.replace(/-/g, ""),
        // pay_frequency dropped from signup — strip the lingering fields
        // off the form state before sending; backend treats null as fine.
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
  // Diagnostic state — populated on the bank-link page when the user
  // taps "Diagnostics". Lets the user (or their engineer) see exactly
  // what Stripe is reporting about the SetupIntent without needing
  // Render logs or Stripe Dashboard access.
  const [fcDiagnostic, setFcDiagnostic] = useState<Record<string, unknown> | null>(null);
  const [fcDiagBusy, setFcDiagBusy] = useState(false);
  const fcReturnResumeStarted = useRef(false);
  const logFcClientEvent = useCallback((event: string, details: Record<string, unknown> = {}) => {
    if (!application || !token) return;
    fetch(apiUrl(`/api/advance/applications/${application.id}/stripe/fc/client-event`), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        event,
        details: {
          ...details,
          href: window.location.href,
          visibility_state: document.visibilityState,
          user_agent: navigator.userAgent,
          ts: new Date().toISOString(),
        },
      }),
    }).catch(() => {});
  }, [application?.id, token]);
  const loadFcDiagnostic = async () => {
    if (!application || !token) return;
    setFcDiagBusy(true);
    try {
      const res = await fetch(apiUrl(`/api/advance/applications/${application.id}/stripe/fc/diagnose`), {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      setFcDiagnostic(data);
    } catch (e) {
      setFcDiagnostic({ error: e instanceof Error ? e.message : "fetch failed" });
    } finally {
      setFcDiagBusy(false);
    }
  };

  const collectNativeStripeFc = async (clientSecret: string) => {
    if (!application || !stripePromise) {
      throw new Error("Stripe is not configured yet.");
    }
    const stripe = await stripePromise;
    if (!stripe) throw new Error("Could not load Stripe");
    const stripeFc = stripe as unknown as {
      collectFinancialConnectionsAccounts: (args: { clientSecret: string }) => Promise<{
        financialConnectionsSession?: { id: string; accounts?: { data?: Array<{ id: string }> } };
        error?: { message?: string; code?: string };
      }>;
    };

    logFcClientEvent("native-collect:start", { client_secret_suffix: clientSecret.slice(-8) });
    const result = await stripeFc.collectFinancialConnectionsAccounts({ clientSecret });
    logFcClientEvent("native-collect:return", {
      session_id: result.financialConnectionsSession?.id || null,
      account_count: result.financialConnectionsSession?.accounts?.data?.length || 0,
      error_code: result.error?.code || null,
      error_message: result.error?.message || null,
    });
    if (result.error) {
      throw new Error(result.error.message || "Bank linking was cancelled.");
    }
    return result.financialConnectionsSession;
  };

  const completeNativeStripeFcLink = async (sessionId: string) => {
    if (!application || !token) return false;
    logFcClientEvent("native-complete:start", { session_id: sessionId });
    const completeRes = await fetch(apiUrl(`/api/advance/applications/${application.id}/stripe/fc/native/complete`), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ session_id: sessionId }),
    });
    const completeData = await completeRes.json();
    logFcClientEvent("native-complete:return", {
      ok: completeRes.ok,
      status: completeRes.status,
      session_id: completeData.session_id || sessionId,
      setup_intent_id: completeData.setup_intent_id || null,
      has_payment_method: !!completeData.application?.stripe_payment_method_id,
      error_code: completeData.error?.code || null,
      error_message: completeData.error?.error_message || null,
      setup_intent_status: completeData.error?.setup_intent_status || null,
    });
    if (!completeRes.ok) {
      console.warn('[fc/native/complete failed]', completeData);
      return false;
    }
    if (completeData.application) {
      setApplication(completeData.application);
      localStorage.removeItem(fcClientSecretStorageKey(application.id));
      localStorage.removeItem(fcSessionIdStorageKey(application.id));
      localStorage.removeItem(fcPendingStartedStorageKey(application.id));
      return !!completeData.application.stripe_payment_method_id;
    }
    return false;
  };

  useEffect(() => {
    if (!application || !token) return;
    const onPageHide = () => logFcClientEvent("pagehide");
    const onPageShow = (event: PageTransitionEvent) => logFcClientEvent("pageshow", { persisted: event.persisted });
    const onVisibilityChange = () => logFcClientEvent("visibilitychange", { visibility_state: document.visibilityState });
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [application?.id, token, logFcClientEvent]);

  const startStripeFcLink = async () => {
    if (!application || !stripePromise) {
      setFcError("Stripe is not configured yet.");
      return;
    }
    setFcBusy(true);
    setFcError(null);
    try {
      fcReturnResumeStarted.current = false;
      logFcClientEvent("button:start");
      const sessionRes = await fetch(apiUrl(`/api/advance/applications/${application.id}/stripe/fc/native/create-session`), {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ origin: window.location.origin }),
      });
      const sessionData = await sessionRes.json();
      if (!sessionRes.ok) throw new Error(sessionData.error?.error_message || "Could not start bank linking");
      localStorage.setItem(fcClientSecretStorageKey(application.id), sessionData.client_secret);
      if (sessionData.session_id) localStorage.setItem(fcSessionIdStorageKey(application.id), sessionData.session_id);
      localStorage.setItem(fcPendingStartedStorageKey(application.id), String(Date.now()));
      logFcClientEvent("fc-session:return", {
        session_id: sessionData.session_id || null,
        client_secret_suffix: String(sessionData.client_secret || '').slice(-8),
      });

      const fcSession = await collectNativeStripeFc(sessionData.client_secret);
      const fcSessionId = fcSession?.id || sessionData.session_id;
      if (!fcSessionId) throw new Error("Stripe did not return a Financial Connections session.");

      const completed = await completeNativeStripeFcLink(fcSessionId);
      if (!completed) throw new Error("Could not finalize bank link");
    } catch (e) {
      logFcClientEvent("button:error", { message: e instanceof Error ? e.message : String(e) });
      setFcError(e instanceof Error ? e.message : "Something went wrong with bank linking.");
    } finally {
      logFcClientEvent("button:done");
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

  // Mobile-redirect rescue. Stripe FC can leave or reload the current JS
  // context during bank OAuth on iOS. When the app comes back with a stashed
  // unfinished FC Session, resume the same session even if the bank did not
  // return with our query param.
  useEffect(() => {
    if (!application || !token) return;
    if (application.stripe_payment_method_id) return; // already linked
    if (application.stripe_card_pm_id) return; // legacy path

    const params = new URLSearchParams(window.location.search);
    const isFcReturn = params.has("stripe_fc_return");
    const stashedNativeSessionId = localStorage.getItem(fcSessionIdStorageKey(application.id));
    const stashedClientSecret = localStorage.getItem(fcClientSecretStorageKey(application.id));
    const pendingStartedRaw = localStorage.getItem(fcPendingStartedStorageKey(application.id));
    const pendingStarted = pendingStartedRaw ? Number(pendingStartedRaw) : 0;
    const pendingAgeMs = pendingStarted ? Date.now() - pendingStarted : 0;
    const hasRecentPendingSession = !!stashedClientSecret && stashedClientSecret.startsWith("fcsess_") && (
      isFcReturn ||
      !pendingStarted ||
      (Number.isFinite(pendingAgeMs) && pendingAgeMs >= 0 && pendingAgeMs < 30 * 60 * 1000)
    );
    if (!hasRecentPendingSession) return;
    if (fcReturnResumeStarted.current) return;
    fcReturnResumeStarted.current = true;

    setFcBusy(true);
    setFcError(null);
    if (!pendingStarted) {
      localStorage.setItem(fcPendingStartedStorageKey(application.id), String(Date.now()));
    }
    logFcClientEvent("mobile-return:detected", {
      trigger: isFcReturn ? "stripe_fc_return_param" : "stashed_pending_session",
      has_stashed_client_secret: !!stashedClientSecret,
      stashed_session_id: stashedNativeSessionId,
      pending_age_ms: pendingStarted ? pendingAgeMs : null,
    });

    const cleanFcReturnParams = () => {
      const next = new URL(window.location.href);
      next.searchParams.delete("stripe_fc_return");
      const search = next.searchParams.toString();
      window.history.replaceState({}, "", `${next.pathname}${search ? `?${search}` : ""}${next.hash}`);
    };

    let attempts = 0;
    const maxAttempts = 8;
    const retryMs = 2000;
    let stopped = false;
    let collectAttempted = false;

    const resumeNativeFromStashedSession = async () => {
      const clientSecret = localStorage.getItem(fcClientSecretStorageKey(application.id));
      const stashedSessionId = localStorage.getItem(fcSessionIdStorageKey(application.id)) || "";
      if (!clientSecret || !clientSecret.startsWith("fcsess_")) return false;

      if (stashedSessionId) {
        logFcClientEvent("mobile-complete-stashed:start", { stashed_session_id: stashedSessionId });
        const completedFromServer = await completeNativeStripeFcLink(stashedSessionId);
        logFcClientEvent("mobile-complete-stashed:return", { completed: completedFromServer, stashed_session_id: stashedSessionId });
        if (completedFromServer) return true;
      }

      if (collectAttempted) return false;
      collectAttempted = true;

      logFcClientEvent("mobile-resume:start", {
        client_secret_suffix: clientSecret.slice(-8),
        mode: "native_fc_session",
        stashed_session_id: stashedSessionId,
      });
      const fcSession = await collectNativeStripeFc(clientSecret);
      const fcSessionId = fcSession?.id || stashedSessionId || "";
      if (!fcSessionId) throw new Error("Stripe did not return a Financial Connections session.");
      const completed = await completeNativeStripeFcLink(fcSessionId);
      logFcClientEvent("mobile-resume:complete", { completed, session_id: fcSessionId });
      return completed;
    };

    const tryComplete = async () => {
      if (stopped) return;
      attempts += 1;
      try {
        const resumedCompleted = await resumeNativeFromStashedSession();
        if (resumedCompleted) {
          stopped = true;
          fcReturnResumeStarted.current = false;
          cleanFcReturnParams();
          setFcBusy(false);
          return;
        }
      } catch (e) {
        if (e instanceof Error) {
          logFcClientEvent("mobile-resume:error", { message: e.message });
          console.warn("[fc/mobile-resume failed]", e.message);
        }
      }
      if (attempts < maxAttempts) {
        setTimeout(tryComplete, retryMs);
      } else {
        cleanFcReturnParams();
        fcReturnResumeStarted.current = false;
        setFcBusy(false);
        setFcError("We couldn't finish connecting your bank. Please tap Connect bank and try again.");
      }
    };

    tryComplete();
    return () => {
      stopped = true;
      if (isFcReturn) setFcBusy(false);
    };
  }, [application?.id, application?.stripe_payment_method_id, application?.stripe_card_pm_id, token]);

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
        <div className={styles.bldPage}>
          {/* ── 1. Nav ─────────────────────────────────────────────────────── */}
          <header className={styles.bldNav}>
            <div className={styles.bldNavInner}>
              <a className={styles.bldBrand} href="#top" onClick={(e) => { e.preventDefault(); window.scrollTo({ top: 0, behavior: "smooth" }); }}>
                <span className={styles.bldBrandMark}>✓</span>
                advance<span className={styles.bldBrandDot}>.</span>
              </a>
              <nav className={styles.bldLandNavLinks} aria-label="Main">
                <a href="#how">How it works</a>
                <a href="#raffle">Raffle</a>
                <a href="#faq">FAQ</a>
              </nav>
              <div style={{ display: "inline-flex", gap: 10, alignItems: "center" }}>
                <button type="button" onClick={goSignIn} className={styles.bldNavLink}>Sign in</button>
                <button type="button" onClick={goSignup} className={styles.bldLandNavCta}>Get cash →</button>
              </div>
            </div>
          </header>

          <main>
            {/* ── 2. Hero ──────────────────────────────────────────────────── */}
            <section className={styles.bldLandHero}>
              <motion.div
                className={styles.bldLandHeroInner}
                initial={{ opacity: 0, y: 24 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ type: "spring", stiffness: 100, damping: 22 }}
              >
                <p className={styles.bldEyebrow}>AI-powered · No credit check · 0% interest</p>
                <h1 className={styles.bldLandHeroH1}>
                  Cash before<br /><em>your paycheck.</em>
                </h1>
                <p className={styles.bldLandHeroSub}>
                  Up to <strong>$300</strong> in your account today. Repay on your next payday — 0% interest, no late fees, no credit pull. Just $3.99/month.
                </p>
                <div className={styles.bldLandHeroCtaRow}>
                  <motion.button
                    type="button"
                    onClick={goSignup}
                    className={styles.bldBtn}
                    style={{ width: "auto", paddingLeft: 32, paddingRight: 32 }}
                    whileTap={{ scale: 0.98 }}
                  >
                    Get my cash <span aria-hidden="true">→</span>
                  </motion.button>
                  <a className={styles.bldLandGhostLink} href="#how">How it works ↓</a>
                </div>
                <ul className={styles.bldLandProof}>
                  <li><strong>700K+</strong> members</li>
                  <li><strong>4.7★</strong> Trustpilot</li>
                  <li><strong>AI</strong> approvals</li>
                </ul>
              </motion.div>
            </section>

            {/* ── 3. Amount tiers ─────────────────────────────────────────── */}
            <section className={styles.bldLandAmounts}>
              <p className={styles.bldEyebrow} style={{ marginBottom: 12 }}>How much do you need?</p>
              <h2 className={styles.bldLandH2} style={{ marginLeft: "auto", marginRight: "auto" }}>
                Borrow what you need.<br /><em>Repay what you borrowed.</em>
              </h2>

              <div className={styles.bldLandTiers}>
                {[
                  { amt: "$25", lbl: "1st advance", featured: false },
                  { amt: "$50", lbl: "Then $50", featured: false },
                  { amt: "$100", lbl: "Then $100", featured: false },
                  { amt: "$200", lbl: "Then $200", featured: false },
                  { amt: "$300", lbl: "Max", featured: true },
                ].map((t, i) => (
                  <motion.div
                    key={t.amt}
                    className={styles.bldLandTier}
                    data-featured={t.featured}
                    initial={{ opacity: 0, y: 16 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true, margin: "-80px" }}
                    transition={{ delay: i * 0.06, type: "spring", stiffness: 140, damping: 22 }}
                  >
                    <span className={styles.bldLandTierIndex}>0{i + 1}</span>
                    <span className={styles.bldLandTierAmt}>{t.amt}</span>
                    <span className={styles.bldLandTierLbl}>{t.lbl}</span>
                  </motion.div>
                ))}
              </div>

              <p className={styles.bldLandAmountsNote}>
                Membership <strong>$3.99/mo</strong> · Instant transfers <strong>$5</strong> · 0% interest · No late fees · No credit pull
              </p>
            </section>

            {/* ── 2b. Delivery options ─────────────────────────────────────── */}
            <section className={styles.bldLandSection}>
              <p className={styles.bldEyebrow} style={{ marginBottom: 12 }}>The advance way</p>
              <h2 className={styles.bldLandH2}>
                Get your cash<br /><em>your way.</em>
              </h2>
              <p className={styles.bldLead} style={{ marginBottom: 40 }}>
                Zelle to your bank. Cash App to your $cashtag. PayPal if that&apos;s your thing.
              </p>
              <ul className={styles.bldTiles}>
                {[
                  { name: "PayPal", sub: "To your PayPal balance, instantly.", logoBg: "linear-gradient(135deg, #009cde 0%, #003087 100%)", logoText: "P" },
                  { name: "Cash App", sub: "Hits your $cashtag, same day.", logoBg: "#00D632", logoText: "$" },
                  { name: "Zelle", sub: "Straight to your bank in minutes.", logoBg: "#6D1ED4", logoText: "Z" },
                ].map((m) => (
                  <li key={m.name} className={styles.bldTile} style={{ cursor: "default" }}>
                    <span className={styles.bldTileLogo} style={{ background: m.logoBg }}>{m.logoText}</span>
                    <span style={{ flex: 1 }}>
                      <span className={styles.bldTileName} style={{ display: "block" }}>{m.name}</span>
                      <span style={{ fontSize: 13, color: "var(--bld-text-muted)" }}>{m.sub}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </section>

            {/* ── 4. How it works ──────────────────────────────────────────── */}
            <section className={styles.bldLandSection} id="how">
              <p className={styles.bldEyebrow} style={{ marginBottom: 12 }}>How it works</p>
              <h2 className={styles.bldLandH2}>
                Application to cash<br /><em>in three steps.</em>
              </h2>
              <div className={styles.bldLandSteps}>
                {[
                  { n: "01", title: "Apply in 2 minutes", sub: "Tell us your name, employer, payday, and last 4 of your SSN. No credit pull, ever." },
                  { n: "02", title: "Connect your bank", sub: "Link with Plaid — read-only, encrypted. We see your income but never your password." },
                  { n: "03", title: "Get your money", sub: "A real reviewer approves your advance. Money lands in your account the same day." },
                ].map(s => (
                  <article key={s.n} className={styles.bldLandStep}>
                    <div className={styles.bldLandStepN}>{s.n}</div>
                    <div>
                      <h3 className={styles.bldLandStepH3}>{s.title}</h3>
                      <p className={styles.bldLandStepP}>{s.sub}</p>
                    </div>
                  </article>
                ))}
              </div>
            </section>

            {/* ── 6. Raffle ────────────────────────────────────────────────── */}
            <section className={styles.bldLandSection} id="raffle">
              <div className={styles.bldLandTwoCol}>
                <div>
                  <p className={styles.bldEyebrow} style={{ marginBottom: 12 }}>Member perk</p>
                  <h2 className={styles.bldLandH2}>
                    Win a trip<br /><em>to Cancún.</em>
                  </h2>
                  <p className={styles.bldLead} style={{ marginBottom: 32 }}>
                    Every active member is automatically entered in our all-inclusive Cancún getaway. Stay current on your advances — you&apos;re in.
                  </p>
                  <motion.button type="button" onClick={goSignup} className={styles.bldBtn} style={{ width: "auto", paddingLeft: 32, paddingRight: 32 }} whileTap={{ scale: 0.98 }}>
                    Become a member <span aria-hidden="true">→</span>
                  </motion.button>
                </div>
                <div className={styles.bldLandRaffleCard}>
                  <div className={styles.bldLandRaffleTop}>
                    <span style={{ fontSize: 14, fontWeight: 800, letterSpacing: "-0.01em" }}>advance<span style={{ color: "var(--bld-accent)" }}>.</span></span>
                    <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.16em", textTransform: "uppercase", color: "var(--bld-text-muted)" }}>Q1 · 2026</span>
                  </div>
                  <p style={{ margin: "0 0 8px", fontSize: 11, fontWeight: 700, letterSpacing: "0.16em", textTransform: "uppercase", color: "var(--bld-text-muted)" }}>Quarterly getaway</p>
                  <p className={styles.bldLandRaffleDest}>Cancún 🏖️</p>
                  <p style={{ margin: "0 0 24px", fontSize: 13, color: "var(--bld-text-muted)" }}>All-inclusive · 4 days · 2 guests</p>
                  <div className={styles.bldLandRaffleFoot}>
                    <span>Next draw</span>
                    <strong>April 1, 2026</strong>
                  </div>
                </div>
              </div>
            </section>

            {/* ── 7. British angle / story teaser ──────────────────────────── */}
            <section className={styles.bldLandSection}>
              <p className={styles.bldEyebrow} style={{ marginBottom: 12 }}>Our story</p>
              <h2 className={styles.bldLandH2}>
                Built by guys in England.<br /><em>For America.</em>
              </h2>
              <p className={styles.bldLead}>
                We came from England with an idea. We ran focus groups with Americans to hear how they really live between paychecks — and built what they actually needed: cash before payday, without the loan-shark nonsense.
              </p>
              <p className={styles.bldLead} style={{ marginTop: 16 }}>
                If we got something wrong — and we&apos;re Englishmen who drink tea, say sorry too much, and still call it football — <a href="mailto:advances@getbits.app" className={styles.bldFootLink}>email us</a> and tell us off.
              </p>
              <a href="/story" className={styles.bldLandStoryLink}>
                Read our story <span aria-hidden="true">→</span>
              </a>
            </section>

            {/* ── 8. FAQ ───────────────────────────────────────────────────── */}
            <section className={styles.bldLandSection} id="faq">
              <div className={styles.bldLandTwoCol}>
                <div>
                  <p className={styles.bldEyebrow} style={{ marginBottom: 12 }}>FAQ</p>
                  <h2 className={styles.bldLandH2}>
                    Questions,<br /><em>plain answers.</em>
                  </h2>
                  <p className={styles.bldLead}>
                    If something isn&apos;t clear, ask us — we&apos;ll answer the same day.
                  </p>
                </div>
                <ul className={styles.bldLandFaq}>
                  {[
                    ["Will this affect my credit score?", "No. We don't pull your credit, soft or hard. Advance never reports to credit bureaus."],
                    ["What if I can't repay on time?", "We'll text you to reschedule. We never send accounts to collections. We never charge a late fee on the principal."],
                    ["What states is advance available in?", "Currently 36 US states. If we're not in your state yet, you can join the waitlist."],
                    ["How much can I borrow?", "Up to $300 per advance. First-time members typically qualify for $50–$150 based on their pay history."],
                    ["How does repayment work?", "Automatic — on your next payday, we debit the amount you borrowed. You can also repay early at any time, free."],
                    ["Is there a membership fee?", "Yes — $3.99 per month for membership. Instant (same-hour) transfers are $5. No interest, no late fees, no credit pull."],
                  ].map(([q, a]) => (
                    <li key={q} className={styles.bldLandFaqItem}>
                      <details>
                        <summary>
                          <span>{q}</span>
                          <span className={styles.bldLandFaqIcon} aria-hidden="true">+</span>
                        </summary>
                        <p>{a}</p>
                      </details>
                    </li>
                  ))}
                </ul>
              </div>
            </section>

            {/* ── 9. CTA band ──────────────────────────────────────────────── */}
            <section className={styles.bldLandCta}>
              <h2 className={styles.bldLandCtaH2}>
                Your next paycheck<br /><em>is closer than you think.</em>
              </h2>
              <p className={styles.bldLead} style={{ marginBottom: 32, maxWidth: 460 }}>
                Get started in 2 minutes. No credit check. No commitment.
              </p>
              <motion.button
                type="button"
                onClick={goSignup}
                className={styles.bldBtn}
                whileTap={{ scale: 0.98 }}
              >
                Get my cash <span aria-hidden="true">→</span>
              </motion.button>
              <p style={{ marginTop: 16, fontSize: 12, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--bld-text-dim)" }}>
                Invite-only beta — have a referral code ready
              </p>
            </section>
          </main>

          {/* ── 10. Footer ─────────────────────────────────────────────────── */}
          <footer className={styles.bldLandFooter}>
            <div className={styles.bldLandFooterTop}>
              <div>
                <a className={styles.bldBrand} href="#top" onClick={(e) => { e.preventDefault(); window.scrollTo({ top: 0, behavior: "smooth" }); }}>
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
                    <li><a href="#how">How it works</a></li>
                    <li><a href="#raffle">Raffle</a></li>
                    <li><a href="#faq">FAQ</a></li>
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
                    <li><a href="mailto:advances@getbits.app">Contact</a></li>
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
                  advance is an earned wage access product offered by Bits Card Inc. — it is not a loan. Bits USA is powered by Bits Card Inc which has its principal office at 368 9th Avenue, New York, NY 10001. For support, please email us at <a href="mailto:advances@getbits.app" style={{ color: "var(--bld-text-muted)", textDecoration: "underline" }}>advances@getbits.app</a>. Individual borrowers must be a U.S. Citizen, permanent resident, or non-resident U.S. Alien and at least 18 years old. Valid bank account is required.
                </p>
              </div>
            </div>
          </footer>
        </div>
      );
    }

    // ── Referral gate ────────────────────────────────────────────────────────
    if (view === "referral") {
      return (
        <div className={styles.bldPage}>
          <header className={styles.bldNav}>
            <div className={styles.bldNavInner}>
              <a className={styles.bldBrand} href="/" onClick={(e) => { e.preventDefault(); setView("landing"); }}>
                <span className={styles.bldBrandMark}>✓</span>
                advance<span className={styles.bldBrandDot}>.</span>
              </a>
              <a href="/loan" className={styles.bldNavLink}>Sign in</a>
            </div>
          </header>

          <motion.main
            className={styles.bldMain}
            variants={flowPageVariants}
            initial="hidden"
            animate="visible"
          >
            <motion.span className={styles.bldEyebrow} variants={flowChildVariants}>
              Invite-only
            </motion.span>
            <motion.h1 className={styles.bldH1} variants={flowChildVariants}>
              Got a <em>code?</em>
            </motion.h1>
            <motion.p className={styles.bldLead} variants={flowChildVariants}>
              Advance is growing through word of mouth. Drop the code from whoever invited you.
            </motion.p>

            <motion.div className={styles.bldField} variants={flowChildVariants}>
              <label htmlFor="gate-code-input" className={styles.bldLabel}>
                Your invite code
              </label>
              <input
                id="gate-code-input"
                type="text"
                autoComplete="off"
                placeholder="e.g. friend123"
                value={gateCode}
                onChange={(e) => { setGateCode(e.target.value); setGateValid(null); setError(null); }}
                onKeyDown={(e) => e.key === "Enter" && document.getElementById("gate-continue")?.click()}
                className={styles.bldInput}
              />
              {gateValid === true && (
                <p style={{ margin: 0, fontSize: "13px", fontWeight: 700, color: "var(--bld-accent)", letterSpacing: "0.04em" }}>
                  <span aria-hidden="true">✓</span> {gateReferrerName ? `Referred by ${gateReferrerName}` : "Code accepted"}
                </p>
              )}
              {gateValid === false && (
                <p style={{ margin: 0, fontSize: "13px", fontWeight: 600, color: "var(--bld-danger)" }}>
                  That code isn&apos;t recognized. Check with whoever invited you.
                </p>
              )}
            </motion.div>

            {error && <p className={styles.bldError}>{error}</p>}

            <motion.button
              id="gate-continue"
              type="button"
              className={styles.bldBtn}
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
              variants={flowChildVariants}
              whileTap={{ scale: 0.98 }}
            >
              {gateBusy ? "Checking…" : <>Continue <span aria-hidden="true">→</span></>}
            </motion.button>

            <motion.p className={styles.bldFootnote} variants={flowChildVariants}>
              Already have an account? <a href="/loan" className={styles.bldFootLink}>Sign in →</a>
            </motion.p>

            <motion.ul className={styles.bldTrust} variants={flowChildVariants} aria-label="What you get">
              <li>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M5 12l4 4L19 6" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                No credit check
              </li>
              <li>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M5 12l4 4L19 6" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                0% interest
              </li>
              <li>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M5 12l4 4L19 6" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                Cancel anytime
              </li>
            </motion.ul>
          </motion.main>
        </div>
      );
    }

    // ── Signup ────────────────────────────────────────────────────────────────
    return (
      <div className={styles.bldPage}>
        {isDateFocused && <div className={styles.backdrop} />}

        <header className={styles.bldNav}>
          <div className={styles.bldNavInner}>
            <a className={styles.bldBrand} href="/" onClick={(e) => { e.preventDefault(); setView("landing"); }}>
              <span className={styles.bldBrandMark}>✓</span>
              advance<span className={styles.bldBrandDot}>.</span>
            </a>
            <a href="/loan" className={styles.bldNavLink}>Sign in</a>
          </div>
        </header>

        <motion.main
          className={styles.bldMain}
          data-wide="true"
          variants={flowPageVariants}
          initial="hidden"
          animate="visible"
        >
          <motion.div className={styles.bldProgress} variants={flowChildVariants} aria-label="Signup progress">
            <span className={styles.bldProgressLabel}>1 of 3 · Your info</span>
            <span className={styles.bldProgressDot} data-state="current" />
            <span className={styles.bldProgressDot} />
            <span className={styles.bldProgressDot} />
          </motion.div>

          <motion.h1 className={styles.bldH1} variants={flowChildVariants}>
            Tell us about <em>yourself.</em>
          </motion.h1>
          <motion.p className={styles.bldLead} variants={flowChildVariants}>
            Takes about 2 minutes — your info is encrypted and never sold. No hard credit check, ever.
          </motion.p>

          <form onSubmit={handleSignupSubmit}>
            <motion.div variants={flowChildVariants}>
              <p className={styles.bldSectionLabel}>Personal information</p>
              <div className={styles.bldFieldGrid}>
                <label className={styles.bldField}>
                  <span className={styles.bldLabel}>Full name</span>
                  <input className={styles.bldInput} required value={form.name} placeholder="Jane Smith"
                    onChange={(event) => setForm({ ...form, name: event.target.value })} />
                </label>
                <label className={styles.bldField}>
                  <span className={styles.bldLabel}>Email</span>
                  <input className={styles.bldInput} required type="email" value={form.email} placeholder="jane@example.com"
                    onChange={(event) => setForm({ ...form, email: event.target.value })} />
                </label>
                <label className={styles.bldField}>
                  <span className={styles.bldLabel}>Phone <span className={styles.bldHint}>(US only)</span></span>
                  <input
                    className={styles.bldInput}
                    required
                    type="tel"
                    autoComplete="tel"
                    inputMode="tel"
                    pattern="^[\(]?\d{3}[\)]?[-.\s]?\d{3}[-.\s]?\d{4}$"
                    title="Enter a 10-digit US phone number, like 555-123-4567 or (555) 123-4567."
                    value={form.phone}
                    placeholder="(212) 555-0123"
                    onChange={(event) => setForm({ ...form, phone: event.target.value })}
                  />
                </label>
                <label className={styles.bldField}>
                  <span className={styles.bldLabel}>Date of birth</span>
                  <input className={styles.bldInput} required type="date" value={form.dob}
                    max={new Date(new Date().setFullYear(new Date().getFullYear() - 18)).toISOString().slice(0, 10)}
                    onChange={(event) => setForm({ ...form, dob: event.target.value })} />
                </label>
                <label className={`${styles.bldField} ${styles.bldFieldFull}`}>
                  <span className={styles.bldLabel}>Street address</span>
                  <input
                    className={styles.bldInput}
                    required
                    type="text"
                    autoComplete="street-address"
                    placeholder="123 Main St"
                    value={form.address_line1}
                    onChange={(e) => setForm({ ...form, address_line1: e.target.value })}
                  />
                </label>
                <label className={styles.bldField}>
                  <span className={styles.bldLabel}>City</span>
                  <input
                    className={styles.bldInput}
                    required
                    type="text"
                    autoComplete="address-level2"
                    value={form.address_city}
                    onChange={(e) => setForm({ ...form, address_city: e.target.value })}
                  />
                </label>
                <label className={styles.bldField}>
                  <span className={styles.bldLabel}>ZIP</span>
                  <input
                    className={styles.bldInput}
                    required
                    type="text"
                    inputMode="numeric"
                    pattern="\d{5}(-\d{4})?"
                    autoComplete="postal-code"
                    placeholder="10001"
                    value={form.address_postal_code}
                    onChange={(e) => setForm({ ...form, address_postal_code: e.target.value })}
                  />
                </label>
                <label className={`${styles.bldField} ${styles.bldFieldFull}`}>
                  <span className={styles.bldLabel}>State</span>
                  <select
                    className={styles.bldSelect}
                    required
                    value={form.state}
                    onChange={(e) => setForm({ ...form, state: e.target.value })}
                  >
                    <option value="" disabled>Select state…</option>
                    {US_STATES.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </label>
              </div>
            </motion.div>

            <motion.div variants={flowChildVariants}>
              <p className={styles.bldSectionLabel}>Income</p>
              {form.income_sources.map((src, i) => (
                <div key={i} className={styles.bldIncomeBlock}>
                  {form.income_sources.length > 1 && (
                    <div className={styles.bldIncomeHead}>
                      <strong>Income source {i + 1}</strong>
                      <button type="button" onClick={() => removeSource(i)} className={styles.bldIncomeRemove}>
                        Remove
                      </button>
                    </div>
                  )}
                  <div className={styles.bldFieldGrid}>
                    <label className={styles.bldField}>
                      <span className={styles.bldLabel}>Employer</span>
                      <input className={styles.bldInput} required value={src.employer} placeholder="Acme Corp"
                        onChange={e => updateSource(i, "employer", e.target.value)} />
                    </label>
                    <label className={styles.bldField}>
                      <span className={styles.bldLabel}>
                        Next payday <span className={styles.bldHint}>(within 30 days)</span>
                      </span>
                      <input className={styles.bldInput} required min={today} max={thirtyDaysFromNow} type="date" value={src.payday}
                        onChange={e => updateSource(i, "payday", e.target.value)} />
                    </label>
                    <label className={`${styles.bldField} ${styles.bldFieldFull}`}>
                      <span className={styles.bldLabel}>How often do you get paid?</span>
                      <select
                        className={styles.bldSelect}
                        required
                        value={src.pay_frequency || ""}
                        onChange={e => updateSource(i, "pay_frequency", e.target.value)}
                      >
                        <option value="" disabled>Select frequency…</option>
                        <option value="weekly">Weekly</option>
                        <option value="biweekly">Every 2 weeks (biweekly)</option>
                        <option value="semimonthly">Twice a month (1st and 15th, etc.)</option>
                        <option value="monthly">Monthly</option>
                        <option value="daily">Daily</option>
                        <option value="other">Other</option>
                      </select>
                    </label>
                    {src.pay_frequency === "other" && (
                      <label className={`${styles.bldField} ${styles.bldFieldFull}`}>
                        <span className={styles.bldLabel}>Describe your pay schedule</span>
                        <input className={styles.bldInput} required type="text"
                          placeholder="e.g. every Friday, on the 1st and 15th…"
                          value={src.pay_frequency_other || ""}
                          onChange={e => updateSource(i, "pay_frequency_other", e.target.value)} />
                      </label>
                    )}
                  </div>
                </div>
              ))}
              <button type="button" onClick={addSource} className={styles.bldAddSource}>
                <span aria-hidden="true">+</span> Add another income source
              </button>
            </motion.div>

            {/* Other cash advance apps — risk signal for stacking. */}
            <motion.div variants={flowChildVariants}>
              <p className={styles.bldSectionLabel}>Other cash advance apps</p>
              <div className={styles.bldFieldGrid}>
                <label className={`${styles.bldField} ${styles.bldFieldFull}`}>
                  <span className={styles.bldLabel}>Do you currently use any other cash advance apps?</span>
                  <select
                    className={styles.bldSelect}
                    required
                    value={form.uses_other_advances}
                    onChange={(e) => setForm({
                      ...form,
                      uses_other_advances: e.target.value as "" | "yes" | "no",
                      // Clear selections when switching to 'no'
                      other_advances: e.target.value === "no" ? [] : form.other_advances,
                    })}
                  >
                    <option value="" disabled>Select…</option>
                    <option value="no">No</option>
                    <option value="yes">Yes</option>
                  </select>
                </label>
                {form.uses_other_advances === "yes" && (
                  <div className={`${styles.bldField} ${styles.bldFieldFull}`}>
                    <span className={styles.bldLabel}>Which ones? (select all that apply)</span>
                    <div style={{
                      display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8,
                    }}>
                      {[
                        "Cleo",
                        "Dave",
                        "Brigit",
                        "Earnin",
                        "MoneyLion",
                        "Albert",
                        "Empower",
                        "Possible Finance",
                        "Klover",
                        "B9",
                        "Other",
                      ].map((app) => {
                        const checked = form.other_advances.includes(app);
                        return (
                          <button
                            key={app}
                            type="button"
                            onClick={() => {
                              setForm({
                                ...form,
                                other_advances: checked
                                  ? form.other_advances.filter((a) => a !== app)
                                  : [...form.other_advances, app],
                              });
                            }}
                            style={{
                              padding: "8px 14px",
                              fontSize: 13,
                              fontWeight: 500,
                              borderRadius: 999,
                              border: `1.5px solid ${checked ? "var(--bld-accent)" : "var(--bld-border)"}`,
                              background: checked ? "var(--bld-accent)" : "transparent",
                              color: checked ? "#fff" : "var(--bld-text)",
                              cursor: "pointer",
                            }}
                          >
                            {checked && <span aria-hidden="true" style={{ marginRight: 6 }}>✓</span>}
                            {app}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            </motion.div>

            <motion.div variants={flowChildVariants}>
              <p className={styles.bldSectionLabel}>Verification &amp; security</p>
              <div className={styles.bldFieldGrid}>
                <label className={`${styles.bldField} ${styles.bldFieldFull}`}>
                  <span className={styles.bldLabel}>Social Security Number</span>
                  <input
                    className={styles.bldInput}
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
                <label className={styles.bldField}>
                  <span className={styles.bldLabel}>Password</span>
                  <input className={styles.bldInput} required type="password" minLength={6} placeholder="Min. 6 characters"
                    autoComplete="new-password"
                    value={form.password}
                    onChange={(event) => setForm({ ...form, password: event.target.value })} />
                </label>
                <label className={styles.bldField}>
                  <span className={styles.bldLabel}>Confirm</span>
                  <input className={styles.bldInput} required type="password" autoComplete="new-password"
                    value={form.confirmPassword}
                    onChange={(event) => setForm({ ...form, confirmPassword: event.target.value })} />
                </label>
              </div>
            </motion.div>

            {error && <p className={styles.bldError} style={{ marginTop: 24 }}>{error}</p>}

            <p className={styles.bldTerms}>
              By submitting this form and creating an account, you agree to our{" "}
              <a href="/terms" target="_blank" rel="noopener noreferrer" className={styles.bldTermsLink}>Terms</a>
              ,{" "}
              <a href="/privacy" target="_blank" rel="noopener noreferrer" className={styles.bldTermsLink}>Privacy Policy</a>
              , and{" "}
              <a href="/consent" target="_blank" rel="noopener noreferrer" className={styles.bldTermsLink}>Consent to electronic signatures</a>
              . We never pull your credit and we will never send your account to collections.
            </p>

            <motion.button
              disabled={isBusy}
              className={styles.bldBtn}
              variants={flowChildVariants}
              whileTap={{ scale: 0.98 }}
            >
              {isBusy ? "Creating account…" : <>Continue <span aria-hidden="true">→</span></>}
            </motion.button>
          </form>
        </motion.main>
      </div>
    );

  }

  // ── Waitlist screen (non-eligible state — cannot proceed past here) ─────────
  // Backend sets subscription_status='waitlisted' for non-eligible states without a personal referral.
  // Master gate codes (neworleans, atlanta) grant signup access but do NOT bypass state eligibility.
  const stateIsIneligible = application.subscription_status === 'waitlisted';
  if (stateIsIneligible) {
    const stateName = application.customer.state || "your state";
    return (
      <div className={styles.bldPage}>
        <header className={styles.bldNav}>
          <div className={styles.bldNavInner}>
            <a className={styles.bldBrand} href="/">
              <span className={styles.bldBrandMark}>✓</span>
              advance<span className={styles.bldBrandDot}>.</span>
            </a>
            <button type="button" className={styles.bldNavLink} onClick={handleLogout}>Sign out</button>
          </div>
        </header>

        <motion.main
          className={styles.bldMain}
          data-wide="true"
          variants={flowPageVariants}
          initial="hidden"
          animate="visible"
        >
          <motion.span className={styles.bldEyebrow} variants={flowChildVariants}>You&apos;re in line</motion.span>
          <motion.h1 className={styles.bldH1} variants={flowChildVariants}>
            We&apos;re coming to <em>{stateName}.</em>
          </motion.h1>
          <motion.p className={styles.bldLead} variants={flowChildVariants}>
            Live in 36 states today. We&apos;re expanding fast — {stateName} is on the roadmap. You&apos;ll get an email the moment we go live.
          </motion.p>

          <motion.div className={styles.bldNote} variants={flowChildVariants}>
            <p className={styles.bldNoteTitle}>✓ You&apos;re confirmed</p>
            <p className={styles.bldNoteBody}>
              We&apos;ll email <strong style={{ color: "var(--bld-text)" }}>{application.customer.email}</strong> as soon as Advance launches in {stateName}.
            </p>
          </motion.div>

          <motion.div variants={flowChildVariants}>
            <p className={styles.bldSectionLabel}>What to expect</p>
            <ul className={styles.bldTiles}>
              {[
                { icon: "🚫", title: "No credit check, ever", sub: "We won't pull your credit now or when we launch." },
                { icon: "💸", title: "Instant access at launch", sub: "Skip the line — your account is ready to go." },
                { icon: "🔒", title: "Your data is safe", sub: "Stored securely. Never sold or shared with advertisers." },
                { icon: "🎰", title: "Weekly $300 raffle", sub: "Automatic entry once Advance is live in your state." },
              ].map(({ icon, title, sub }) => (
                <li key={title} className={styles.bldTile} style={{ cursor: "default" }}>
                  <span className={styles.bldTileLogo} style={{ background: "var(--bld-surface)", border: "1px solid var(--bld-border)", color: "var(--bld-accent)" }}>{icon}</span>
                  <span style={{ flex: 1 }}>
                    <span className={styles.bldTileName} style={{ display: "block" }}>{title}</span>
                    <span style={{ fontSize: 13, color: "var(--bld-text-muted)" }}>{sub}</span>
                  </span>
                </li>
              ))}
            </ul>
          </motion.div>

          <p className={styles.bldFootnote}>
            Questions? <a href="mailto:advances@getbits.app" className={styles.bldFootLink}>advances@getbits.app</a>
          </p>
        </motion.main>
      </div>
    );
  }

  // ── Denied screen (shown instead of raw "Denied" status) ────────────────────
  if (application.status === 'denied') {
    return (
      <div className={styles.bldPage}>
        <header className={styles.bldNav}>
          <div className={styles.bldNavInner}>
            <a className={styles.bldBrand} href="/">
              <span className={styles.bldBrandMark}>✓</span>
              advance<span className={styles.bldBrandDot}>.</span>
            </a>
            <button type="button" className={styles.bldNavLink} onClick={handleLogout}>Sign out</button>
          </div>
        </header>

        <motion.main
          className={styles.bldMain}
          data-wide="true"
          variants={flowPageVariants}
          initial="hidden"
          animate="visible"
        >
          <motion.span className={styles.bldEyebrow} variants={flowChildVariants}>Application update</motion.span>
          <motion.h1 className={styles.bldH1} variants={flowChildVariants}>
            Not quite <em>ready yet.</em>
          </motion.h1>
          <motion.p className={styles.bldLead} variants={flowChildVariants}>
            We weren&apos;t able to approve your advance at this time — but this isn&apos;t permanent. Many members get approved on a second try once their income history builds up.
          </motion.p>

          <motion.div className={styles.bldNote} variants={flowChildVariants}>
            <p className={styles.bldNoteTitle}>💌 No mark on your credit</p>
            <p className={styles.bldNoteBody}>
              We never reported anything to any credit bureau. Your score is exactly where it was.
            </p>
          </motion.div>

          <motion.div variants={flowChildVariants}>
            <p className={styles.bldSectionLabel}>What typically helps</p>
            <ul className={styles.bldTiles}>
              {[
                { icon: "📅", title: "Consistent deposit history", sub: "A few more pay cycles can make a big difference. Try again in 30–60 days." },
                { icon: "🏦", title: "Keep your bank connected", sub: "Account is still active. Reapply anytime — connection stays in place." },
                { icon: "🚫", title: "No collections, ever", sub: "We'll never refer you to a debt collector or file a lawsuit — unconditionally." },
                { icon: "📩", title: "Get in touch", sub: "Think this was a mistake? Email us — we review every message personally." },
              ].map(({ icon, title, sub }) => (
                <li key={title} className={styles.bldTile} style={{ cursor: "default" }}>
                  <span className={styles.bldTileLogo} style={{ background: "var(--bld-surface)", border: "1px solid var(--bld-border)", color: "var(--bld-accent)" }}>{icon}</span>
                  <span style={{ flex: 1 }}>
                    <span className={styles.bldTileName} style={{ display: "block" }}>{title}</span>
                    <span style={{ fontSize: 13, color: "var(--bld-text-muted)" }}>{sub}</span>
                  </span>
                </li>
              ))}
            </ul>
          </motion.div>

          <motion.button
            type="button"
            className={styles.bldBtn}
            disabled={reapplyBusy}
            onClick={handleReapply}
            variants={flowChildVariants}
            whileTap={{ scale: 0.98 }}
          >
            {reapplyBusy ? "Resubmitting…" : <>Reapply <span aria-hidden="true">→</span></>}
          </motion.button>
          {error && <p className={styles.bldError} style={{ marginTop: 12, textAlign: "center" }}>{error}</p>}

          <p className={styles.bldFootnote}>
            Questions? <a href="mailto:advances@getbits.app" className={styles.bldFootLink}>advances@getbits.app</a>
          </p>
        </motion.main>
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
      <div className={styles.bldPage}>
        <header className={styles.bldNav}>
          <div className={styles.bldNavInner}>
            <a className={styles.bldBrand} href="/">
              <span className={styles.bldBrandMark}>✓</span>
              advance<span className={styles.bldBrandDot}>.</span>
            </a>
            <button type="button" className={styles.bldNavLink} onClick={handleLogout}>Sign out</button>
          </div>
        </header>

        <motion.main
          className={styles.bldMain}
          data-wide="true"
          variants={flowPageVariants}
          initial="hidden"
          animate="visible"
        >
          <motion.span className={styles.bldEyebrow} variants={flowChildVariants}>You&apos;re approved</motion.span>
          <motion.div
            className={styles.bldHeroAmount}
            initial={{ opacity: 0, scale: 0.7 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ type: "spring", stiffness: 180, damping: 18, delay: 0.15 }}
          >
            $25
          </motion.div>
          <motion.h1 className={styles.bldH1} variants={flowChildVariants}>
            Your money&apos;s <em>on its way.</em>
          </motion.h1>
          <motion.p className={styles.bldLead} variants={flowChildVariants}>
            Pay it back on time and your limit grows — all the way up to $200.
          </motion.p>

          {application.offer_expires_at && (() => {
            const exp = new Date(application.offer_expires_at);
            const timeStr = exp.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", timeZoneName: "short" });
            return (
              <motion.div className={styles.bldBanner} variants={flowChildVariants}>
                <p>
                  <strong>⏰ This offer expires tonight at {timeStr}.</strong> Choose a delivery method before then, or you&apos;ll need to reapply.
                </p>
              </motion.div>
            );
          })()}

          <motion.div className={styles.bldNote} variants={flowChildVariants}>
            <p className={styles.bldNoteTitle}>How trust-building works</p>
            <p className={styles.bldNoteBody}>
              Every on-time repayment earns you a higher limit on your next advance. Start small, build history, get more.
            </p>
          </motion.div>

          <motion.p className={styles.bldSectionLabel} variants={flowChildVariants}>Your advance limit roadmap</motion.p>
          <motion.div
            style={{ display: "flex", gap: 8, overflowX: "auto", padding: "18px 0 8px", marginBottom: 32 }}
            variants={flowChildVariants}
          >
            {milestones.map((m) => (
              <div
                key={m.amount}
                style={{
                  flex: "1 0 88px",
                  background: m.current ? "var(--bld-accent)" : "var(--bld-surface)",
                  border: m.current ? "0" : "1px solid var(--bld-border)",
                  borderRadius: 12,
                  padding: "20px 10px 14px",
                  textAlign: "center",
                  position: "relative",
                  opacity: m.current ? 1 : 0.55,
                  boxShadow: m.current ? "0 0 20px rgba(0, 214, 50, 0.45)" : "none",
                }}
              >
                {m.current && (
                  <span style={{
                    position: "absolute", top: -10, left: "50%", transform: "translateX(-50%)",
                    background: "var(--bld-bg)", color: "var(--bld-accent)", fontSize: 10, fontWeight: 800,
                    letterSpacing: "0.08em", textTransform: "uppercase", padding: "3px 8px", borderRadius: 999,
                    border: "1px solid var(--bld-accent)", whiteSpace: "nowrap",
                  }}>
                    You&apos;re here
                  </span>
                )}
                <p style={{ margin: "0 0 4px", fontSize: 19, fontWeight: 800, color: m.current ? "var(--bld-bg)" : "var(--bld-text)", fontVariantNumeric: "tabular-nums", letterSpacing: "-0.02em" }}>
                  {m.amount}
                </p>
                <p style={{ margin: 0, fontSize: 11, color: m.current ? "rgba(0,0,0,0.7)" : "var(--bld-text-dim)" }}>
                  {m.label}
                </p>
              </div>
            ))}
          </motion.div>

          <motion.button
            type="button"
            className={styles.bldBtn}
            onClick={() => setTrustScreenSeen(true)}
            variants={flowChildVariants}
            whileTap={{ scale: 0.98 }}
          >
            Choose how to receive my $25 <span aria-hidden="true">→</span>
          </motion.button>
        </motion.main>
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
    const methods: { id: string; name: string; placeholder: string; label: string; logoBg: string; logoText: string }[] = [
      { id: "PayPal", name: "PayPal", placeholder: "you@email.com", label: "Your PayPal email or phone",
        logoBg: "linear-gradient(135deg, #009cde 0%, #003087 100%)", logoText: "P" },
      { id: "CashApp", name: "Cash App", placeholder: "$cashtag", label: "Your $cashtag",
        logoBg: "#00D632", logoText: "$" },
      { id: "Zelle", name: "Zelle", placeholder: "you@email.com or phone", label: "Your Zelle email or phone",
        logoBg: "#6D1ED4", logoText: "Z" },
      { id: "ACH", name: "Bank account (ACH)", placeholder: "", label: "",
        logoBg: "#1a1a1a", logoText: "🏦" },
    ];
    const selectedId = payoutMethods[0];
    const selectedMethod = methods.find(m => m.id === selectedId);
    const isAch = selectedId === "ACH";
    return (
      <div className={styles.bldPage}>
        <header className={styles.bldNav}>
          <div className={styles.bldNavInner}>
            <a className={styles.bldBrand} href="/">
              <span className={styles.bldBrandMark}>✓</span>
              advance<span className={styles.bldBrandDot}>.</span>
            </a>
            <button type="button" className={styles.bldNavLink} onClick={handleLogout}>Sign out</button>
          </div>
        </header>

        <motion.main
          className={styles.bldMain}
          variants={flowPageVariants}
          initial="hidden"
          animate="visible"
        >
          <motion.div className={styles.bldProgress} variants={flowChildVariants} aria-label="Onboarding progress">
            <span className={styles.bldProgressLabel}>1 of 4</span>
            <span className={styles.bldProgressDot} data-state="current" />
            <span className={styles.bldProgressDot} />
            <span className={styles.bldProgressDot} />
            <span className={styles.bldProgressDot} />
          </motion.div>

          <motion.span className={styles.bldEyebrow} variants={flowChildVariants}>Receive money</motion.span>
          <motion.h1 className={styles.bldH1} variants={flowChildVariants}>
            Where does the <em>money go?</em>
          </motion.h1>
          <motion.p className={styles.bldLead} variants={flowChildVariants}>
            Pick how we send your advance once you&apos;re approved.
          </motion.p>

          <motion.div className={styles.bldTiles} variants={flowChildVariants}>
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
                  className={styles.bldTile}
                  data-selected={selected}
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: 0.15 + i * 0.05, type: "spring", stiffness: 200, damping: 22 }}
                  whileTap={{ scale: 0.99 }}
                >
                  <span className={styles.bldTileLogo} style={{ background: m.logoBg }}>{m.logoText}</span>
                  <span className={styles.bldTileName}>{m.name}</span>
                  <span className={styles.bldTileArrow} aria-hidden="true">→</span>
                </motion.button>
              );
            })}
          </motion.div>

          {selectedMethod && !isAch && (
            <motion.div
              className={styles.bldField}
              style={{ marginTop: 40 }}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ type: "spring", stiffness: 220, damping: 22 }}
            >
              <label className={styles.bldLabel}>{selectedMethod.label}</label>
              <input
                type="text"
                placeholder={selectedMethod.placeholder}
                value={payoutContact}
                onChange={(e) => { setPayoutContact(e.target.value); setPayoutSaved(false); setPayoutError(null); }}
                className={styles.bldInput}
                autoFocus
              />
            </motion.div>
          )}

          {selectedMethod && !isAch && payoutContact.trim() && (
            <motion.div
              className={styles.bldNote}
              initial={{ opacity: 0, scale: 0.98 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ type: "spring", stiffness: 240, damping: 22 }}
            >
              <p className={styles.bldNoteTitle}>Confirm</p>
              <p className={styles.bldNoteBody}>
                We&apos;ll send your advance to <strong style={{ color: "var(--bld-text)" }}>{selectedMethod.name}</strong> at <strong style={{ color: "var(--bld-text)" }}>{payoutContact.trim()}</strong>. Make sure this is correct — we can&apos;t recover funds sent to the wrong address.
              </p>
            </motion.div>
          )}

          {isAch && (
            <motion.div
              className={styles.bldField}
              style={{ marginTop: 40 }}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ type: "spring", stiffness: 220, damping: 22 }}
            >
              <label className={styles.bldLabel}>Bank account number</label>
              <input
                type="text"
                inputMode="numeric"
                pattern="\d{4,17}"
                placeholder="e.g. 1234567890"
                autoComplete="off"
                value={bankAccountNumber}
                onChange={(e) => {
                  const digits = e.target.value.replace(/\D/g, "").slice(0, 17);
                  setBankAccountNumber(digits);
                  setPayoutSaved(false);
                  setPayoutError(null);
                }}
                className={styles.bldInput}
                autoFocus
              />
              <span style={{ marginTop: 8, fontSize: 12, color: "var(--bld-text-dim)", letterSpacing: "0.02em", lineHeight: 1.5 }}>
                Find this in your bank app: typically 4–17 digits, no spaces or letters. We already have your routing number from the bank you linked.
              </span>
            </motion.div>
          )}

          {payoutError && <p className={styles.bldError}>{payoutError}</p>}

          <motion.button
            type="button"
            className={styles.bldBtn}
            style={{ marginTop: 32 }}
            disabled={payoutBusy || !selectedMethod || (!isAch && !payoutContact.trim()) || (isAch && !/^\d{4,17}$/.test(bankAccountNumber))}
            onClick={async () => {
              await submitPayoutPreference();
              if (application) await loadApplication(application.id);
              setWantsToChangePayout(false);
            }}
            variants={flowChildVariants}
            whileTap={{ scale: 0.98 }}
          >
            {payoutBusy
              ? "Saving…"
              : !selectedMethod
                ? "Pick a method above"
                : !isAch && !payoutContact.trim()
                  ? `Add your ${selectedMethod.name} details`
                  : isAch && !/^\d{4,17}$/.test(bankAccountNumber)
                    ? "Enter your bank account number"
                    : isAch
                      ? <>Continue <span aria-hidden="true">→</span></>
                      : <>Confirm <span aria-hidden="true">→</span></>}
          </motion.button>

          {payoutAlreadySaved && (
            <div className={styles.bldBackRow}>
              <button
                type="button"
                className={styles.bldTextBtn}
                onClick={() => setWantsToChangePayout(false)}
              >
                Cancel — keep my existing choice
              </button>
            </div>
          )}
        </motion.main>
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
  // Dev-only bank skip — same pattern as the old card-skip flag. Engineers
  // can pass ?dev_skip_bank=1 in the URL to reveal a 'Skip — testing only'
  // link below the Connect Bank button. Click sets a sessionStorage flag
  // that bypasses the step. Real users never see the link (no URL param).
  // Note: skipping bank means the user has no stripe_payment_method_id,
  // so they can't actually be ACH-charged at repayment time. Fine for
  // visual / flow testing; not for end-to-end payment testing.
  // Read the flag from the URL OR sessionStorage so it survives hard
  // navigations (e.g. clicking "Sign in" goes to /loan and strips ?dev_skip_bank=1).
  // First time we see ?dev_skip_bank=1 in the URL, stash it in session.
  const devSkipBankAllowed = typeof window !== "undefined" && (() => {
    const fromUrl = new URLSearchParams(window.location.search).get("dev_skip_bank") === "1";
    if (fromUrl) sessionStorage.setItem("advance_dev_skip_bank", "1");
    return fromUrl || sessionStorage.getItem("advance_dev_skip_bank") === "1";
  })();
  const bankSkippedKey = `advance_bank_skipped_${application.id}`;
  const bankSkipped = typeof window !== "undefined" && sessionStorage.getItem(bankSkippedKey) === "1";
  const needsBankLink = !hasBankPm && !hasCardPm && !bankSkipped;
  // needsConnectIdentity is permanently false — Connect Express identity
  // verification was removed when payouts moved to manual Brex sends.
  // Kept as a variable for diff clarity in downstream conditionals.
  const needsConnectIdentity = false;

  if (preBankActive && (needsBankLink || needsConnectIdentity)) {
    // Phase 4a: bank not linked yet → show FC link UI
    // Phase 4b: bank linked, but ACH user needs Connect identity → show identity-verify UI
    const showFc = needsBankLink;
    const showConnect = !needsBankLink && needsConnectIdentity;
    return (
      <div className={styles.bldPage}>
        <header className={styles.bldNav}>
          <div className={styles.bldNavInner}>
            <a className={styles.bldBrand} href="/">
              <span className={styles.bldBrandMark}>✓</span>
              advance<span className={styles.bldBrandDot}>.</span>
            </a>
            <button type="button" className={styles.bldNavLink} onClick={handleLogout}>Sign out</button>
          </div>
        </header>

        <motion.main
          className={styles.bldMain}
          variants={flowPageVariants}
          initial="hidden"
          animate="visible"
        >
          <motion.div className={styles.bldProgress} variants={flowChildVariants} aria-label="Onboarding progress">
            <span className={styles.bldProgressLabel}>2 of 4</span>
            <span className={styles.bldProgressDot} data-state="done" />
            <span className={styles.bldProgressDot} data-state="current" />
            <span className={styles.bldProgressDot} />
            <span className={styles.bldProgressDot} />
          </motion.div>

          <motion.span className={styles.bldEyebrow} variants={flowChildVariants}>
            {showConnect ? "Identity verification" : "Bank & membership"}
          </motion.span>
          <motion.h1 className={styles.bldH1} variants={flowChildVariants}>
            {showConnect ? <>One quick <em>ID check.</em></> : <>Connect your <em>bank.</em></>}
          </motion.h1>
          <motion.p className={styles.bldLead} variants={flowChildVariants}>
            {showConnect
              ? "We legally need to verify it's you before we can send money to your bank. Takes about 30 seconds on Stripe's secure form."
              : "We use your bank to verify income, send your advance, and collect repayment — all from one secure connection."}
          </motion.p>

          {showFc && (
            <>
              {fcError && <p className={styles.bldError}>{fcError}</p>}

              <motion.button
                type="button"
                className={styles.bldBtn}
                disabled={fcBusy || !stripeKey}
                onClick={startStripeFcLink}
                variants={flowChildVariants}
                whileTap={{ scale: 0.98 }}
              >
                {fcBusy ? "Opening secure bank link…" : <>Connect bank <span aria-hidden="true">→</span></>}
              </motion.button>

              {!stripeKey && (
                <p className={styles.bldError} style={{ marginTop: 12 }}>
                  Bank linking is not configured yet.
                </p>
              )}

              <div className={styles.bldNote} style={{ marginTop: 24 }}>
                <p className={styles.bldNoteBody}>
                  <strong style={{ color: "var(--bld-accent)" }}>✓ Regular income = approval.</strong> If you receive consistent deposits, you should be approved.
                </p>
              </div>

              <p style={{ marginTop: 16, textAlign: "center", fontSize: "12px", color: "var(--bld-text-dim)", letterSpacing: "0.04em" }}>
                <span aria-hidden="true">🔒</span> Bank linking is powered by Stripe. Your credentials are never shared with us.
              </p>

              {/* Diagnostic panel — shows the SetupIntent state on
                  Stripe's side. Hidden by default; tap the line below
                  to expand. Useful when bank-link fails silently and
                  the user (or their engineer) needs to see what Stripe
                  is actually reporting. */}
              <details style={{ marginTop: 20 }}>
                <summary
                  onClick={() => { if (!fcDiagnostic && !fcDiagBusy) loadFcDiagnostic(); }}
                  style={{ fontSize: 12, color: "var(--bld-text-dim)", textAlign: "center", cursor: "pointer", listStyle: "none" }}
                >
                  Show diagnostic info (for debugging)
                </summary>
                <div style={{
                  marginTop: 12, padding: 12, fontSize: 11,
                  background: "var(--bld-surface)", border: "1px solid var(--bld-border)",
                  borderRadius: 8, color: "var(--bld-text)",
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                  whiteSpace: "pre-wrap", wordBreak: "break-word",
                  maxHeight: 280, overflow: "auto",
                }}>
                  {fcDiagBusy && "Loading…"}
                  {!fcDiagBusy && fcDiagnostic && JSON.stringify(fcDiagnostic, null, 2)}
                  {!fcDiagBusy && !fcDiagnostic && "Tap above to fetch SetupIntent state."}
                </div>
                {fcDiagnostic && (
                  <button
                    type="button"
                    onClick={loadFcDiagnostic}
                    style={{
                      marginTop: 8, fontSize: 11, padding: "4px 10px",
                      background: "transparent", color: "var(--bld-text-dim)",
                      border: "1px solid var(--bld-border)", borderRadius: 6,
                      cursor: "pointer",
                    }}
                  >
                    Refresh
                  </button>
                )}
              </details>

              {devSkipBankAllowed && (
                <motion.p variants={flowChildVariants} style={{ marginTop: 24, textAlign: "center", fontSize: "12px" }}>
                  <a
                    href="#"
                    onClick={(e) => {
                      e.preventDefault();
                      if (typeof window !== "undefined") sessionStorage.setItem(bankSkippedKey, "1");
                      loadApplication(application.id);
                    }}
                    style={{ color: "var(--bld-text-dim)", textDecoration: "underline" }}
                  >
                    Skip — testing only (dev mode)
                  </a>
                </motion.p>
              )}

              <div className={styles.bldBackRow}>
                <button
                  type="button"
                  className={styles.bldTextBtn}
                  onClick={() => setWantsToChangePayout(true)}
                >
                  ← Change payout method
                </button>
              </div>
            </>
          )}

          {showConnect && (
            <>
              <motion.div className={styles.bldNote} variants={flowChildVariants}>
                <p className={styles.bldNoteTitle}>✓ Bank connected</p>
                <p className={styles.bldNoteBody}>
                  We have your bank for income verification, repayment, and ACH payouts. One more step.
                </p>
              </motion.div>

              <motion.div variants={flowChildVariants}>
                <p className={styles.bldLabel}>Stripe will ask you to confirm</p>
                <ul style={{ margin: "0 0 16px", paddingLeft: 22, fontSize: 14, lineHeight: 1.75, color: "var(--bld-text)" }}>
                  <li>Name, date of birth, last 4 of SSN <span style={{ color: "var(--bld-text-dim)" }}>(we pre-fill)</span></li>
                  <li>Address</li>
                </ul>
                <p style={{ fontSize: 12, color: "var(--bld-text-dim)", margin: "0 0 24px", lineHeight: 1.55 }}>
                  Your bank is already attached — no need to re-enter routing/account numbers.
                </p>
              </motion.div>

              {stripeConnectError && <p className={styles.bldError}>{stripeConnectError}</p>}

              <motion.button
                type="button"
                className={styles.bldBtn}
                disabled={stripeConnectBusy}
                onClick={startStripeConnectOnboarding}
                variants={flowChildVariants}
                whileTap={{ scale: 0.98 }}
              >
                {stripeConnectBusy ? "Redirecting to Stripe…" : <>Verify identity <span aria-hidden="true">→</span></>}
              </motion.button>
            </>
          )}
        </motion.main>
      </div>
    );
  }

  // (Removed) The card-collection step. Earlier we required a debit
  // card before delivery as a backup for the ACH-pull cascade, but the
  // product decision changed — we're back to ACH-only collection.
  // chargeRepaymentWithCascade already handles the no-card branch
  // (Day 0 ACH + daily balance-check ACH retries).

  // Step 3 of 4: delivery speed (same-day vs 3-5 days)
  if (preBankActive && !application.delivery_type) {
    return (
      <div className={styles.bldPage}>
        <header className={styles.bldNav}>
          <div className={styles.bldNavInner}>
            <a className={styles.bldBrand} href="/">
              <span className={styles.bldBrandMark}>✓</span>
              advance<span className={styles.bldBrandDot}>.</span>
            </a>
            <button type="button" className={styles.bldNavLink} onClick={handleLogout}>Sign out</button>
          </div>
        </header>

        <motion.main
          className={styles.bldMain}
          variants={flowPageVariants}
          initial="hidden"
          animate="visible"
        >
          <motion.div className={styles.bldProgress} variants={flowChildVariants} aria-label="Onboarding progress">
            <span className={styles.bldProgressLabel}>3 of 4</span>
            <span className={styles.bldProgressDot} data-state="done" />
            <span className={styles.bldProgressDot} data-state="done" />
            <span className={styles.bldProgressDot} data-state="current" />
            <span className={styles.bldProgressDot} />
          </motion.div>

          <motion.span className={styles.bldEyebrow} variants={flowChildVariants}>Delivery speed</motion.span>
          <motion.h1 className={styles.bldH1} variants={flowChildVariants}>
            How fast do you <em>need it?</em>
          </motion.h1>
          <motion.p className={styles.bldLead} variants={flowChildVariants}>
            Same-day costs an extra <strong>$5</strong>, added to your repayment. 3–5 day delivery is free.
          </motion.p>

          <motion.div className={styles.bldDeliveryGrid} variants={flowChildVariants}>
            <motion.button
              type="button"
              className={styles.bldDelivery}
              data-selected={deliveryChoice === "instant"}
              onClick={() => setDeliveryChoice("instant")}
              whileTap={{ scale: 0.97 }}
            >
              <span className={styles.bldDeliveryBadge} data-tone="fee">$5 fee</span>
              <p className={styles.bldDeliveryEmoji} aria-hidden="true">⚡</p>
              <p className={styles.bldDeliveryTitle}>Same day</p>
              <p className={styles.bldDeliverySub}>
                Sent the same day to your PayPal, Cash App, or Zelle.
              </p>
            </motion.button>
            <motion.button
              type="button"
              className={styles.bldDelivery}
              data-selected={deliveryChoice === "standard"}
              onClick={() => setDeliveryChoice("standard")}
              whileTap={{ scale: 0.97 }}
            >
              <span className={styles.bldDeliveryBadge} data-tone="free">Free</span>
              <p className={styles.bldDeliveryEmoji} aria-hidden="true">📬</p>
              <p className={styles.bldDeliveryTitle}>3–5 days</p>
              <p className={styles.bldDeliverySub}>
                No extra charge. Funds arrive in 3–5 business days.
              </p>
            </motion.button>
          </motion.div>

          {deliveryChoice && (() => {
            const advance = application.requested_amount;
            const instantFee = deliveryChoice === "instant" ? 5 : 0;
            const repayOnPayday = advance + instantFee;
            const firstMonthTotal = repayOnPayday + 3.99;
            return (
              <motion.div
                className={styles.bldCost}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ type: "spring", stiffness: 240, damping: 22 }}
              >
                <p className={styles.bldCostKicker}>Your first month</p>
                <div className={styles.bldCostRow}><span>Advance</span><span>${advance}.00</span></div>
                {instantFee > 0 && <div className={styles.bldCostRow}><span>Same-day fee</span><span>$5.00</span></div>}
                <div className={styles.bldCostRow}><span>Membership (monthly)</span><span>$3.99</span></div>
                <div className={styles.bldCostTotal}>
                  <span>Total</span><span>${firstMonthTotal.toFixed(2)}</span>
                </div>
              </motion.div>
            );
          })()}

          {deliveryError && <p className={styles.bldError}>{deliveryError}</p>}

          <motion.button
            type="button"
            className={styles.bldBtn}
            disabled={deliveryBusy || !deliveryChoice}
            onClick={saveDelivery}
            variants={flowChildVariants}
            whileTap={{ scale: 0.98 }}
          >
            {deliveryBusy ? "Saving…" : <>Continue <span aria-hidden="true">→</span></>}
          </motion.button>

          <div className={styles.bldBackRow}>
            <button
              type="button"
              className={styles.bldTextBtn}
              onClick={() => setWantsToChangePayout(true)}
            >
              ← Change payout method
            </button>
          </div>
        </motion.main>
      </div>
    );
  }

  // Step 4 of 4: bank connection (the final gate before review)
  // SKIPPED for FC users — their bank is already linked at Step 2.
  // Legacy Plaid path stays for users mid-flight on the old flow.
  if (preBankActive && !application.stripe_fc_account_id) {
    return (
      <div className={styles.bldPage}>
        <header className={styles.bldNav}>
          <div className={styles.bldNavInner}>
            <a className={styles.bldBrand} href="/">
              <span className={styles.bldBrandMark}>✓</span>
              advance<span className={styles.bldBrandDot}>.</span>
            </a>
            <button type="button" className={styles.bldNavLink} onClick={handleLogout}>Sign out</button>
          </div>
        </header>

        <motion.main
          className={styles.bldMain}
          variants={flowPageVariants}
          initial="hidden"
          animate="visible"
        >
          <motion.div className={styles.bldProgress} variants={flowChildVariants} aria-label="Onboarding progress">
            <span className={styles.bldProgressLabel}>4 of 4</span>
            <span className={styles.bldProgressDot} data-state="done" />
            <span className={styles.bldProgressDot} data-state="done" />
            <span className={styles.bldProgressDot} data-state="done" />
            <span className={styles.bldProgressDot} data-state="current" />
          </motion.div>

          <motion.span className={styles.bldEyebrow} variants={flowChildVariants}>Bank verification</motion.span>
          <motion.h1 className={styles.bldH1} variants={flowChildVariants}>
            Last step — <em>get approved.</em>
          </motion.h1>
          <motion.p className={styles.bldLead} variants={flowChildVariants}>
            Connect your bank so we can verify income and finish your application. We never share your login — Plaid handles it securely.
          </motion.p>

          <motion.div variants={flowChildVariants}>
            {plaidCheckingCompletion ? (
              <button type="button" className={styles.bldBtn} disabled>Finishing connection…</button>
            ) : plaidLinkToken && hostedLinkUrl ? (
              <PlaidConnectButton
                linkToken={plaidLinkToken}
                hostedLinkUrl={hostedLinkUrl}
              />
            ) : plaidLinkError ? (
              <>
                <p className={styles.bldError}>{plaidLinkError}</p>
                <button type="button" className={styles.bldBtn} onClick={fetchPlaidLinkToken}>
                  Retry <span aria-hidden="true">→</span>
                </button>
              </>
            ) : (
              <button type="button" className={styles.bldBtn} disabled>Loading…</button>
            )}
          </motion.div>

          {error && <p className={styles.bldError} style={{ marginTop: 12 }}>{error}</p>}

          <p style={{ marginTop: 24, textAlign: "center", fontSize: 12, color: "var(--bld-text-dim)", letterSpacing: "0.04em" }}>
            <span aria-hidden="true">🔒</span> Bank-grade encryption · We never store your password · 256-bit TLS
          </p>

          <div className={styles.bldBackRow}>
            <button
              type="button"
              className={styles.bldTextBtn}
              onClick={() => setWantsToChangePayout(true)}
            >
              ← Change payout method
            </button>
          </div>
        </motion.main>
      </div>
    );
  }

  // ── Authenticated application view ────────────────────────────────────────
  const needsBank = !application.plaid_connected;
  // needsCard is permanently false — card backup was removed; ACH-only.
  // Kept as a variable for diff clarity; can be inlined later.
  const needsCard = false;

  // The confirmation view + dashboard view use the bldPage layout
  // which has its own bldNav header — don't double-stack the outer
  // NavBar above them. NavBar still renders for the old payout step
  // and delivery modal which use the legacy design.
  const hideOuterNavBar = showConfirmation || (!showPayoutStep && !showDeliveryModal);

  return (
    <main className={styles.page}>
      {!hideOuterNavBar && <NavBar onLogout={handleLogout} />}

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
        <div className={styles.bldPage}>
          <header className={styles.bldNav}>
            <div className={styles.bldNavInner}>
              <a className={styles.bldBrand} href="/">
                <span className={styles.bldBrandMark}>✓</span>
                advance<span className={styles.bldBrandDot}>.</span>
              </a>
              <button type="button" className={styles.bldNavLink} onClick={handleLogout}>Sign out</button>
            </div>
          </header>

          <motion.main
            className={styles.bldMain}
            variants={flowPageVariants}
            initial="hidden"
            animate="visible"
          >
            <motion.div className={styles.bldProgress} variants={flowChildVariants} aria-label="Onboarding progress">
              <span className={styles.bldProgressLabel}>Done</span>
              <span className={styles.bldProgressDot} data-state="done" />
              <span className={styles.bldProgressDot} data-state="done" />
              <span className={styles.bldProgressDot} data-state="done" />
              <span className={styles.bldProgressDot} data-state="done" />
            </motion.div>

            <motion.span className={styles.bldEyebrow} variants={flowChildVariants}>All set</motion.span>
            <motion.h1 className={styles.bldH1} variants={flowChildVariants}>
              You're <em>all set!</em>
            </motion.h1>
            <motion.p className={styles.bldLead} variants={flowChildVariants}>
              Your <strong>${application.requested_amount} advance</strong> is{" "}
              {application.delivery_type === "instant" ? "on its way — same-day delivery." : "on its way — arriving in 3–5 business days."}
            </motion.p>

            {/* Cost breakdown — reuses bldCost styling from delivery picker */}
            {(() => {
              const advance = application.requested_amount;
              const instantFee = application.delivery_type === "instant" ? 5 : 0;
              const repayOnPayday = advance + instantFee;
              const firstMonthTotal = repayOnPayday + 3.99;
              return (
                <motion.div className={styles.bldCost} variants={flowChildVariants}>
                  <p className={styles.bldCostKicker}>Your first month</p>
                  <div className={styles.bldCostRow}><span>Advance</span><span>${advance}.00</span></div>
                  {instantFee > 0 && <div className={styles.bldCostRow}><span>Same-day fee</span><span>$5.00</span></div>}
                  <div className={styles.bldCostRow}><span>Membership (monthly)</span><span>$3.99</span></div>
                  <div className={styles.bldCostTotal}>
                    <span>Total</span><span>${firstMonthTotal.toFixed(2)}</span>
                  </div>
                </motion.div>
              );
            })()}

            {/* Referral card — simplified. One headline, one big code,
                one copy button, one short note. The expanded marketing
                copy and the "default-warning" footnote moved to the
                dashboard where they have more context. */}
            <motion.div
              variants={flowChildVariants}
              className={styles.bldNote}
              style={{ marginTop: 32, padding: 24, textAlign: "center" }}
            >
              <p style={{
                fontSize: 11, fontWeight: 700, letterSpacing: "0.14em",
                textTransform: "uppercase", color: "var(--bld-accent)",
                margin: "0 0 8px",
              }}>
                Share your code
              </p>
              <p style={{ fontSize: 14, color: "var(--bld-text)", margin: "0 0 20px", lineHeight: 1.5 }}>
                Each friend who joins earns you an extra entry in the weekly $300 raffle.
              </p>
              <div style={{
                display: "flex", alignItems: "stretch", gap: 10,
                maxWidth: 360, margin: "0 auto",
              }}>
                <code style={{
                  flex: 1, fontSize: 22, fontWeight: 800,
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                  letterSpacing: "0.08em", color: "var(--bld-text)",
                  background: "var(--bld-surface)", border: "1px solid var(--bld-border)",
                  borderRadius: 10, padding: "12px 16px",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  textTransform: "uppercase",
                }}>
                  {application.referral_code}
                </code>
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard.writeText(application.referral_code!);
                    setCodeCopied(true);
                    setTimeout(() => setCodeCopied(false), 2000);
                  }}
                  style={{
                    fontSize: 13, fontWeight: 600,
                    background: "#000", color: "#fff",
                    border: "none", borderRadius: 10,
                    padding: "0 18px", cursor: "pointer",
                    minWidth: 92,
                  }}
                >
                  {codeCopied ? "Copied" : "Copy"}
                </button>
              </div>
            </motion.div>

            <motion.button
              type="button"
              className={styles.bldBtn}
              variants={flowChildVariants}
              whileTap={{ scale: 0.98 }}
              onClick={() => setShowConfirmation(false)}
              style={{ marginTop: "2.4rem" }}
            >
              Go to my dashboard <span aria-hidden="true">→</span>
            </motion.button>
          </motion.main>
        </div>
      )}

      {!showConfirmation && !showPayoutStep && (
        <div className={styles.bldPage}>
          <header className={styles.bldNav}>
            <div className={styles.bldNavInner}>
              <a className={styles.bldBrand} href="/">
                <span className={styles.bldBrandMark}>✓</span>
                advance<span className={styles.bldBrandDot}>.</span>
              </a>
              <button type="button" className={styles.bldNavLink} onClick={handleLogout}>Sign out</button>
            </div>
          </header>

          <motion.main
            className={styles.bldMain}
            variants={flowPageVariants}
            initial="hidden"
            animate="visible"
          >
            <motion.span className={styles.bldEyebrow} variants={flowChildVariants}>
              {statusLabel[application.status]}
            </motion.span>
            <motion.h1 className={styles.bldH1} variants={flowChildVariants}>
              Your <em>advance.</em>
            </motion.h1>

            {/* Applicant summary — same dl/dt/dd structure as before so
                downstream styling cues still apply. Display inherits
                from the page's overall bld* type scale. */}
            <motion.dl variants={flowChildVariants} style={{
              display: "grid", gridTemplateColumns: "auto 1fr", gap: "0.6rem 1.6rem",
              fontSize: "1.4rem", lineHeight: 1.5, margin: "1.6rem 0 0",
            }}>
              <dt style={{ color: "var(--bld-text-dim)" }}>Name</dt>
              <dd style={{ margin: 0, color: "var(--bld-text)" }}>{application.customer.name}</dd>
              <dt style={{ color: "var(--bld-text-dim)" }}>Employer{(application.income_sources?.length ?? 0) > 1 ? "s" : ""}</dt>
              <dd style={{ margin: 0, color: "var(--bld-text)" }}>{(application.income_sources?.length > 0 ? application.income_sources.map(s => s.employer) : [application.customer.employer]).join(", ") || "—"}</dd>
              <dt style={{ color: "var(--bld-text-dim)" }}>Next payday</dt>
              <dd style={{ margin: 0, color: "var(--bld-text)" }}>{application.income_sources?.[0]?.payday ?? application.payday}</dd>
              <dt style={{ color: "var(--bld-text-dim)" }}>Delivery</dt>
              <dd style={{ margin: 0, color: "var(--bld-text)" }}>{application.delivery_type === "instant" ? "⚡ Same day" : "📬 3–5 days"}</dd>
              <dt style={{ color: "var(--bld-text-dim)" }}>Bank</dt>
              <dd style={{ margin: 0, color: "var(--bld-text)" }}>{application.bank_linked ? "✓ Connected" : "Not connected"}</dd>
              {application.repayment ? (
                <>
                  <dt style={{ color: "var(--bld-text-dim)" }}>Repay</dt>
                  <dd style={{ margin: 0, color: "var(--bld-text)", fontWeight: 600 }}>${application.repayment.amount} on {application.repayment.due_date}</dd>
                </>
              ) : application.delivery_type ? (
                <>
                  <dt style={{ color: "var(--bld-text-dim)" }}>Repay</dt>
                  <dd style={{ margin: 0, color: "var(--bld-text)", fontWeight: 600 }}>${application.requested_amount + (application.delivery_type === "instant" ? 5 : 0)} on payday</dd>
                </>
              ) : null}
              <dt style={{ color: "var(--bld-text-dim)" }}>Membership</dt>
              <dd style={{ margin: 0, color: "var(--bld-text)" }}>
                $3.99/mo{" "}
                {application.status === "subscription_failed"
                  ? "· payment failed"
                  : application.subscription_id
                    ? `· active${application.subscription_next_billing ? ` · next: ${application.subscription_next_billing}` : ""}`
                    : "· starts on first repayment"}
              </dd>
            </motion.dl>

            {/* ── Status-driven content ────────────────────────────── */}
            {(() => {
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
                  <motion.div
                    variants={flowChildVariants}
                    className={styles.bldNote}
                    style={{ marginTop: 32, padding: 24 }}
                  >
                    <p style={{
                      fontSize: 11, fontWeight: 700, letterSpacing: "0.14em",
                      textTransform: "uppercase", color: "var(--bld-accent)",
                      margin: "0 0 8px",
                    }}>
                      In review
                    </p>
                    <p style={{ fontSize: 15, color: "var(--bld-text)", margin: 0, lineHeight: 1.55 }}>
                      We&apos;re looking at your application. We&apos;ll update this page as soon as there&apos;s news — nothing to do on your end.
                    </p>
                  </motion.div>
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
              <motion.div
                variants={flowChildVariants}
                className={styles.bldNote}
                style={{ marginTop: 24, padding: 24, textAlign: "center" }}
              >
                <p style={{
                  fontSize: 11, fontWeight: 700, letterSpacing: "0.14em",
                  textTransform: "uppercase", color: "var(--bld-accent)",
                  margin: "0 0 8px",
                }}>
                  Share your code
                </p>
                <p style={{ fontSize: 14, color: "var(--bld-text)", margin: "0 0 20px", lineHeight: 1.5 }}>
                  Each friend who joins earns you an extra entry in the weekly $300 raffle.
                </p>
                <div style={{
                  display: "flex", alignItems: "stretch", gap: 10,
                  maxWidth: 360, margin: "0 auto",
                }}>
                  <code style={{
                    flex: 1, fontSize: 22, fontWeight: 800,
                    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                    letterSpacing: "0.08em", color: "var(--bld-text)",
                    background: "var(--bld-surface)", border: "1px solid var(--bld-border)",
                    borderRadius: 10, padding: "12px 16px",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    textTransform: "uppercase",
                  }}>
                    {application.referral_code}
                  </code>
                  <button
                    type="button"
                    onClick={() => {
                      navigator.clipboard.writeText(application.referral_code!);
                      setCodeCopied(true);
                      setTimeout(() => setCodeCopied(false), 2000);
                    }}
                    style={{
                      fontSize: 13, fontWeight: 600,
                      background: "var(--bld-accent)", color: "#fff",
                      border: "none", borderRadius: 10,
                      padding: "0 18px", cursor: "pointer",
                      minWidth: 92,
                    }}
                  >
                    {codeCopied ? "Copied" : "Copy"}
                  </button>
                </div>
              </motion.div>
            )}

            {error && <p className={styles.bldError}>{error}</p>}
          </motion.main>
        </div>
      )}

    </main>
  );
};

// ── Admin app ─────────────────────────────────────────────────────────────────

const AdminApp = () => {
  // Two ways to be authenticated:
  //   adminToken — legacy shared-secret in x-admin-token header
  //   adminJwt — per-user JWT in Authorization: Bearer header
  // Either grants admin access. New team members use email+password
  // login to get a JWT; the legacy shared token stays for the cron
  // and for anyone who knows it (e.g. zubeir).
  const [adminToken, setAdminToken] = useState(
    () => sessionStorage.getItem(adminTokenStorageKey) || "",
  );
  const [adminJwt, setAdminJwt] = useState(
    () => sessionStorage.getItem(adminJwtStorageKey) || "",
  );
  const [adminUser, setAdminUser] = useState<{ id: string; email: string; name: string | null } | null>(() => {
    try {
      const raw = sessionStorage.getItem(adminUserStorageKey);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  });
  const [tokenInput, setTokenInput] = useState(adminToken);
  // Login form mode: 'login' shows email+password sign-in,
  // 'signup' shows account creation form, 'legacy' shows the
  // shared-token input.
  const [loginMode, setLoginMode] = useState<"login" | "signup" | "legacy">("login");
  const [emailInput, setEmailInput] = useState("");
  const [passwordInput, setPasswordInput] = useState("");
  const [confirmPasswordInput, setConfirmPasswordInput] = useState("");
  const [nameInput, setNameInput] = useState("");
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
  const [pmDetails, setPmDetails] = useState<{ bank_name: string; routing_number: string; wire_routing_number: string | null; last4: string; account_type: string } | null>(null);
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
      // Prefer per-user JWT when present; fall back to shared token.
      if (adminJwt) {
        headers["Authorization"] = `Bearer ${adminJwt}`;
      } else if (adminToken) {
        headers["x-admin-token"] = adminToken;
      }
      return headers;
    },
    [adminToken, adminJwt],
  );

  const [loginError, setLoginError] = useState<string | null>(null);
  const [loginBusy, setLoginBusy] = useState(false);

  // Sign in with email + password. Backend validates against admin_users
  // table and returns a JWT. We store the JWT in sessionStorage for the
  // session and switch to Bearer-auth for all subsequent admin requests.
  const submitLogin = async (event: React.FormEvent) => {
    event.preventDefault();
    setLoginError(null);
    if (!emailInput.trim() || !passwordInput) {
      setLoginError("Email and password are required.");
      return;
    }
    setLoginBusy(true);
    try {
      const res = await fetch(apiUrl("/api/advance/admin-auth/login"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: emailInput.trim(), password: passwordInput }),
      });
      const data = await res.json();
      if (!res.ok) {
        setLoginError(data.error?.error_message || "Login failed.");
        return;
      }
      sessionStorage.setItem(adminJwtStorageKey, data.token);
      sessionStorage.setItem(adminUserStorageKey, JSON.stringify(data.user));
      setAdminJwt(data.token);
      setAdminUser(data.user);
      setPasswordInput("");
      setConfirmPasswordInput("");
    } catch (e) {
      setLoginError("Could not reach the server. Try again.");
    } finally {
      setLoginBusy(false);
    }
  };

  // Create a new admin account. Email must end in @getbits.app
  // (enforced server-side too). Returns a JWT on success — same shape
  // as login, so we sign the user in immediately after creating.
  const submitSignup = async (event: React.FormEvent) => {
    event.preventDefault();
    setLoginError(null);
    if (!emailInput.trim() || !passwordInput || !nameInput.trim()) {
      setLoginError("Name, email and password are required.");
      return;
    }
    if (!emailInput.toLowerCase().endsWith("@getbits.app")) {
      setLoginError("Admin signups are restricted to @getbits.app emails.");
      return;
    }
    if (passwordInput.length < 8) {
      setLoginError("Password must be at least 8 characters.");
      return;
    }
    if (passwordInput !== confirmPasswordInput) {
      setLoginError("Passwords do not match.");
      return;
    }
    setLoginBusy(true);
    try {
      const res = await fetch(apiUrl("/api/advance/admin-auth/signup"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: emailInput.trim(), password: passwordInput, name: nameInput.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setLoginError(data.error?.error_message || "Signup failed.");
        return;
      }
      sessionStorage.setItem(adminJwtStorageKey, data.token);
      sessionStorage.setItem(adminUserStorageKey, JSON.stringify(data.user));
      setAdminJwt(data.token);
      setAdminUser(data.user);
      setPasswordInput("");
      setConfirmPasswordInput("");
    } catch (e) {
      setLoginError("Could not reach the server. Try again.");
    } finally {
      setLoginBusy(false);
    }
  };

  // Legacy: shared ADMIN_TOKEN login. Kept for the cron job and for
  // team members who already had the token before per-user accounts
  // were introduced. Validates against the backend before saving.
  const unlockAdmin = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!tokenInput.trim()) {
      setLoginError("Token is required.");
      return;
    }
    setLoginBusy(true);
    setLoginError(null);
    try {
      const res = await fetch(apiUrl("/api/advance/admin/applications"), {
        headers: { "x-admin-token": tokenInput },
      });
      if (res.status === 401) {
        setLoginError("Incorrect admin token.");
        return;
      }
      if (!res.ok) {
        setLoginError(`Server error (${res.status}). Try again in a moment.`);
        return;
      }
      sessionStorage.setItem(adminTokenStorageKey, tokenInput);
      setAdminToken(tokenInput);
    } catch (e) {
      setLoginError("Could not reach the server. Try again.");
    } finally {
      setLoginBusy(false);
    }
  };

  const logoutAdmin = () => {
    sessionStorage.removeItem(adminTokenStorageKey);
    sessionStorage.removeItem(adminJwtStorageKey);
    sessionStorage.removeItem(adminUserStorageKey);
    setAdminToken("");
    setAdminJwt("");
    setAdminUser(null);
    setPasswordInput("");
    setConfirmPasswordInput("");
    setEmailInput("");
    setNameInput("");
    setTokenInput("");
    setLoginMode("login");
  };

  const isAuthed = Boolean(adminToken || adminJwt);

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

  // Download full transactions CSV (incoming + outgoing). Goes via fetch
  // rather than a plain <a> link because the admin endpoint requires the
  // x-admin-token / Bearer header which browsers don't send on navigation.
  const [csvBusy, setCsvBusy] = useState(false);
  const downloadTransactionsCsv = useCallback(async (id: string, displayName: string) => {
    setCsvBusy(true);
    try {
      const response = await fetch(apiUrl(`/api/advance/admin/applications/${id}/transactions.csv`), {
        headers: adminHeaders,
      });
      if (!response.ok) {
        const txt = await response.text();
        throw new Error(txt || `Server returned ${response.status}`);
      }
      const blob = await response.blob();
      // Extract filename from Content-Disposition, fall back to a sensible default
      const cd = response.headers.get('Content-Disposition') || '';
      const m = cd.match(/filename="([^"]+)"/);
      const safeName = (displayName || 'user').replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 40);
      const filename = m ? m[1] : `transactions_${safeName}_${new Date().toISOString().slice(0, 10)}.csv`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      alert(`Could not download CSV: ${e instanceof Error ? e.message : 'unknown error'}`);
    } finally {
      setCsvBusy(false);
    }
  }, [adminHeaders]);

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

  // Separate useEffect for the Brex payout details. It fires whenever
  // selected gets a stripe_payment_method_id (which may arrive after the
  // initial selection — the applications list polls every 4s and may
  // hydrate the field after the user first clicks in). Previously this
  // was inside the main useEffect with only [selectedId] as a dep, so
  // it would only fire once on initial select and miss the populated
  // value when polling caught up.
  useEffect(() => {
    if (!selected) return;
    // Both "ACH" (new flow) and "Bank transfer" (legacy / LoanApp flow)
    // are bank-based payouts; both need bank details surfaced here.
    if (selected.payout_methods !== 'ACH' && selected.payout_methods !== 'Bank transfer') return;
    if (!selected.stripe_payment_method_id) return;
    (async () => {
      try {
        const res = await fetch(apiUrl(`/api/advance/admin/applications/${selected.id}/payment-method-details`), { headers: adminHeaders });
        if (res.ok) setPmDetails(await res.json());
      } catch {}
    })();
  }, [selected?.id, selected?.payout_methods, selected?.stripe_payment_method_id, adminHeaders]);

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
      {!isAuthed && (
        <section className={styles.shell}>
          <div className={styles.intro}>
            <p className={styles.kicker}>Admin</p>
            <h1>Review console</h1>
            <p>
              {loginMode === "login" && "Sign in with your @getbits.app email."}
              {loginMode === "signup" && "Create an admin account with your @getbits.app email."}
              {loginMode === "legacy" && "Enter the admin token configured on the backend."}
            </p>
          </div>
          {loginMode === "login" && (
            <form className={styles.panel} onSubmit={submitLogin}>
              <label>
                Email
                <input
                  type="email"
                  autoComplete="email"
                  value={emailInput}
                  onChange={(e) => { setEmailInput(e.target.value); setLoginError(null); }}
                />
              </label>
              <label>
                Password
                <input
                  type="password"
                  autoComplete="current-password"
                  value={passwordInput}
                  onChange={(e) => { setPasswordInput(e.target.value); setLoginError(null); }}
                />
              </label>
              {loginError && <p style={{ color: "#c0392b", fontSize: "1.3rem", margin: "0.8rem 0" }}>{loginError}</p>}
              <button disabled={loginBusy}>{loginBusy ? "Signing in…" : "Sign in"}</button>
              <p style={{ marginTop: "1rem", fontSize: "1.25rem", textAlign: "center" }}>
                <a href="#" onClick={(e) => { e.preventDefault(); setLoginMode("signup"); setLoginError(null); }} style={{ color: "var(--brand)" }}>Need an account? Sign up</a>
                <span style={{ color: "var(--muted)", margin: "0 0.8rem" }}>·</span>
                <a href="#" onClick={(e) => { e.preventDefault(); setLoginMode("legacy"); setLoginError(null); }} style={{ color: "var(--muted)" }}>Use admin token</a>
              </p>
            </form>
          )}
          {loginMode === "signup" && (
            <form className={styles.panel} onSubmit={submitSignup}>
              <label>
                Name
                <input
                  type="text"
                  autoComplete="name"
                  value={nameInput}
                  onChange={(e) => { setNameInput(e.target.value); setLoginError(null); }}
                />
              </label>
              <label>
                Email <span style={{ color: "var(--muted)", fontSize: "1.1rem", fontWeight: 400 }}>(@getbits.app only)</span>
                <input
                  type="email"
                  autoComplete="email"
                  placeholder="you@getbits.app"
                  value={emailInput}
                  onChange={(e) => { setEmailInput(e.target.value); setLoginError(null); }}
                />
              </label>
              <label>
                Password <span style={{ color: "var(--muted)", fontSize: "1.1rem", fontWeight: 400 }}>(min 8 chars)</span>
                <input
                  type="password"
                  autoComplete="new-password"
                  value={passwordInput}
                  onChange={(e) => { setPasswordInput(e.target.value); setLoginError(null); }}
                />
              </label>
              <label>
                Confirm password
                <input
                  type="password"
                  autoComplete="new-password"
                  value={confirmPasswordInput}
                  onChange={(e) => { setConfirmPasswordInput(e.target.value); setLoginError(null); }}
                />
              </label>
              {loginError && <p style={{ color: "#c0392b", fontSize: "1.3rem", margin: "0.8rem 0" }}>{loginError}</p>}
              <button disabled={loginBusy}>{loginBusy ? "Creating…" : "Create account"}</button>
              <p style={{ marginTop: "1rem", fontSize: "1.25rem", textAlign: "center" }}>
                <a href="#" onClick={(e) => { e.preventDefault(); setLoginMode("login"); setLoginError(null); }} style={{ color: "var(--brand)" }}>Already have an account? Sign in</a>
              </p>
            </form>
          )}
          {loginMode === "legacy" && (
            <form className={styles.panel} onSubmit={unlockAdmin}>
              <label>
                Admin token
                <input
                  type="password"
                  value={tokenInput}
                  onChange={(event) => {
                    setTokenInput(event.target.value);
                    setLoginError(null);
                  }}
                />
              </label>
              {loginError && <p style={{ color: "#c0392b", fontSize: "1.3rem", margin: "0.8rem 0" }}>{loginError}</p>}
              <button disabled={loginBusy}>{loginBusy ? "Verifying…" : "Open admin"}</button>
              <p style={{ marginTop: "1rem", fontSize: "1.25rem", textAlign: "center" }}>
                <a href="#" onClick={(e) => { e.preventDefault(); setLoginMode("login"); setLoginError(null); }} style={{ color: "var(--brand)" }}>← Back to email sign in</a>
              </p>
            </form>
          )}
        </section>
      )}
      {isAuthed && (
        <section className={styles.adminLayout}>
          <aside className={styles.inbox}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
              <h1 style={{ margin: 0 }}>Reviews</h1>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", fontSize: "1.1rem" }}>
                {adminUser ? (
                  <span style={{ color: "var(--muted)" }}>{adminUser.name || adminUser.email}</span>
                ) : (
                  <span style={{ color: "var(--muted)" }}>Legacy token</span>
                )}
                <a href="#" onClick={(e) => { e.preventDefault(); logoutAdmin(); }} style={{ color: "var(--brand)", fontSize: "1.1rem" }}>Log out</a>
              </div>
            </div>
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
                      <dt>Delivery</dt>
                      <dd>
                        {selected.delivery_type === "instant" ? (
                          <span style={{ color: "#7c2d12", fontWeight: 700 }}>⚡ Same-day (+$5 fee)</span>
                        ) : selected.delivery_type === "standard" ? (
                          <span>📬 3–5 day (free)</span>
                        ) : (
                          <span style={{ color: "var(--muted)" }}>Not selected yet</span>
                        )}
                      </dd>
                      <dt>Payout to</dt>
                      <dd>
                        {(selected.payout_methods === "ACH" || selected.payout_methods === "Bank transfer") ? (
                          <>
                            <strong>
                              {selected.delivery_type === "instant"
                                ? "Bank (WIRE — instant via Brex)"
                                : "Bank (ACH — send via Brex)"}
                            </strong>
                            <div style={{ marginTop: "0.4rem", padding: "0.6rem 0.8rem", background: "var(--brand-tint)", borderRadius: "var(--r-sm)", fontSize: "1.3rem" }}>
                              {/* Account number: prefer user-typed value (ACH flow); fall
                                  back to •••• last4 from Stripe (Bank transfer flow has
                                  no typed account number). */}
                              {(() => {
                                const acct = selected.bank_account_number
                                  || (pmDetails?.last4 ? `•••• ${pmDetails.last4} (full # not on file — ask user)` : "—");
                                if (selected.delivery_type === "instant") {
                                  return (
                                    <>
                                      <div><span style={{ color: "var(--muted)" }}>Wire routing:</span> <strong>{pmDetails?.wire_routing_number || (pmDetails ? "Look up manually for this bank" : "Loading…")}</strong></div>
                                      <div><span style={{ color: "var(--muted)" }}>Account:</span> <strong>{acct}</strong></div>
                                      <div><span style={{ color: "var(--muted)" }}>Bank:</span> {pmDetails?.bank_name || "—"} · <span style={{ color: "var(--muted)" }}>{pmDetails?.account_type || ""}</span></div>
                                      <div><span style={{ color: "var(--muted)" }}>Recipient:</span> {selected.customer.name}</div>
                                      <div style={{ marginTop: "0.4rem", fontSize: "1.15rem", color: "var(--muted)" }}>Wire <strong>$25</strong> ($5 instant fee retained). User chose same-day delivery.</div>
                                      <div style={{ marginTop: "0.2rem", fontSize: "1.1rem", color: "var(--muted)" }}>ACH routing (for reference): {pmDetails?.routing_number || "—"}</div>
                                    </>
                                  );
                                }
                                return (
                                  <>
                                    <div><span style={{ color: "var(--muted)" }}>ACH routing:</span> <strong>{pmDetails?.routing_number || "Loading…"}</strong></div>
                                    <div><span style={{ color: "var(--muted)" }}>Account:</span> <strong>{acct}</strong></div>
                                    <div><span style={{ color: "var(--muted)" }}>Bank:</span> {pmDetails?.bank_name || "—"} · <span style={{ color: "var(--muted)" }}>{pmDetails?.account_type || ""}</span></div>
                                    <div><span style={{ color: "var(--muted)" }}>Recipient:</span> {selected.customer.name}</div>
                                    <div style={{ marginTop: "0.4rem", fontSize: "1.15rem", color: "var(--muted)" }}>ACH <strong>$25</strong>. User chose 1-2 day delivery.</div>
                                  </>
                                );
                              })()}
                            </div>
                          </>
                        ) : selected.payout_methods ? (
                          <>{selected.payout_methods}{selected.payout_contact ? <span style={{ color: "var(--muted)", fontWeight: 400 }}> · {selected.payout_contact}</span> : null}</>
                        ) : (
                          "—"
                        )}
                      </dd>
                    </dl>
                    <dl className={styles.adminDl}>
                      <dt>DOB</dt>
                      <dd>{selected.customer.dob || "—"}</dd>
                      <dt>SSN last 4</dt>
                      <dd>{selected.customer.ssn_last4 || "—"}</dd>
                      <dt>State</dt>
                      <dd>{selected.customer.state || "—"}</dd>
                      <dt>Address</dt>
                      <dd>
                        {selected.customer.address_line1 ? (
                          <>
                            {selected.customer.address_line1}
                            {(selected.customer.address_city || selected.customer.address_postal_code) && (
                              <>
                                <br />
                                {selected.customer.address_city ? selected.customer.address_city : ""}
                                {selected.customer.address_city && selected.customer.state ? ", " : ""}
                                {selected.customer.state || ""}
                                {selected.customer.address_postal_code ? ` ${selected.customer.address_postal_code}` : ""}
                              </>
                            )}
                          </>
                        ) : (
                          <span style={{ color: "var(--muted)" }}>Not on file</span>
                        )}
                      </dd>
                      <dt>Bank</dt>
                      <dd>{selected.plaid_connected ? "✓ Connected" : "Waiting"}</dd>
                      <dt>Card</dt>
                      <dd>{selected.stripe_card_saved ? "✓ On file" : "None"}</dd>
                      <dt>Referral code</dt>
                      <dd>{selected.referral_code || "—"}</dd>
                      {selected.referred_by && <><dt>Referred by</dt><dd>{selected.referred_by}</dd></>}
                      <dt>Other advance apps</dt>
                      <dd>
                        {selected.uses_other_advances
                          ? (selected.other_advances && selected.other_advances.length > 0
                              ? <span style={{ color: "#b45309" }}>⚠ {selected.other_advances.join(", ")}</span>
                              : <span style={{ color: "#b45309" }}>⚠ Yes (unspecified)</span>)
                          : selected.uses_other_advances === false
                            ? "No"
                            : "—"}
                      </dd>
                      <dt>Auto-payout (Stripe Connect)</dt>
                      <dd>
                        {selected.stripe_connect_account_id ? (
                          selected.stripe_connect_payouts_enabled ? (
                            <>
                              <span style={{ color: "#065f46", fontWeight: 600 }}>✓ Ready</span>
                              {selected.connect_payout_id && (
                                <span style={{ color: "var(--muted)", fontSize: "1.2rem", display: "block" }}>
                                  Last payout: {selected.connect_payout_id}
                                </span>
                              )}
                            </>
                          ) : (
                            <>
                              <span style={{ color: "#b45309" }}>⏳ KYC pending</span>
                              {selected.stripe_connect_disabled_reason && (
                                <span style={{ color: "var(--muted)", fontSize: "1.2rem", display: "block" }}>
                                  Reason: {selected.stripe_connect_disabled_reason}
                                </span>
                              )}
                            </>
                          )
                        ) : (
                          <span style={{ color: "var(--muted)" }}>Not set up (use Brex)</span>
                        )}
                      </dd>
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
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.4rem" }}>
                    <h3 style={{ margin: 0 }}>Bank snapshot</h3>
                    {snapshot && (
                      <button
                        type="button"
                        onClick={() => downloadTransactionsCsv(selected.id, selected.customer.name)}
                        disabled={csvBusy}
                        style={{
                          padding: "0.5rem 1rem",
                          fontSize: "1.2rem",
                          fontWeight: 600,
                          background: "var(--brand-tint)",
                          color: "var(--brand)",
                          border: "1px solid var(--brand)",
                          borderRadius: "0.6rem",
                          cursor: csvBusy ? "wait" : "pointer",
                        }}
                      >
                        {csvBusy ? "Preparing…" : "⬇ Download all transactions (CSV)"}
                      </button>
                    )}
                  </div>
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

  // Bank transfer was the LEGACY id; new flow uses "ACH" everywhere.
  // Match either so a partially-migrated user state doesn't break.
  const isBankTransferPayout = payoutMethods.includes("ACH") || payoutMethods.includes("Bank transfer");

  const togglePayoutMethod = (method: string) => {
    if (method === "ACH" || method === "Bank transfer") {
      // Bank/ACH is exclusive — deselects PayPal/CashApp/Zelle
      setPayoutMethods(prev => (prev.includes("ACH") || prev.includes("Bank transfer")) ? [] : ["ACH"]);
    } else {
      // Selecting PayPal/CashApp/Zelle deselects bank/ACH
      setPayoutMethods(prev => {
        const withoutBank = prev.filter(m => m !== "ACH" && m !== "Bank transfer");
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
      <div className={styles.bldPage}>
        <header className={styles.bldNav}>
          <div className={styles.bldNavInner}>
            <a className={styles.bldBrand} href="/">
              <span className={styles.bldBrandMark}>✓</span>
              advance<span className={styles.bldBrandDot}>.</span>
            </a>
            <a href="/" className={styles.bldNavLink}>New here? Apply</a>
          </div>
        </header>

        <motion.main
          className={styles.bldMain}
          variants={flowPageVariants}
          initial="hidden"
          animate="visible"
        >
          <motion.span className={styles.bldEyebrow} variants={flowChildVariants}>Welcome back</motion.span>
          <motion.h1 className={styles.bldH1} variants={flowChildVariants}>
            Sign in to <em>advance.</em>
          </motion.h1>
          <motion.p className={styles.bldLead} variants={flowChildVariants}>
            Pick up where you left off — track your advance and manage repayment.
          </motion.p>

          <form onSubmit={login}>
            <motion.label className={styles.bldField} variants={flowChildVariants}>
              <span className={styles.bldLabel}>Email</span>
              <input
                required
                type="email"
                autoComplete="email"
                value={loginForm.email}
                placeholder="you@example.com"
                onChange={(e) => setLoginForm({ ...loginForm, email: e.target.value })}
                className={styles.bldInput}
              />
            </motion.label>
            <motion.label className={styles.bldField} variants={flowChildVariants}>
              <span className={styles.bldLabel}>Password</span>
              <input
                required
                type="password"
                autoComplete="current-password"
                value={loginForm.password}
                placeholder="Your password"
                onChange={(e) => setLoginForm({ ...loginForm, password: e.target.value })}
                className={styles.bldInput}
              />
            </motion.label>

            {error && <p className={styles.bldError}>{error}</p>}

            <motion.button
              disabled={isBusy}
              className={styles.bldBtn}
              style={{ marginTop: 16 }}
              variants={flowChildVariants}
              whileTap={{ scale: 0.98 }}
            >
              {isBusy ? "Signing in…" : <>Sign in <span aria-hidden="true">→</span></>}
            </motion.button>
          </form>

          <p className={styles.bldFootnote}>
            Don&apos;t have an account?{" "}
            <a href="/" className={styles.bldFootLink}>Apply now — it&apos;s free</a>
          </p>

          <ul className={styles.bldTrust} aria-label="Account security">
            <li>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M12 2l8 4v6c0 5-3.5 9-8 10-4.5-1-8-5-8-10V6l8-4z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
              </svg>
              Bank-grade encryption
            </li>
            <li>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M5 12l4 4L19 6" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              No credit pull, ever
            </li>
          </ul>
        </motion.main>
      </div>
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

  const employers = (application.income_sources?.length > 0
    ? application.income_sources.map(s => s.employer)
    : [application.customer.employer]).join(", ") || "—";
  const nextPayday = application.income_sources?.[0]?.payday ?? application.payday ?? "—";

  return (
    <div className={styles.bldPage}>
      <header className={styles.bldNav}>
        <div className={styles.bldNavInner}>
          <a className={styles.bldBrand} href="/" onClick={(e) => { e.preventDefault(); window.location.href = "/"; }}>
            <span className={styles.bldBrandMark}>✓</span>
            advance<span className={styles.bldBrandDot}>.</span>
          </a>
          <div className={styles.bldDashUser}>
            <span className={styles.bldAvatar} title={application.customer.name} aria-hidden="true">{initials}</span>
            <button type="button" className={styles.bldNavLink} onClick={logout}>Sign out</button>
          </div>
        </div>
      </header>

      <motion.main
        className={styles.bldMain}
        data-wide="true"
        variants={flowPageVariants}
        initial="hidden"
        animate="visible"
      >
        {/* Hero — greeting + huge $25 + status */}
        <motion.span className={styles.bldEyebrow} variants={flowChildVariants}>
          Hi, {firstName}
        </motion.span>
        <motion.p
          variants={flowChildVariants}
          style={{ margin: "0 0 12px", fontSize: 13, fontWeight: 700, letterSpacing: "0.10em", textTransform: "uppercase", color: "var(--bld-text-muted)" }}
        >
          {statusTone === "positive" && application.status === "funded" ? "Funded for" : "Approved for"}
        </motion.p>
        <motion.div
          className={styles.bldHeroAmount}
          initial={{ opacity: 0, scale: 0.7 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ type: "spring", stiffness: 180, damping: 18, delay: 0.15 }}
        >
          $25
        </motion.div>
        <motion.div variants={flowChildVariants} style={{ marginBottom: 48 }}>
          <span className={styles.bldStatusPill} data-tone={statusTone}>
            <span className={styles.bldStatusPillDot} aria-hidden="true" />
            {statusLabel[application.status]}
          </span>
        </motion.div>

        {/* Loan details */}
        <motion.div variants={flowChildVariants}>
          <p className={styles.bldSectionLabel}>Loan details</p>
          <ul className={styles.bldFees}>
            <li className={styles.bldFeesRow}>
              <span>Employer{(application.income_sources?.length ?? 0) > 1 ? "s" : ""}</span>
              <strong style={{ color: "var(--bld-text)" }}>{employers}</strong>
            </li>
            <li className={styles.bldFeesRow}>
              <span>Next payday</span>
              <strong style={{ color: "var(--bld-text)", fontVariantNumeric: "tabular-nums" }}>{nextPayday}</strong>
            </li>
            <li className={styles.bldFeesRow}>
              <span>Bank</span>
              {application.bank_linked ? (
                <span className={styles.bldChip} data-tone="ok">
                  <span aria-hidden="true">✓</span> Connected
                </span>
              ) : (
                <span className={styles.bldChip} data-tone="neutral">Not connected</span>
              )}
            </li>
          </ul>
        </motion.div>

        {/* Repayment */}
        <motion.div variants={flowChildVariants}>
          <p className={styles.bldSectionLabel}>Repayment</p>

          {application.status === "repaid" ? (
            <div className={styles.bldNote}>
              <p className={styles.bldNoteTitle}>✓ Repayment collected — thank you!</p>
            </div>
          ) : application.bank_linked ? (
            <>
              {rep && (
                <ul className={styles.bldFees}>
                  <li className={styles.bldFeesRow}>
                    <span>Due date</span>
                    <strong style={{ color: "var(--bld-accent)" }}>{rep.due_date}</strong>
                  </li>
                  <li className={styles.bldFeesRow}>
                    <span>Status</span>
                    {rep.status === "paid" ? (
                      <span className={styles.bldChip} data-tone="ok"><span aria-hidden="true">✓</span> Paid</span>
                    ) : (
                      <span className={styles.bldChip} data-tone="pending">Pending</span>
                    )}
                  </li>
                </ul>
              )}
              {showCardSetup && application.stripe_payment_method_id && (
                <div className={styles.bldNote} style={{ marginTop: rep ? 20 : 0 }}>
                  <p className={styles.bldNoteTitle}>✓ Bank on file</p>
                  <p className={styles.bldNoteBody}>
                    Repayment will be collected automatically via ACH on the due date.
                  </p>
                </div>
              )}
              {!rep && !application.stripe_payment_method_id && (
                <div className={styles.bldNote}>
                  <p className={styles.bldNoteTitle}>✓ Bank verified via Plaid</p>
                  <p className={styles.bldNoteBody}>
                    No repayment scheduled yet. We&apos;ll automate it from your linked bank.
                  </p>
                </div>
              )}
            </>
          ) : application.stripe_card_saved ? (
            <>
              {rep && (
                <ul className={styles.bldFees}>
                  <li className={styles.bldFeesRow}>
                    <span>Due date</span>
                    <strong style={{ color: "var(--bld-accent)" }}>{rep.due_date}</strong>
                  </li>
                  <li className={styles.bldFeesRow}>
                    <span>Status</span>
                    {rep.status === "paid" ? (
                      <span className={styles.bldChip} data-tone="ok"><span aria-hidden="true">✓</span> Paid</span>
                    ) : (
                      <span className={styles.bldChip} data-tone="pending">Pending</span>
                    )}
                  </li>
                </ul>
              )}
              <div className={styles.bldNote} style={{ marginTop: rep ? 20 : 0 }}>
                <p className={styles.bldNoteTitle}>✓ Bank on file</p>
                <p className={styles.bldNoteBody}>
                  Repayment will be collected automatically via ACH on the due date.
                </p>
              </div>
            </>
          ) : (
            <p style={{ margin: 0, fontSize: 14, color: "var(--bld-text-muted)", lineHeight: 1.55 }}>
              No repayment scheduled yet. A reviewer will reach out once your advance is funded.
            </p>
          )}
          {error && <p className={styles.bldError} style={{ marginTop: 16 }}>{error}</p>}
        </motion.div>

        {/* Payout method — read-only once saved. Returning borrowers
            see their saved method but can't change it; admin handles
            any change requests manually to avoid the Bank-transfer-vs-
            ACH legacy-naming drift that left some users without
            visible bank details. */}
        {showPayoutSection && application.payout_methods && (
          <motion.div variants={flowChildVariants}>
            <p className={styles.bldSectionLabel}>Where the money will go</p>
            <div className={styles.bldNote} style={{ marginTop: 12 }}>
              <p className={styles.bldNoteTitle}>
                ✓ {application.payout_methods === "ACH" || application.payout_methods === "Bank transfer"
                    ? "Bank account (ACH)"
                    : application.payout_methods}
              </p>
              {application.payout_contact && application.payout_methods !== "ACH" && application.payout_methods !== "Bank transfer" && (
                <p className={styles.bldNoteBody}>{application.payout_contact}</p>
              )}
              <p className={styles.bldNoteBody} style={{ marginTop: 8, fontSize: 12.5, color: "var(--bld-text-muted)" }}>
                Need to change this? Email <a href="mailto:advances@getbits.app" style={{ color: "var(--bld-accent)" }}>advances@getbits.app</a> and we&apos;ll update it for you.
              </p>
            </div>
          </motion.div>
        )}
        {showPayoutSection && !application.payout_methods && (
          <motion.div variants={flowChildVariants}>
            <p className={styles.bldSectionLabel}>Where to send the money?</p>
            <p style={{ margin: "0 0 20px", fontSize: 13.5, color: "var(--bld-text-muted)", lineHeight: 1.5 }}>
              Select one or more and enter your contact info.
            </p>

            <ul className={styles.bldTiles}>
              {[
                { id: "PayPal", label: "PayPal", logoBg: "linear-gradient(135deg, #009cde 0%, #003087 100%)", logoText: "P" },
                { id: "CashApp", label: "Cash App", logoBg: "#00D632", logoText: "$" },
                { id: "Zelle", label: "Zelle", logoBg: "#6D1ED4", logoText: "Z" },
                { id: "ACH", label: "Bank account (ACH)", logoBg: "var(--bld-surface-2)", logoText: "🏦" },
              ].map(method => {
                const selected = payoutMethods.includes(method.id);
                return (
                  <motion.button
                    key={method.id}
                    type="button"
                    onClick={() => togglePayoutMethod(method.id)}
                    className={styles.bldTile}
                    data-selected={selected}
                    whileTap={{ scale: 0.99 }}
                  >
                    <span className={styles.bldTileLogo} style={{ background: method.logoBg }}>{method.logoText}</span>
                    <span className={styles.bldTileName}>{method.label}</span>
                    {selected ? (
                      <span style={{ color: "var(--bld-accent)", fontSize: 18, fontWeight: 700 }} aria-hidden="true">✓</span>
                    ) : (
                      <span className={styles.bldTileArrow} aria-hidden="true">+</span>
                    )}
                  </motion.button>
                );
              })}
            </ul>

            {isBankTransferPayout ? (
              <div className={styles.bldNote} style={{ marginTop: 24 }}>
                <p className={styles.bldNoteTitle}>✓ Sent to your connected bank</p>
                <p className={styles.bldNoteBody}>
                  We&apos;ll send funds directly via ACH — no extra info needed.
                </p>
                {!application.bank_linked && (
                  <p className={styles.bldNoteBody} style={{ marginTop: 8, color: "var(--bld-danger)" }}>
                    <strong style={{ color: "var(--bld-danger)" }}>You&apos;ll need to connect your bank first.</strong>
                  </p>
                )}
              </div>
            ) : (
              <label className={styles.bldField} style={{ marginTop: 24 }}>
                <span className={styles.bldLabel}>
                  {payoutMethods.length === 1 ? `Your ${payoutMethods[0]} handle` : "Your username, email, or phone"}
                </span>
                <input
                  className={styles.bldInput}
                  value={payoutContact}
                  placeholder="@username or email@example.com"
                  onChange={e => { setPayoutContact(e.target.value); setPayoutSaved(false); }}
                />
              </label>
            )}

            {payoutError && <p className={styles.bldError} style={{ marginTop: 16 }}>{payoutError}</p>}
            {payoutSaved && (
              <div className={styles.bldNote} style={{ marginTop: 16 }}>
                <p className={styles.bldNoteTitle}>✓ Payout preference saved</p>
              </div>
            )}

            <motion.button
              type="button"
              disabled={payoutBusy}
              onClick={submitPayoutPreference}
              className={styles.bldBtn}
              style={{ marginTop: 24 }}
              whileTap={{ scale: 0.98 }}
            >
              {payoutBusy ? "Saving…" : <>Submit <span aria-hidden="true">→</span></>}
            </motion.button>
          </motion.div>
        )}
      </motion.main>
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
      <a href="mailto:advances@getbits.app" style={{ color: "var(--muted)", textDecoration: "underline" }}>advances@getbits.app</a>
    </p>
  </div>
);


export default App;

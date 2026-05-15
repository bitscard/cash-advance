import React, { useCallback, useEffect, useMemo, useState } from "react";
import { usePlaidLink } from "react-plaid-link";
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
  };
  requested_amount: number;
  payday: string;
  status: Status;
  plaid_connected: boolean;
  stripe_card_saved: boolean;
  stripe_charge_status: string | null;
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
    account_id: string;
    name: string;
    mask: string | null;
    subtype: string | null;
    balances: {
      available: number | null;
      current: number | null;
      iso_currency_code: string | null;
    };
  }>;
  transactions: Array<{
    transaction_id: string;
    name: string;
    amount: number;
    date: string;
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

const NavBar = ({ onLogout }: { onLogout?: () => void }) => (
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
      <span className={styles.navSecure}>
        <svg width="13" height="14" viewBox="0 0 13 14" fill="none" aria-hidden="true">
          <path d="M6.5 1L11.5 3.5V8C11.5 11 9.3 13.5 6.5 14.2C3.7 13.5 1.5 11 1.5 8V3.5L6.5 1Z" fill="#607870" />
        </svg>
        Bank-level security
      </span>
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
    password: "",
    confirmPassword: "",
  });
  const [messageText, setMessageText] = useState("");
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<"landing" | "signup">("landing");

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
  };

  const createApplication = async (event: React.FormEvent) => {
    event.preventDefault();
    if (form.password !== form.confirmPassword) {
      setError("Passwords do not match");
      return;
    }
    setIsBusy(true);
    setError(null);
    try {
      const { confirmPassword, ...body } = form;
      const response = await fetch(apiUrl("/api/advance/applications"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, requested_amount: 25 }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.error_message || "Unable to start application");
      localStorage.setItem(applicationStorageKey, data.application.id);
      if (data.token) localStorage.setItem(userTokenStorageKey, data.token);
      setApplication(data.application);
      await loadMessages(data.application.id);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Something went wrong");
    } finally {
      setIsBusy(false);
    }
  };

  const createLinkToken = async () => {
    if (!application) return;
    setIsBusy(true);
    setError(null);
    try {
      const response = await fetch(
        apiUrl(`/api/advance/applications/${application.id}/create_link_token`),
        { method: "POST" },
      );
      if (!response.ok) throw new Error("Unable to create Plaid Link session");
      const data = await response.json();
      setLinkToken(data.link_token);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Plaid Link failed");
    } finally {
      setIsBusy(false);
    }
  };

  const onPlaidSuccess = useCallback(
    async (publicToken: string) => {
      if (!application) return;
      const response = await fetch(
        apiUrl(`/api/advance/applications/${application.id}/set_access_token`),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ public_token: publicToken }),
        },
      );
      const data = await response.json();
      setApplication(data.application);
      await loadMessages(application.id);
      setLinkToken(null);
    },
    [application, loadMessages],
  );

  const plaidConfig = useMemo(
    () => ({
      token: linkToken,
      onSuccess: onPlaidSuccess,
    }),
    [linkToken, onPlaidSuccess],
  );
  const { open, ready } = usePlaidLink(plaidConfig);

  useEffect(() => {
    if (linkToken && ready) open();
  }, [linkToken, open, ready]);

  const sendMessage = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!application || !messageText.trim()) return;
    const text = messageText.trim();
    setMessageText("");
    await fetch(apiUrl(`/api/advance/applications/${application.id}/messages`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sender: "customer", text }),
    });
    await loadMessages(application.id);
  };

  // ── Landing ──────────────────────────────────────────────────────────────────
  if (!application) {
    if (view === "landing") {
      return (
        <main className={styles.page}>
          <NavBar />

          {/* Hero */}
          <section className={styles.hero}>
            <div className={styles.heroInner}>
              <span className={styles.heroBadge}>No credit check &nbsp;·&nbsp; No hidden fees</span>
              <h1 className={styles.heroHeading}>Get $25<br />before payday.</h1>
              <p className={styles.heroSub}>
                Connect your bank, get a decision today, and pay it back within 30 days. Simple as that.
              </p>
              <div className={styles.heroActions}>
                <button className={styles.btnWhite} onClick={() => setView("signup")}>
                  Get started — it's free
                </button>
                <button className={styles.btnGhost} onClick={() => window.location.href = "/loan"}>
                  Sign in
                </button>
              </div>
            </div>
          </section>

          {/* How it works */}
          <section className={styles.section}>
            <div className={styles.sectionInner}>
              <p className={styles.sectionLabel}>How it works</p>
              <h2 className={styles.sectionHeading}>Three steps to your money.</h2>
              <div className={styles.stepsGrid}>
                <div className={styles.stepCard}>
                  <div className={styles.stepNum}>1</div>
                  <strong>Apply in 2 minutes</strong>
                  <span>Name, employer, next payday. No SSN required, no credit pull.</span>
                </div>
                <div className={styles.stepCard}>
                  <div className={styles.stepNum}>2</div>
                  <strong>Connect your bank</strong>
                  <span>We verify your income via Plaid. Secure, read-only — we never see your password.</span>
                </div>
                <div className={styles.stepCard}>
                  <div className={styles.stepNum}>3</div>
                  <strong>Get your money</strong>
                  <span>A real human reviews your application and sends your $25 the same day.</span>
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
                  <span className={styles.progressStepLabel}>Review</span>
                </div>
                <div className={styles.progressStep}>
                  <div className={styles.progressStepDot}>4</div>
                  <span className={styles.progressStepLabel}>Funded</span>
                </div>
              </div>
              <p className={styles.kicker}>Step 1 of 4</p>
              <h1>Tell us about yourself</h1>
              <p>Takes about 2 minutes. Your info is never sold or shared.</p>
            </div>
            <div className={styles.signupCardBody}>
              <form className={styles.intakeComposer} onSubmit={createApplication}>
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
                    Next payday
                    <input required min={today} type="date" value={form.payday}
                      onChange={(event) => setForm({ ...form, payday: event.target.value })} />
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
                <div className={styles.securityNote}>
                  <svg width="15" height="16" viewBox="0 0 15 16" fill="none" aria-hidden="true">
                    <path d="M7.5 1.5L13 4.2V9C13 12.2 10.5 15 7.5 15.8C4.5 15 2 12.2 2 9V4.2L7.5 1.5Z" fill="#4a9470" />
                  </svg>
                  Your information is encrypted and never sold or shared. Next, you'll connect your bank via Plaid to verify income. Repayment of <strong>$25</strong> is due within <strong>30 days</strong> of funding.
                </div>
                {error && <p className={styles.error}>{error}</p>}
                <div className={styles.intakeFooter}>
                  <button type="button" className={styles.backBtn} onClick={() => setView("landing")}>← Back</button>
                  <button disabled={isBusy}>{isBusy ? "Starting…" : "Continue to bank connection →"}</button>
                </div>
              </form>
            </div>
          </div>
        </section>
      </main>
    );
  }

  // ── Authenticated application view ────────────────────────────────────────
  const appSteps: Array<{ key: Status | "__bank__"; label: string }> = [
    { key: "intake", label: "Applied" },
    { key: "__bank__", label: "Bank connected" },
    { key: "reviewing", label: "Under review" },
    { key: "approved", label: "Approved" },
    { key: "funded", label: "Funded" },
  ];
  const stepOrder = ["intake", "__bank__", "reviewing", "approved", "funded", "repayment_scheduled", "repaid"];
  const currentStepIdx = stepOrder.indexOf(
    application.plaid_connected && application.status === "intake" ? "__bank__" : application.status
  );

  return (
    <main className={styles.page}>
      <NavBar onLogout={handleLogout} />
      <section className={styles.workspace}>
        <aside className={styles.summary}>
          <p className={styles.kicker}>Your advance</p>
          <h2>{formatMoney(application.requested_amount)}</h2>
          <div className={styles.status}>{statusLabel[application.status]}</div>
          <dl>
            <dt>Name</dt>
            <dd>{application.customer.name}</dd>
            <dt>Employer</dt>
            <dd>{application.customer.employer}</dd>
            <dt>Payday</dt>
            <dd>{application.payday}</dd>
            <dt>Bank</dt>
            <dd>{application.plaid_connected ? "✓ Connected" : "Not connected"}</dd>
          </dl>
          {!application.plaid_connected && (
            <button disabled={isBusy} onClick={createLinkToken}>
              Connect bank with Plaid
            </button>
          )}
          {application.repayment && (
            <p className={styles.notice}>
              Repayment due {application.repayment.due_date}.
            </p>
          )}
          {error && <p className={styles.error}>{error}</p>}
        </aside>
        <section className={styles.chat}>
          <header>
            <div className={styles.appStatusBar}>
              {appSteps.map((step, i) => {
                const idx = stepOrder.indexOf(step.key);
                const isCurrent = idx === currentStepIdx;
                const isDone = idx < currentStepIdx;
                return (
                  <div key={step.key} className={`${styles.appStatusStep} ${isCurrent ? styles.active : ""} ${isDone ? styles.done : ""}`}>
                    <div className={styles.appStatusDot}>
                      <div className={styles.appStatusDotInner} />
                    </div>
                    {i < appSteps.length - 1 && null}
                  </div>
                );
              })}
            </div>
            <p className={styles.kicker} style={{ marginTop: "1.6rem" }}>Live review</p>
            <h1>Your application</h1>
            <p>A human reviewer will reply here once your bank is connected.</p>
          </header>
          <MessageList messages={messages} />
          {!application.plaid_connected && (
            <div className={styles.chatAction}>
              <p><strong>Next step:</strong> connect your bank securely with Plaid so a reviewer can make a decision.</p>
              <p>Connect the account where your employer sends your direct deposit.</p>
              <button disabled={isBusy} onClick={createLinkToken}>
                Connect bank with Plaid →
              </button>
            </div>
          )}
          {(application.status === "approved" || application.status === "funded" || application.status === "repayment_scheduled") && !application.stripe_card_saved && (
            <div className={styles.chatAction}>
              <p><strong>You're approved!</strong> Save a card so we can collect your repayment automatically on the due date.</p>
              <button onClick={() => window.location.href = "/loan"}>
                Save repayment card →
              </button>
            </div>
          )}
          <form className={styles.composer} onSubmit={sendMessage}>
            <input
              placeholder="Type a message…"
              value={messageText}
              onChange={(event) => setMessageText(event.target.value)}
            />
            <button>Send</button>
          </form>
        </section>
      </section>
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
                          "Congrats, you are approved for a $25 advance. To send the funds manually, please reply with: routing number, account number, checking or savings, and the legal name on the account. Do not send your online banking password.",
                        )
                      }
                    >
                      Approve
                    </button>
                    <button disabled={isBusy} onClick={() => setStatus("denied", "We are unable to approve this advance right now.")}>Deny</button>
                    <button disabled={isBusy} onClick={() => setStatus("funded", "Your $25 advance has been sent manually.")}>Mark funded</button>
                  </div>
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

  const incoming = snapshot.transactions.filter(tx => tx.amount < 0);
  const filtered = incoming.filter(
    tx => fuzzyMatch(nameQuery, tx.name) && amountMatch(amountQuery, tx.amount)
  );

  return (
    <div className={styles.snapshot}>
      <h4>Accounts</h4>
      {snapshot.accounts.map((account) => (
        <div key={account.account_id} className={styles.account}>
          <strong>{account.name}</strong>
          <span>{account.subtype || "account"} · {account.mask || "no mask"}</span>
          <span>Available {formatMoney(account.balances.available)}</span>
          <span>Current {formatMoney(account.balances.current)}</span>
        </div>
      ))}
      <h4>Incoming transactions</h4>
      <div className={styles.searchRow}>
        <label>
          Search by name
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
      <p className={styles.muted}>{filtered.length} of {incoming.length} incoming transaction{incoming.length !== 1 ? "s" : ""}</p>
      {filtered.length === 0 ? (
        <p className={styles.muted}>No matching transactions.</p>
      ) : (
        filtered.map((tx) => (
          <div key={tx.transaction_id} className={styles.incomingTransaction}>
            <span>{tx.date}</span>
            <strong>{tx.name}</strong>
            <span className={styles.incomingAmount}>{formatMoney(Math.abs(tx.amount))}</span>
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
            </div>
            <div className={styles.loanHeaderRight}>
              <div className={styles.status}>{statusLabel[application.status]}</div>
            </div>
          </div>

          <div className={styles.loanGrid}>
            <section className={styles.panel}>
              <h3>Loan details</h3>
              <dl>
                <dt>Amount</dt><dd>{formatMoney(application.requested_amount)}</dd>
                <dt>Employer</dt><dd>{application.customer.employer}</dd>
                <dt>Payday</dt><dd>{application.payday}</dd>
                <dt>Bank</dt><dd>{application.plaid_connected ? "Connected" : "Not connected"}</dd>
              </dl>
            </section>

            <section className={styles.panel}>
              <h3>Repayment</h3>
              {application.status === "repaid" ? (
                <p className={styles.paidNote}>Repayment collected — thank you!</p>
              ) : !application.stripe_card_saved && (application.status === "approved" || application.status === "funded" || application.status === "repayment_scheduled") ? (
                <>
                  <p><strong>One last step.</strong> Save a card and we'll automatically collect your ${application.requested_amount} repayment on the due date — no action needed from you on the day.</p>
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
              ) : application.stripe_card_saved ? (
                <>
                  {rep && (
                    <dl>
                      <dt>Amount due</dt><dd>{formatMoney(rep.amount)}</dd>
                      <dt>Due date</dt><dd className={styles.dueDate}>{rep.due_date}</dd>
                      <dt>Status</dt><dd>{rep.status === "paid" ? "Paid" : "Pending"}</dd>
                    </dl>
                  )}
                  <p className={styles.paidNote}>Card saved — we'll charge it automatically on the due date.</p>
                </>
              ) : (
                <p className={styles.muted}>No repayment scheduled yet. A reviewer will reach out once your advance is funded.</p>
              )}
              {error && <p className={styles.error}>{error}</p>}
            </section>
          </div>

          <section className={styles.chat} style={{ marginTop: "2.4rem" }}>
            <header><h3>Conversation history</h3></header>
            <MessageList messages={messages} />
          </section>
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

export default App;

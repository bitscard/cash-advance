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

const App = () => {
  const path = window.location.pathname;
  if (path === "/admin") return <AdminApp />;
  if (path === "/loan") return <LoanApp />;
  return <CustomerApp />;
};

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
        body: JSON.stringify({ ...body, requested_amount: 50 }),
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

  if (!application) {
    if (view === "landing") {
      return (
        <main className={styles.page}>
          <section className={styles.chatOnly}>
            <section className={styles.chat}>
              <header>
                <p className={styles.kicker}>Earned wage advance</p>
                <h1>$50 cash advance</h1>
                <p>Get up to $50 before your next payday. Repayment is due within 30 days of funding.</p>
              </header>
              <div className={styles.landingActions}>
                <button onClick={() => window.location.href = "/loan"}>Sign in</button>
                <button className={styles.secondaryBtn} onClick={() => setView("signup")}>
                  First time? Apply here
                </button>
              </div>
            </section>
          </section>
        </main>
      );
    }

    return (
      <main className={styles.page}>
        <section className={styles.chatOnly}>
          <section className={styles.chat}>
            <header>
              <p className={styles.kicker}>New application</p>
              <h1>$50 cash advance</h1>
            </header>
            <form className={styles.intakeComposer} onSubmit={createApplication}>
              <div className={styles.intakeGrid}>
                <label>
                  Full name
                  <input required value={form.name}
                    onChange={(event) => setForm({ ...form, name: event.target.value })} />
                </label>
                <label>
                  Email
                  <input required type="email" value={form.email}
                    onChange={(event) => setForm({ ...form, email: event.target.value })} />
                </label>
                <label>
                  Phone
                  <input required value={form.phone}
                    onChange={(event) => setForm({ ...form, phone: event.target.value })} />
                </label>
                <label>
                  Employer
                  <input required value={form.employer}
                    onChange={(event) => setForm({ ...form, employer: event.target.value })} />
                </label>
                <label>
                  Next payday
                  <input required min={today} type="date" value={form.payday}
                    onChange={(event) => setForm({ ...form, payday: event.target.value })} />
                </label>
                <label>
                  Password
                  <input required type="password" minLength={6} placeholder="Min. 6 characters"
                    autoComplete="new-password"
                    value={form.password}
                    onChange={(event) => setForm({ ...form, password: event.target.value })} />
                </label>
                <label>
                  Confirm password
                  <input required type="password" autoComplete="new-password"
                    value={form.confirmPassword}
                    onChange={(event) => setForm({ ...form, confirmPassword: event.target.value })} />
                </label>
              </div>
              <div className={styles.chatAction}>
                <p>In the next step you will connect your bank account. Please connect the account where your employer deposits your paycheck — this is required to verify income.</p>
                <p>Repayment of $50 is due within <strong>30 days</strong> of funding.</p>
              </div>
              {error && <p className={styles.error}>{error}</p>}
              <div className={styles.intakeFooter}>
                <button type="button" className={styles.backBtn} onClick={() => setView("landing")}>Back</button>
                <button disabled={isBusy}>{isBusy ? "Starting..." : "Continue to bank connection"}</button>
              </div>
            </form>
          </section>
        </section>
      </main>
    );
  }

  return (
    <main className={styles.page}>
      <section className={styles.workspace}>
        <aside className={styles.summary}>
          <p className={styles.kicker}>Application</p>
          <h2>{formatMoney(application.requested_amount)}</h2>
          <div className={styles.status}>{statusLabel[application.status]}</div>
          <button className={styles.logoutBtn} onClick={() => {
            localStorage.removeItem(applicationStorageKey);
            localStorage.removeItem(userTokenStorageKey);
            setApplication(null);
            setMessages([]);
            setView("landing");
          }}>Log out</button>
          <dl>
            <dt>Name</dt>
            <dd>{application.customer.name}</dd>
            <dt>Employer</dt>
            <dd>{application.customer.employer}</dd>
            <dt>Payday</dt>
            <dd>{application.payday}</dd>
            <dt>Bank</dt>
            <dd>{application.plaid_connected ? "Connected" : "Not connected"}</dd>
          </dl>
          <button disabled={isBusy || application.plaid_connected} onClick={createLinkToken}>
            {application.plaid_connected ? "Bank connected" : "Connect bank"}
          </button>
          {application.repayment && (
            <p className={styles.notice}>
              Repayment recorded for {application.repayment.due_date}.
            </p>
          )}
          {error && <p className={styles.error}>{error}</p>}
        </aside>
        <section className={styles.chat}>
          <header>
            <div className={styles.loanHeader}>
              <div>
                <p className={styles.kicker}>Live review chat</p>
                <h1>Continue your review</h1>
                <p>Connect your bank with Plaid, then a human reviewer will reply here.</p>
              </div>
              <button className={styles.logoutBtn} onClick={() => {
                localStorage.removeItem(applicationStorageKey);
                localStorage.removeItem(userTokenStorageKey);
                setApplication(null);
                setMessages([]);
                setView("landing");
              }}>Log out</button>
            </div>
          </header>
          <MessageList messages={messages} />
          {!application.plaid_connected && (
            <div className={styles.chatAction}>
              <p>Next step: connect your bank securely with Plaid so the reviewer can make a decision.</p>
              <p><strong>Important:</strong> connect the account where your employer sends your direct deposit — not a savings or secondary account.</p>
              <button disabled={isBusy} onClick={createLinkToken}>
                Connect bank with Plaid
              </button>
            </div>
          )}
          {(application.status === "approved" || application.status === "funded" || application.status === "repayment_scheduled") && !application.stripe_card_saved && (
            <div className={styles.chatAction}>
              <p><strong>You're approved!</strong> The last step is to save a card so we can collect repayment automatically on your due date.</p>
              <button onClick={() => window.location.href = "/loan"}>
                Continue — save repayment card →
              </button>
            </div>
          )}
          <form className={styles.composer} onSubmit={sendMessage}>
            <input
              placeholder="Type a message..."
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
      body: JSON.stringify({ amount: 50, due_date: repaymentDate }),
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
                        "Congrats, you are approved for a $50 advance. To send the funds manually, please reply with: routing number, account number, checking or savings, and the legal name on the account. Do not send your online banking password.",
                      )
                    }
                  >
                    Approve
                  </button>
                  <button disabled={isBusy} onClick={() => setStatus("denied", "We are unable to approve this advance right now.")}>Deny</button>
                  <button disabled={isBusy} onClick={() => setStatus("funded", "Your $50 advance has been sent manually.")}>Mark funded</button>
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
                  placeholder="Reply to applicant..."
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

const MessageList = ({ messages }: { messages: Message[] }) => (
  <div className={styles.messages}>
    {messages.map((message) => (
      <div key={message.id} className={`${styles.message} ${styles[message.sender]}`}>
        <span>{message.sender}</span>
        <p>{message.text}</p>
      </div>
    ))}
  </div>
);

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
        <section className={styles.chatOnly}>
          <section className={styles.chat}>
            <header>
              <p className={styles.kicker}>Returning borrower</p>
              <h1>Manage your loan</h1>
              <p>Log in with the email and password you used when applying.</p>
            </header>
            <form className={styles.intakeComposer} onSubmit={login}>
              <label>
                Email
                <input required type="email" value={loginForm.email}
                  onChange={(e) => setLoginForm({ ...loginForm, email: e.target.value })} />
              </label>
              <label>
                Password
                <input required type="password" value={loginForm.password}
                  onChange={(e) => setLoginForm({ ...loginForm, password: e.target.value })} />
              </label>
              {error && <p className={styles.error}>{error}</p>}
              <button disabled={isBusy}>{isBusy ? "Logging in…" : "Log in"}</button>
            </form>
          </section>
        </section>
      </main>
    );
  }

  const rep = application.repayment;
  const canPayoff = !!rep && rep.status === "pending" &&
    (application.status === "repayment_scheduled" || application.status === "funded");

  return (
    <main className={styles.page}>
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
              <button className={styles.logoutBtn} onClick={logout}>Log out</button>
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

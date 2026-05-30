'use strict';

// Maps Stripe Financial Connections transaction objects to Plaid-shape so
// the existing income classification pipeline (classifyTransaction,
// isExcludedByPFC, buildRefundSet) can consume them unchanged.
//
// Why a shim? The classifier expects:
//   - personal_finance_category.primary + .detailed (Plaid PFC taxonomy)
//   - merchant_name (normalized)
//   - amount (positive = outflow in Plaid convention)
//   - date (YYYY-MM-DD)
//   - transaction_id
//   - description / name
//
// Stripe FC provides:
//   - description (raw merchant string, not normalized)
//   - amount (Stripe convention: negative = outflow on the user's bank)
//   - transacted_at (unix timestamp)
//   - id
//   - status
//   - currency
//
// The mapping is best-effort. Income classification will skew slightly
// differently than with Plaid — the layer-3 AI fallback picks up the slack
// for ambiguous transactions where merchant categorization differs.

// Stripe FC doesn't expose MCC on transaction objects directly. We infer
// rough PFC categories from description keywords. Anything we can't infer
// confidently goes to PRIMARY=GENERAL_MERCHANDISE which the classifier
// treats as ambiguous (falls through to layer 3 AI).

const KEYWORD_PFC_PRIMARY = [
  // Income — keep tight so we don't false-positive expenses as income
  { pattern: /payroll|direct dep|paycheck|wages|salary|adp|gusto|paychex/i, primary: 'INCOME', detailed: 'INCOME_WAGES' },
  { pattern: /social security|ssa treas|ssi/i, primary: 'INCOME', detailed: 'INCOME_OTHER_INCOME' },
  { pattern: /va benefits|veterans|treas vacp/i, primary: 'INCOME', detailed: 'INCOME_OTHER_INCOME' },
  { pattern: /tax refund|irs treas|irs deposit/i, primary: 'INCOME', detailed: 'INCOME_TAX_REFUND' },
  // Transfers (excluded from income)
  { pattern: /zelle|venmo|cash app|paypal|transfer/i, primary: 'TRANSFER_IN', detailed: 'TRANSFER_IN_OTHER' },
  // Bank
  { pattern: /atm|withdraw/i, primary: 'BANK_FEES', detailed: 'BANK_FEES_ATM_FEES' },
  { pattern: /overdraft|nsf fee/i, primary: 'BANK_FEES', detailed: 'BANK_FEES_OVERDRAFT_FEES' },
  // Loans / advances (excluded — could mask as income)
  { pattern: /loan|advance|cash advance|payday/i, primary: 'LOAN_PAYMENTS', detailed: 'LOAN_PAYMENTS_OTHER_PAYMENT' },
];

function inferPfcCategory(description) {
  const desc = (description || '').toString();
  for (const rule of KEYWORD_PFC_PRIMARY) {
    if (rule.pattern.test(desc)) {
      return { primary: rule.primary, detailed: rule.detailed };
    }
  }
  // Default: generic merchandise — classifier treats as ambiguous,
  // layer 3 AI will categorize.
  return { primary: 'GENERAL_MERCHANDISE', detailed: 'GENERAL_MERCHANDISE_OTHER_GENERAL_MERCHANDISE' };
}

// Strip noise from raw bank descriptions to approximate Plaid's
// `merchant_name`. Plaid does sophisticated entity resolution; we do
// best-effort: drop trailing references, numbers, and common boilerplate.
function inferMerchantName(description) {
  if (!description) return null;
  let s = description.toString().trim();
  // Drop trailing reference numbers (8+ digits or alphanumeric tokens)
  s = s.replace(/\s+[a-z0-9]{8,}\s*$/i, '');
  // Drop common boilerplate
  s = s.replace(/\s*(pos|debit card purchase|ach debit|ach credit|deposit)\s*/gi, ' ');
  // Drop city/state-looking tokens
  s = s.replace(/\s+[a-z]{2,}\s+[a-z]{2}\s*$/i, '');
  // Collapse whitespace
  s = s.replace(/\s+/g, ' ').trim();
  return s || null;
}

// Plaid amount convention: positive = money out, negative = money in.
// Stripe FC amount convention: matches the bank's perspective —
// negative = outflow, positive = inflow. We flip the sign here so the
// existing classifier's expectations are met.
function plaidAmountFromFc(fcAmountCents) {
  if (typeof fcAmountCents !== 'number') return 0;
  return -(fcAmountCents / 100);
}

function fcDateToYmd(transactedAt) {
  if (!transactedAt) return null;
  // FC may return unix seconds or ISO strings depending on API version.
  if (typeof transactedAt === 'number') {
    return new Date(transactedAt * 1000).toISOString().slice(0, 10);
  }
  if (typeof transactedAt === 'string') {
    return transactedAt.slice(0, 10);
  }
  return null;
}

function adaptFcTransaction(fcTx) {
  const description = fcTx.description || '';
  const merchant_name = inferMerchantName(description);
  const pfc = inferPfcCategory(description);
  return {
    transaction_id: fcTx.id,
    name: description,
    merchant_name,
    description,
    amount: plaidAmountFromFc(fcTx.amount),
    date: fcDateToYmd(fcTx.transacted_at || fcTx.created),
    iso_currency_code: (fcTx.currency || 'usd').toUpperCase(),
    pending: fcTx.status === 'pending',
    personal_finance_category: pfc,
    // Plaid's deprecated `category` array — leave empty so classifier
    // uses PFC path instead.
    category: [],
  };
}

function adaptFcTransactions(fcTransactions) {
  if (!Array.isArray(fcTransactions)) return [];
  return fcTransactions.map(adaptFcTransaction);
}

module.exports = {
  adaptFcTransaction,
  adaptFcTransactions,
  inferMerchantName,
  inferPfcCategory,
  plaidAmountFromFc,
};

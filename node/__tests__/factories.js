// Factories for backend integration tests. Each returns a plain object
// that matches the shape db.createApplication expects. Tests can spread
// overrides on top: `await db.createApplication(makeApplication({ state: 'Texas' }))`.

const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');

let counter = 0;
const next = () => ++counter;

function makeApplication(overrides = {}) {
  const n = next();
  return {
    name: `Test User ${n}`,
    email: `test${n}-${Date.now()}@example.com`,
    phone: '+15555550100',
    employer: 'Acme Corp',
    payday: '2026-06-15',
    requested_amount: 25,
    password_hash: bcrypt.hashSync('test-password', 4),
    ssn: '111223333',
    pay_frequency: 'biweekly',
    state: 'Georgia',
    dob: '1990-01-01',
    referral_code: `testuser${n}`,
    referred_by: null,
    ...overrides,
  };
}

function makeIncomeSource(overrides = {}) {
  return {
    employer: 'Acme Corp',
    payday: '2026-06-15',
    pay_frequency: 'biweekly',
    ...overrides,
  };
}

function makeIncomeSources(count, overrides = {}) {
  return Array.from({ length: count }, () => makeIncomeSource(overrides));
}

// Plaid transaction shape used by the income classifier. Plaid returns
// `amount` as positive=debit; our code converts to positive=credit/income.
function makePlaidTransaction(overrides = {}) {
  return {
    transaction_id: `tx_${uuidv4()}`,
    name: 'ACME PAYROLL DIRECT DEP',
    merchant_name: 'Acme Corp',
    amount: -2000, // Plaid convention: negative = money in
    iso_currency_code: 'USD',
    date: '2026-05-15',
    category: ['Transfer', 'Payroll'],
    personal_finance_category: { primary: 'INCOME_WAGES' },
    ...overrides,
  };
}

// Pre-shaped internal transaction (after the mapping done in
// bank_snapshot). Use for unit tests that test downstream functions
// like findPaychecksByPattern, buildRefundSet, etc.
function makeIncomeTx(overrides = {}) {
  return {
    id: `tx_${uuidv4()}`,
    description: 'ACME PAYROLL',
    amount: 200000, // cents, positive = income
    currency: 'usd',
    date: '2026-05-15',
    category: 'Transfer, Payroll',
    pfc: 'INCOME_WAGES',
    ...overrides,
  };
}

module.exports = {
  makeApplication,
  makeIncomeSource,
  makeIncomeSources,
  makePlaidTransaction,
  makeIncomeTx,
};

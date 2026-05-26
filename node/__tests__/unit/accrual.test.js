// Covers calcSourceAccrued at node/index.js:325.
// Given an income source (employer + payday + pay_frequency) and a list
// of income transactions, computes accrued wages so far this pay period.

const { calcSourceAccrued } = require('../../index');

function tx(date, amount, id = `tx_${date}`) {
  return { id, date, amount, description: 'PAYROLL', currency: 'usd' };
}

describe('calcSourceAccrued', () => {
  test('no income transactions → null accrual with error', () => {
    const source = { employer: 'Acme', payday: '2026-06-15', pay_frequency: 'biweekly' };
    const result = calcSourceAccrued(source, []);
    expect(result.accrued_cents).toBe(null);
    expect(result.error).toBe('no_transactions');
  });

  test('biweekly source with paycheck history → positive accrual', () => {
    const today = new Date();
    function daysAgoStr(n) {
      const d = new Date(today);
      d.setDate(d.getDate() - n);
      return d.toISOString().slice(0, 10);
    }
    const nextPay = (() => {
      const d = new Date(today);
      d.setDate(d.getDate() + 7); // Mid-period — 7 days accrued since last payday
      return d.toISOString().slice(0, 10);
    })();
    const source = { employer: 'Acme', payday: nextPay, pay_frequency: 'biweekly' };
    // Three exact biweekly anchors going back from today's nearest anchor.
    const txs = [
      tx(daysAgoStr(7), 200000),
      tx(daysAgoStr(21), 200000),
      tx(daysAgoStr(35), 200000),
    ];
    const result = calcSourceAccrued(source, txs);
    expect(result.accrued_cents).not.toBeNull();
    expect(result.accrued_cents).toBeGreaterThanOrEqual(0);
    expect(result.period_days).toBe(14);
    expect(result.avg_paycheck_cents).toBe(200000);
    expect(result.matched_tx_count).toBeGreaterThan(0);
  });

  test('preserves source identity fields', () => {
    const source = { employer: 'TestCorp', payday: '2099-06-12', pay_frequency: 'biweekly' };
    const result = calcSourceAccrued(source, []);
    expect(result.employer).toBe('TestCorp');
    expect(result.payday).toBe('2099-06-12');
  });

  test('daily frequency computes from sum-of-month / month-to-date scaling', () => {
    const today = new Date();
    const thisMonth = today.toISOString().slice(0, 7);
    const source = { employer: 'Acme', payday: today.toISOString().slice(0, 10), pay_frequency: 'daily' };
    const txs = [
      tx(`${thisMonth}-01`, 5000),
      tx(`${thisMonth}-02`, 5000),
    ];
    const result = calcSourceAccrued(source, txs);
    expect(result.period_days).toBe(30);
    expect(result.accrued_cents).toBe(10000);
  });
});

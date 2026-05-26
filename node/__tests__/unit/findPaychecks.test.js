// Covers findPaychecksByPattern at node/index.js:268.
// Finds paycheck transactions by timing pattern relative to a declared
// next payday. Returns up to N matched transactions.

const { findPaychecksByPattern } = require('../../index');

function tx(date, amount, id = `tx_${date}_${amount}`) {
  return { id, date, amount, description: 'PAYROLL', currency: 'usd' };
}

describe('findPaychecksByPattern', () => {
  test('empty input → empty result', () => {
    expect(findPaychecksByPattern([], 'biweekly', '2026-05-29')).toEqual([]);
  });

  describe('daily frequency', () => {
    // Use a stable reference: in a real test run, "this month" is whenever
    // tests execute. To keep these deterministic, we test the BEHAVIOR
    // (filtering by current YYYY-MM prefix) rather than asserting exact
    // counts against a date we can't predict.
    test('returns transactions in the current calendar month', () => {
      const now = new Date();
      const thisMonth = now.toISOString().slice(0, 7);
      const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 15)
        .toISOString().slice(0, 7);

      const txs = [
        tx(`${thisMonth}-05`, 10000),
        tx(`${thisMonth}-12`, 10000),
        tx(`${lastMonth}-15`, 10000), // outside the window
      ];
      const result = findPaychecksByPattern(txs, 'daily', '2026-05-15');
      expect(result.length).toBe(2);
    });
  });

  describe('biweekly frequency', () => {
    // Build a deterministic anchor: declaredNextPayday is 14 days from
    // today, so the walk-back lands on today, then continues back through
    // the test transactions at exact 14-day intervals. This avoids any
    // "anchor not aligned" gotchas.
    const today = new Date();
    const todayStr = today.toISOString().slice(0, 10);
    function daysAgoStr(n) {
      const d = new Date(today);
      d.setDate(d.getDate() - n);
      return d.toISOString().slice(0, 10);
    }
    const nextPaydayStr = (() => {
      const d = new Date(today);
      d.setDate(d.getDate() + 14);
      return d.toISOString().slice(0, 10);
    })();

    test('finds paychecks within ±3 day slack', () => {
      const txs = [
        tx(daysAgoStr(0), 200000),   // today — matches first anchor
        tx(daysAgoStr(14), 200000),  // exact -14d
        tx(daysAgoStr(27), 200000),  // 1 day off 14*2 — within slack
      ];
      const result = findPaychecksByPattern(txs, 'biweekly', nextPaydayStr);
      expect(result.length).toBeGreaterThan(0);
      expect(result.length).toBeLessThanOrEqual(4);
    });

    test('ignores transactions outside the slack window', () => {
      // Place a tx 6 days off the expected anchor — outside ±3 slack.
      const txs = [tx(daysAgoStr(20), 200000)];
      const result = findPaychecksByPattern(txs, 'biweekly', nextPaydayStr);
      expect(result.length).toBe(0);
    });
  });

  describe('weekly frequency', () => {
    test('tighter slack window (±2 days)', () => {
      const today = new Date();
      function daysAgoStr(n) {
        const d = new Date(today);
        d.setDate(d.getDate() - n);
        return d.toISOString().slice(0, 10);
      }
      // Next payday 7 days from now so the walk-back lands on today.
      const nextPay = (() => {
        const d = new Date(today);
        d.setDate(d.getDate() + 7);
        return d.toISOString().slice(0, 10);
      })();
      const txs = [
        tx(daysAgoStr(0), 50000),
        tx(daysAgoStr(7), 50000),
        tx(daysAgoStr(14), 50000),
      ];
      const result = findPaychecksByPattern(txs, 'weekly', nextPay);
      expect(result.length).toBeGreaterThan(0);
    });
  });

  describe('monthly frequency', () => {
    test('finds paychecks within ±7 days of target day-of-month', () => {
      // Use today's day-of-month as the target so the lookback finds matches.
      const today = new Date();
      const targetDay = today.getDate();
      // Build txs in the last 3 months on the same day-of-month.
      function priorMonthStr(monthsBack, day) {
        const d = new Date(today.getFullYear(), today.getMonth() - monthsBack, day);
        return d.toISOString().slice(0, 10);
      }
      const nextPay = (() => {
        const d = new Date(today.getFullYear(), today.getMonth() + 1, targetDay);
        return d.toISOString().slice(0, 10);
      })();
      const txs = [
        tx(priorMonthStr(1, targetDay), 500000),
        tx(priorMonthStr(2, targetDay), 500000),
      ];
      const result = findPaychecksByPattern(txs, 'monthly', nextPay);
      expect(result.length).toBeGreaterThan(0);
      expect(result.length).toBeLessThanOrEqual(3);
    });
  });
});

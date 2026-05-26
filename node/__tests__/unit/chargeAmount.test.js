// Covers computeChargeAmountCents at node/index.js (Stripe section).
// This is the function added in commit 5d49f24 — the bug it fixed:
// admin clicks "Collect repayment" before status hits funded, so
// repayment_amount is null, and the OLD code charged just requested_amount
// (=$25), silently dropping the $5 instant fee. This is the highest-value
// regression to lock down.

const { computeChargeAmountCents } = require('../../index');

describe('computeChargeAmountCents', () => {
  describe('when repayment_amount is set', () => {
    test('uses it verbatim, in cents', () => {
      expect(computeChargeAmountCents({ repayment_amount: 30, requested_amount: 25, delivery_type: 'instant' })).toBe(3000);
    });

    test('respects custom admin-set amounts', () => {
      // Admin may manually set a custom repayment via /admin/repayment.
      // computeChargeAmountCents must trust the stored value even if it's
      // weird relative to delivery_type.
      expect(computeChargeAmountCents({ repayment_amount: 17.5, requested_amount: 25, delivery_type: 'instant' })).toBe(1750);
    });

    test('handles decimal repayment_amount correctly', () => {
      expect(computeChargeAmountCents({ repayment_amount: 25.99, requested_amount: 25 })).toBe(2599);
    });

    test('handles repayment_amount as string (Postgres NUMERIC comes back as string)', () => {
      // pg's `pg` driver returns DECIMAL columns as strings by default.
      // parseFloat must handle that without dropping the cents.
      expect(computeChargeAmountCents({ repayment_amount: '30.00', requested_amount: '25' })).toBe(3000);
    });
  });

  describe('regression for 5d49f24 — when repayment_amount is NULL', () => {
    test('instant delivery still gets the $5 fee added → $30', () => {
      expect(
        computeChargeAmountCents({
          repayment_amount: null,
          requested_amount: 25,
          delivery_type: 'instant',
        })
      ).toBe(3000);
    });

    test('standard delivery has no fee → $25', () => {
      expect(
        computeChargeAmountCents({
          repayment_amount: null,
          requested_amount: 25,
          delivery_type: 'standard',
        })
      ).toBe(2500);
    });

    test('null delivery_type (admin charges before user picks) → no fee', () => {
      expect(
        computeChargeAmountCents({
          repayment_amount: null,
          requested_amount: 25,
          delivery_type: null,
        })
      ).toBe(2500);
    });

    test('different requested amounts respect the tier ladder', () => {
      expect(
        computeChargeAmountCents({ repayment_amount: null, requested_amount: 50, delivery_type: 'instant' })
      ).toBe(5500);
      expect(
        computeChargeAmountCents({ repayment_amount: null, requested_amount: 200, delivery_type: 'standard' })
      ).toBe(20000);
    });
  });

  describe('defensive defaults', () => {
    test('missing requested_amount falls back to $25', () => {
      expect(
        computeChargeAmountCents({ repayment_amount: null, delivery_type: 'standard' })
      ).toBe(2500);
    });

    test('missing requested_amount + instant → $30', () => {
      expect(
        computeChargeAmountCents({ repayment_amount: null, delivery_type: 'instant' })
      ).toBe(3000);
    });
  });
});

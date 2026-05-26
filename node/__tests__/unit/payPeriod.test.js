// Covers payPeriodDays at node/index.js:255.
const { payPeriodDays } = require('../../index');

describe('payPeriodDays', () => {
  test.each([
    ['weekly', 7],
    ['biweekly', 14],
    ['semimonthly', 15],
    ['monthly', 30],
    ['daily', 1],
  ])('%s → %d days', (input, expected) => {
    expect(payPeriodDays(input)).toBe(expected);
  });

  test('case insensitive', () => {
    expect(payPeriodDays('WEEKLY')).toBe(7);
    expect(payPeriodDays('Weekly')).toBe(7);
    expect(payPeriodDays('BiWeekly')).toBe(14);
  });

  test('null / undefined → default 14', () => {
    expect(payPeriodDays(null)).toBe(14);
    expect(payPeriodDays(undefined)).toBe(14);
  });

  test('empty string → default 14', () => {
    expect(payPeriodDays('')).toBe(14);
  });

  test('unknown frequency → default 14', () => {
    expect(payPeriodDays('quarterly')).toBe(14);
    expect(payPeriodDays('bimonthly')).toBe(14);
    expect(payPeriodDays('random-garbage-xyz')).toBe(14);
  });
});

// Covers the SSN plausibility check at node/index.js:33.
// `isPlausibleSSN` enforces SSA rules; we test every branch.

const { isPlausibleSSN } = require('../../index');

describe('isPlausibleSSN', () => {
  describe('rejects invalid area codes', () => {
    test.each([
      ['000234567', '000 area'],
      ['666234567', '666 area'],
      ['900234567', '900 area (ITIN-style)'],
      ['950234567', '950 area'],
      ['999234567', '999 area'],
    ])('%s — %s', (ssn) => {
      expect(isPlausibleSSN(ssn)).toBe(false);
    });

    test.each([
      ['001234567', '001 area (lowest valid)'],
      ['665234567', '665 area (just below 666)'],
      ['667234567', '667 area (just above 666)'],
      ['899234567', '899 area (just below 900)'],
    ])('%s — %s should be plausible', (ssn) => {
      expect(isPlausibleSSN(ssn)).toBe(true);
    });
  });

  describe('rejects invalid group/serial', () => {
    test('group of 00', () => {
      expect(isPlausibleSSN('123001234')).toBe(false);
    });
    test('serial of 0000', () => {
      expect(isPlausibleSSN('123450000')).toBe(false);
    });
    test('valid group + serial', () => {
      expect(isPlausibleSSN('123012345')).toBe(true);
    });
  });

  describe('rejects known advertised fakes', () => {
    test.each([
      ['078051120'],
      ['219099999'],
      ['123456789'],
    ])('%s', (ssn) => {
      expect(isPlausibleSSN(ssn)).toBe(false);
    });
  });

  describe('rejects all-same-digit', () => {
    test.each([
      ['000000000'],
      ['111111111'],
      ['999999999'],
    ])('%s', (ssn) => {
      expect(isPlausibleSSN(ssn)).toBe(false);
    });
  });

  test('does not consider a plausible SSN equal to a fake', () => {
    // Sanity guard against accidental too-broad regex
    expect(isPlausibleSSN('111223334')).toBe(true);
  });
});

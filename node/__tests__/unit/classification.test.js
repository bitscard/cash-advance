// Covers the income classification helpers in node/index.js:
//   - isExcludedByPFC (PFC code blocklist)
//   - isExcludedByKeyword (description keyword blocklist)
//   - classifyTransaction (the orchestrator)
//
// classifyTransaction falls through to an AI call for ambiguous cases.
// We mock the Anthropic client at the module-level to keep tests offline.

jest.mock('@anthropic-ai/sdk', () => {
  // Default mock returns "uncertain". Individual tests override via
  // mockMessageResolved below.
  const messages = { create: jest.fn().mockResolvedValue({ content: [{ text: 'uncertain' }] }) };
  return jest.fn().mockImplementation(() => ({ messages }));
});

const { isExcludedByPFC, isExcludedByKeyword, classifyTransaction } = require('../../index');

describe('isExcludedByPFC', () => {
  test.each([
    'INCOME_RETIREMENT_PENSION',
    'INCOME_DIVIDENDS',
    'INCOME_SOCIAL_SECURITY',
    'INCOME_UNEMPLOYMENT_BENEFITS',
    'INCOME_TAX_REFUND',
    'GOVERNMENT_BENEFITS',
    'TRANSFER_IN_INVESTMENT_AND_RETIREMENT_FUNDS',
    'TRANSFER_IN_OTHER_TRANSFER_IN',
  ])('excludes %s', (pfc) => {
    expect(isExcludedByPFC(pfc)).toBe(true);
  });

  test('does not exclude INCOME_WAGES', () => {
    expect(isExcludedByPFC('INCOME_WAGES')).toBe(false);
  });

  test('handles null / undefined / empty (falsy, not strictly false)', () => {
    // Implementation uses short-circuit `pfc && EXCLUDED_PFC.has(pfc)` so
    // null in → null out. Just confirm it's not truthy.
    expect(isExcludedByPFC(null)).toBeFalsy();
    expect(isExcludedByPFC(undefined)).toBeFalsy();
    expect(isExcludedByPFC('')).toBeFalsy();
  });

  test('case-sensitive (Plaid codes are uppercase)', () => {
    expect(isExcludedByPFC('income_wages')).toBe(false);
  });
});

describe('isExcludedByKeyword', () => {
  test.each([
    ['SOCIAL SECURITY DEPOSIT'],
    ['SSA TREAS 310 XXSOC SEC'],
    ['IRS TREAS 310 TAX REF'],
    ['UNEMPLOYMENT BENEFIT PMT'],
    ['VA COMP DISABILITY PMT'],
    ['FIDELITY INVESTMENT TRANSFER'],
    ['401K DISTRIBUTION'],
    ['CHILD SUPPORT PAYMENT'],
    ['AMAZON REFUND'],
    ['MERCHANDISE CREDIT'],
  ])('excludes %s', (desc) => {
    expect(isExcludedByKeyword(desc)).toBe(true);
  });

  test('does not exclude normal payroll deposits', () => {
    expect(isExcludedByKeyword('ACME CORP PAYROLL DD')).toBe(false);
    expect(isExcludedByKeyword('STARBUCKS PAYROLL')).toBe(false);
    expect(isExcludedByKeyword('ADP WAGES')).toBe(false);
  });

  test('case-insensitive', () => {
    expect(isExcludedByKeyword('social security')).toBe(true);
    expect(isExcludedByKeyword('Social Security')).toBe(true);
    expect(isExcludedByKeyword('SOCIAL SECURITY')).toBe(true);
  });

  test('respects word boundaries', () => {
    // "security" alone shouldn't match — only " social security " patterns.
    // This is bounded with whitespace in the implementation.
    expect(isExcludedByKeyword('SECURITY GUARD COMPANY')).toBe(false);
  });
});

describe('classifyTransaction', () => {
  test('refund flag short-circuits to excluded', async () => {
    const result = await classifyTransaction('Some Description', 'Cat', 'INCOME_WAGES', true);
    expect(result).toEqual({ status: 'excluded', reason: 'refund', ai_classified: false });
  });

  test('PFC exclusion short-circuits before keyword check', async () => {
    const result = await classifyTransaction('any', 'any', 'INCOME_DIVIDENDS', false);
    expect(result).toEqual({ status: 'excluded', reason: 'pfc', ai_classified: false });
  });

  test('keyword exclusion fires after PFC', async () => {
    const result = await classifyTransaction(
      'SSA TREAS 310 XXSOC SEC',
      'Transfer',
      null,
      false
    );
    expect(result).toEqual({ status: 'excluded', reason: 'keyword', ai_classified: false });
  });

  test('INCOME_WAGES PFC short-circuits to wage_income', async () => {
    const result = await classifyTransaction(
      'MYSTERY EMPLOYER',
      'Transfer',
      'INCOME_WAGES',
      false
    );
    expect(result).toEqual({ status: 'wage_income', reason: 'pfc', ai_classified: false });
  });

  test('ambiguous transaction falls through to AI fallback', async () => {
    const result = await classifyTransaction(
      'AMBIGUOUS PAYMENT 12345',
      'Transfer',
      'TRANSFER_IN_DEPOSIT',
      false
    );
    // Default mock returns 'uncertain'
    expect(result.ai_classified).toBe(true);
    expect(['wage_income', 'excluded', 'uncertain']).toContain(result.status);
  });
});

// Covers getOfferExpiresAt + STATE_TIMEZONES at node/index.js (~line 555).
// Returns the UTC instant of 23:59:59.999 on `date` in the state's TZ.

const { getOfferExpiresAt, STATE_TIMEZONES } = require('../../index');

// Helper: pick a non-DST date so the math is deterministic. Mid-January
// every state in continental US is on standard time.
const JAN_15 = new Date('2026-01-15T18:00:00Z');

describe('STATE_TIMEZONES coverage', () => {
  test('every eligible state has a timezone', () => {
    const eligibleStates = require('../../index').ELIGIBLE_STATES;
    for (const state of eligibleStates) {
      expect(STATE_TIMEZONES[state]).toBeDefined();
    }
  });
});

describe('getOfferExpiresAt', () => {
  test('returns a Date object', () => {
    const result = getOfferExpiresAt(JAN_15, 'Georgia');
    expect(result).toBeInstanceOf(Date);
    expect(Number.isNaN(result.getTime())).toBe(false);
  });

  test('Eastern Time states (EST, UTC-5 in January)', () => {
    // 23:59:59.999 EST = 04:59:59.999 UTC the NEXT day.
    const result = getOfferExpiresAt(JAN_15, 'Georgia');
    expect(result.toISOString()).toBe('2026-01-16T04:59:59.999Z');
  });

  test('Central Time states (CST, UTC-6 in January)', () => {
    // 23:59:59.999 CST = 05:59:59.999 UTC the NEXT day.
    const result = getOfferExpiresAt(JAN_15, 'Texas');
    expect(result.toISOString()).toBe('2026-01-16T05:59:59.999Z');
  });

  test('Mountain Time states (MST, UTC-7 in January)', () => {
    const result = getOfferExpiresAt(JAN_15, 'Colorado');
    expect(result.toISOString()).toBe('2026-01-16T06:59:59.999Z');
  });

  test('Pacific Time states (PST, UTC-8 in January)', () => {
    const result = getOfferExpiresAt(JAN_15, 'Washington');
    expect(result.toISOString()).toBe('2026-01-16T07:59:59.999Z');
  });

  test('Arizona stays on MST even in summer (no DST)', () => {
    const julyDate = new Date('2026-07-15T18:00:00Z');
    // Arizona is MST year-round (UTC-7). 23:59:59 AZ = 06:59:59 UTC next day.
    const result = getOfferExpiresAt(julyDate, 'Arizona');
    expect(result.toISOString()).toBe('2026-07-16T06:59:59.999Z');
  });

  test('Hawaii (HST, UTC-10)', () => {
    const result = getOfferExpiresAt(JAN_15, 'Hawaii');
    expect(result.toISOString()).toBe('2026-01-16T09:59:59.999Z');
  });

  test('Alaska (AKST, UTC-9 in January)', () => {
    const result = getOfferExpiresAt(JAN_15, 'Alaska');
    expect(result.toISOString()).toBe('2026-01-16T08:59:59.999Z');
  });

  test('unknown state falls back to Eastern Time', () => {
    const result = getOfferExpiresAt(JAN_15, 'California'); // not eligible
    expect(result.toISOString()).toBe('2026-01-16T04:59:59.999Z');
  });

  test('handles DST transitions correctly (spring forward)', () => {
    // 2026-03-08 is the second Sunday of March — DST starts at 2am.
    // After 03-08, ET goes from UTC-5 (EST) to UTC-4 (EDT).
    // Offer expiring on 03-09 should be in EDT.
    const after = new Date('2026-03-10T12:00:00Z');
    const result = getOfferExpiresAt(after, 'Georgia');
    // 23:59:59.999 EDT on 03-10 = 03:59:59.999 UTC on 03-11
    expect(result.toISOString()).toBe('2026-03-11T03:59:59.999Z');
  });
});

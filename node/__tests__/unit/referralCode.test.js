// Covers generateReferralSlug at node/index.js:51 (pure) and
// makeUniqueReferralCode at :55 (needs db.getApplicationByReferralCode
// mocked). The slug logic alone is testable without any I/O.

const { generateReferralSlug } = require('../../index');

describe('generateReferralSlug', () => {
  test('lowercases and strips non-alphanumeric', () => {
    expect(generateReferralSlug('Zubeir Noorani')).toBe('zubeirnoorani');
  });

  test('truncates to 20 chars', () => {
    expect(generateReferralSlug('SomeVeryVeryLongName_WithExtraStuff')).toHaveLength(20);
  });

  test('empty name → "user"', () => {
    expect(generateReferralSlug('')).toBe('user');
    expect(generateReferralSlug(null)).toBe('user');
    expect(generateReferralSlug(undefined)).toBe('user');
  });

  test('all non-alphanumeric → "user"', () => {
    expect(generateReferralSlug('!!!@@@###')).toBe('user');
  });

  test('strips spaces and punctuation', () => {
    expect(generateReferralSlug("O'Brien-Smith Jr.")).toBe('obriensmithjr');
  });

  test('preserves digits', () => {
    expect(generateReferralSlug('User123')).toBe('user123');
  });

  test('unicode chars are stripped (regex matches only ASCII alphanum)', () => {
    expect(generateReferralSlug('José Müller')).toBe('josmller');
  });
});

// makeUniqueReferralCode does DB I/O so we exercise it in the integration
// suite. Here we just confirm the pure slug behavior above.

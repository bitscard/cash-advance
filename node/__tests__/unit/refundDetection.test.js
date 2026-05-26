// Covers buildRefundSet at node/index.js:223.
// Returns a Set of transaction IDs that look like refunds: an incoming
// transaction whose merchant has a prior matching outgoing within ±10%.

const { buildRefundSet } = require('../../index');

// Plaid-shaped txs (post-normalization): positive amount = money in,
// negative = money out. `description` is lowercased internally.
function tx(id, amount, description, date = '2026-05-15') {
  return { id, amount, description, date };
}

describe('buildRefundSet', () => {
  test('empty input → empty set', () => {
    const result = buildRefundSet([]);
    expect(result.size).toBe(0);
  });

  test('no matching prior spend → not flagged', () => {
    const txs = [
      tx('1', 5000, 'STARBUCKS'),
      tx('2', -1000, 'CHIPOTLE'),
    ];
    expect(buildRefundSet(txs).has('1')).toBe(false);
  });

  test('exact-match prior spend → flagged as refund', () => {
    const txs = [
      tx('1', -2500, 'AMAZON'),
      tx('2', 2500, 'AMAZON'),
    ];
    const refunds = buildRefundSet(txs);
    expect(refunds.has('2')).toBe(true);
    expect(refunds.has('1')).toBe(false);
  });

  test('within 10% tolerance → flagged', () => {
    const txs = [
      tx('1', -10000, 'WALMART'),
      tx('2', 9500, 'WALMART'), // 5% less → within tolerance
    ];
    expect(buildRefundSet(txs).has('2')).toBe(true);
  });

  test('outside 10% tolerance → not flagged', () => {
    const txs = [
      tx('1', -10000, 'WALMART'),
      tx('2', 12000, 'WALMART'), // 20% more → outside tolerance
    ];
    expect(buildRefundSet(txs).has('2')).toBe(false);
  });

  test('matches on description (case-insensitive after trim)', () => {
    const txs = [
      tx('1', -5000, 'Target Store'),
      tx('2', 5000, 'target store'),
    ];
    expect(buildRefundSet(txs).has('2')).toBe(true);
  });

  test('outgoing transactions are never in the refund set', () => {
    const txs = [
      tx('1', -2500, 'AMAZON'),
      tx('2', 2500, 'AMAZON'),
    ];
    const refunds = buildRefundSet(txs);
    expect(refunds.has('1')).toBe(false);
  });

  test('ignores transactions without a description', () => {
    const txs = [
      tx('1', 5000, ''),
      tx('2', -5000, ''),
    ];
    expect(buildRefundSet(txs).size).toBe(0);
  });

  test('multiple incoming match same prior spend independently', () => {
    const txs = [
      tx('1', -2500, 'STORE'),
      tx('2', 2500, 'STORE'),
      tx('3', 2500, 'STORE'),
    ];
    const refunds = buildRefundSet(txs);
    expect(refunds.has('2')).toBe(true);
    expect(refunds.has('3')).toBe(true);
  });
});

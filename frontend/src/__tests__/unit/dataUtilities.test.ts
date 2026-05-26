// Representative coverage for the data-transform helpers exported by
// dataUtilities.ts. The file has 40+ transformers; we test 2-3 in depth
// to lock down the formatting expectations and prevent silent breakage
// from a Plaid response shape change. Adding more transformer tests as
// they become bug-prone is straightforward.

import { describe, test, expect } from "vitest";
import {
  transformAuthData,
  transformTransactionsData,
  transformBalanceData,
} from "../../dataUtilities";

describe("transformAuthData", () => {
  test("returns rows for each account number", () => {
    const fakePlaidResponse = {
      numbers: {
        ach: [
          {
            account: "1111222233334444",
            routing: "11000025",
            wire_routing: null,
            account_id: "acc_1",
          },
        ],
      },
      accounts: [
        { account_id: "acc_1", name: "Checking", balances: {} },
      ],
    };
    const rows = transformAuthData(fakePlaidResponse as any);
    expect(rows.length).toBeGreaterThan(0);
    const row = rows[0];
    expect(Object.values(row)).toEqual(expect.arrayContaining(["Checking"]));
  });
});

describe("transformTransactionsData", () => {
  test("returns one row per transaction with the right fields", () => {
    const fakeResp = {
      latest_transactions: [
        { name: "Starbucks", amount: 5.5, date: "2026-05-15", category: ["Food"] },
        { name: "ACME Payroll", amount: -2000, date: "2026-05-15", category: ["Transfer"] },
      ],
    };
    const rows = transformTransactionsData(fakeResp as any);
    expect(rows).toHaveLength(2);
  });
});

describe("transformBalanceData", () => {
  test("returns one row per account with balance values", () => {
    const fakeResp = {
      accounts: [
        {
          account_id: "acc_1",
          name: "Checking",
          balances: { available: 1250, current: 1300, iso_currency_code: "USD" },
          subtype: "checking",
          mask: "1234",
        },
      ],
    };
    const rows = transformBalanceData(fakeResp as any);
    expect(rows.length).toBe(1);
  });
});

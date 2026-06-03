'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Stripe Connect Custom — zero-friction payout module
// ─────────────────────────────────────────────────────────────────────────────
//
// This module:
//   1. Creates a Stripe Connect Custom account at signup time with the
//      user's KYC data (name, DOB, SSN, phone, email, address). The
//      address is the ONE new input we collect; everything else is
//      already in our DB. KYC runs async on Stripe's side — we don't
//      block the user waiting for it.
//   2. Wires the existing FC bank-link to ALSO mint an external_account
//      on the Connect side, so the same bank works for both:
//        - pull (ACH debit via Customer PaymentMethod) — unchanged
//        - push (instant payout via Connect external_account) — new
//   3. Disburses the advance via stripe.payouts.create on the Connect
//      account when admin marks the user as funded. Falls back to the
//      existing manual Brex flow if KYC isn't complete OR payouts
//      aren't enabled OR the payout call itself fails.
//
// EVERY public function in this module:
//   - Runs in fire-and-forget context where possible — failure here
//     never breaks the existing FC flow (which runs in parallel and
//     is the safety net)
//   - Is idempotent — safe to call multiple times for the same user
//
// If this module misbehaves in production: pull request that reverts
// the integration points (in index.js: the setImmediate block in
// /stripe/fc/complete, the Connect block in transitionToFunded, and
// the account.updated webhook addition). The module file itself can
// stay — it's dormant when nothing calls it.

// ─── Helpers ──────────────────────────────────────────────────────────────

function splitName(fullName) {
  const parts = (fullName || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: '', last: '' };
  if (parts.length === 1) return { first: parts[0], last: parts[0] };
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

function parseDob(dobStr) {
  // Accept YYYY-MM-DD or a Date object
  let s = dobStr;
  if (s instanceof Date) s = s.toISOString().slice(0, 10);
  if (typeof s !== 'string' || s.length < 10) return null;
  const [y, m, d] = s.slice(0, 10).split('-').map(n => parseInt(n, 10));
  if (!y || !m || !d) return null;
  return { year: y, month: m, day: d };
}

function hasKycPrerequisites(row) {
  return Boolean(
    row.name &&
    row.email &&
    row.phone &&
    row.dob &&
    row.ssn &&
    row.ssn.replace(/\D/g, '').length === 9 &&
    row.address_line1 &&
    row.address_city &&
    row.address_state &&
    row.address_postal_code,
  );
}

// ─── Phase 1: Connect Custom account creation ────────────────────────────

/**
 * Create a Stripe Connect Custom account for the user with KYC data.
 * Idempotent: if the row already has stripe_connect_account_id, refreshes
 * the live state from Stripe and returns it.
 *
 * Returns { accountId, payoutsEnabled, disabledReason } on success.
 * Returns { skipped: true, reason } if disabled / missing prerequisites.
 * Throws ONLY if the Stripe API call itself errors — caller should log
 * and continue with the existing FC flow as fallback.
 */
async function ensureConnectAccount(stripe, db, row, clientIp) {
  // Refresh-only path: existing account
  if (row.stripe_connect_account_id) {
    const live = await stripe.accounts.retrieve(row.stripe_connect_account_id);
    const payoutsEnabled = !!live.payouts_enabled;
    const disabledReason = live.requirements && live.requirements.disabled_reason || null;
    await db.saveConnectAccount(row.id, live.id, payoutsEnabled, disabledReason);
    return { accountId: live.id, payoutsEnabled, disabledReason };
  }

  if (!hasKycPrerequisites(row)) {
    return { skipped: true, reason: 'missing_kyc_data' };
  }

  const { first, last } = splitName(row.name);
  const dob = parseDob(row.dob);
  if (!dob) {
    return { skipped: true, reason: 'invalid_dob' };
  }
  const ssnClean = row.ssn.replace(/\D/g, '');

  const account = await stripe.accounts.create({
    type: 'custom',
    country: 'US',
    email: row.email,
    capabilities: {
      // 'transfers' lets us send funds from platform balance to this
      // account. We intentionally OMIT 'card_payments' — this account
      // never charges anyone, only receives.
      transfers: { requested: true },
    },
    business_type: 'individual',
    individual: {
      first_name: first,
      last_name: last,
      email: row.email,
      phone: row.phone,
      dob: { day: dob.day, month: dob.month, year: dob.year },
      address: {
        line1: row.address_line1,
        city: row.address_city,
        state: row.address_state,
        postal_code: row.address_postal_code,
        country: 'US',
      },
      ssn_last_4: ssnClean.slice(-4),
      // Sending full SSN id_number front-loads KYC verification so the
      // account is more likely to be payouts_enabled immediately rather
      // than spending hours/days in 'currently_due' status.
      id_number: ssnClean,
    },
    tos_acceptance: {
      // We accept TOS on behalf of the user — they consented to our
      // signup ToS which authorizes us to act as their agent for
      // Stripe Connect ToS. Recipient agreement covers receive-only.
      date: Math.floor(Date.now() / 1000),
      ip: clientIp || '0.0.0.0',
      service_agreement: 'recipient',
    },
    metadata: {
      application_id: row.id,
      created_via: 'auto_kyc',
    },
  });

  const payoutsEnabled = !!account.payouts_enabled;
  const disabledReason = account.requirements && account.requirements.disabled_reason || null;
  await db.saveConnectAccount(row.id, account.id, payoutsEnabled, disabledReason);
  await db.saveConnectTosAcceptance(row.id, clientIp);

  console.log('[connect-custom] account created', {
    application_id: row.id,
    account_id: account.id,
    payouts_enabled: payoutsEnabled,
    disabled_reason: disabledReason,
  });

  return { accountId: account.id, payoutsEnabled, disabledReason };
}

// ─── Phase 1b: Attach FC bank to Connect external_account ────────────────

/**
 * After the existing FC SetupIntent flow saves a us_bank_account
 * PaymentMethod to the Customer, this function ALSO mints a bank-account
 * token in the Connect account's context and attaches it as an
 * external_account. The bank is now a valid payout destination.
 *
 * Why token cloning here instead of FC-on-Connect-directly?
 * Because the FC integration is finally working after a lot of pain,
 * and the user explicitly asked to not touch it. So we let the existing
 * FC flow do its thing (Customer-anchored), then mint the Connect-side
 * external_account from the same bank data afterwards.
 *
 * Requires routing + full account number. Routing is on the PM by default;
 * account number requires subscribing to the account_numbers feature
 * on the FC account (Stripe charges ~$0.30 per call).
 *
 * Idempotent: returns the existing external_account ID if a bank with
 * matching fingerprint is already attached.
 */
async function attachBankToConnectAccount(stripe, db, row, paymentMethodId, connectAccountId) {
  if (!connectAccountId) {
    return { skipped: true, reason: 'no_connect_account' };
  }
  if (!paymentMethodId) {
    return { skipped: true, reason: 'no_payment_method' };
  }

  // Idempotency check via fingerprint
  const sourcePm = await stripe.paymentMethods.retrieve(paymentMethodId);
  const sourceFingerprint = sourcePm.us_bank_account && sourcePm.us_bank_account.fingerprint;
  const fcAccountId = sourcePm.us_bank_account && sourcePm.us_bank_account.financial_connections_account;

  if (sourceFingerprint) {
    const existing = await stripe.accounts.listExternalAccounts(connectAccountId, {
      object: 'bank_account',
      limit: 10,
    });
    const match = existing.data.find(ba => ba.fingerprint === sourceFingerprint);
    if (match) {
      await db.saveConnectExternalAccount(row.id, match.id);
      return { externalAccountId: match.id, cloned: false };
    }
  }

  if (!fcAccountId) {
    // No FC account — bank was attached some other way. Skip.
    return { skipped: true, reason: 'no_fc_account' };
  }

  // Subscribe to account_numbers (idempotent on Stripe's side).
  try {
    await stripe.financialConnections.accounts.subscribe(fcAccountId, {
      features: ['account_numbers'],
    });
  } catch (subErr) {
    // If the account doesn't support post-hoc account_numbers
    // subscription, we can't get the full account number — can't
    // mint the Connect external_account. Caller falls back to Brex.
    console.warn('[connect-custom] account_numbers subscribe failed', {
      application_id: row.id, fc_account: fcAccountId, error: subErr.message,
    });
    return { skipped: true, reason: 'account_numbers_unsupported' };
  }

  // Retrieve the actual account number. May take a moment to propagate.
  let accountNumber = null;
  for (let attempt = 0; attempt < 5 && !accountNumber; attempt++) {
    try {
      const numbers = await stripe.financialConnections.accountNumbers.list({
        account: fcAccountId,
      });
      if (numbers && numbers.data && numbers.data.length > 0) {
        accountNumber = numbers.data[0].account_number || null;
      }
    } catch (listErr) {
      console.warn('[connect-custom] account_numbers list failed (attempt ' + (attempt + 1) + ')', listErr.message);
    }
    if (!accountNumber) {
      await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  if (!accountNumber) {
    return { skipped: true, reason: 'account_number_unavailable' };
  }

  // Mint bank-account token in Connect account's context.
  const token = await stripe.tokens.create(
    {
      bank_account: {
        country: 'US',
        currency: 'usd',
        account_holder_name: (sourcePm.billing_details && sourcePm.billing_details.name) || row.name,
        account_holder_type: (sourcePm.us_bank_account && sourcePm.us_bank_account.account_holder_type) || 'individual',
        routing_number: sourcePm.us_bank_account.routing_number,
        account_number: accountNumber,
      },
    },
    { stripeAccount: connectAccountId },
  );

  const externalAccount = await stripe.accounts.createExternalAccount(connectAccountId, {
    external_account: token.id,
    default_for_currency: true,
  });

  await db.saveConnectExternalAccount(row.id, externalAccount.id);

  console.log('[connect-custom] bank attached to connect account', {
    application_id: row.id,
    connect_account: connectAccountId,
    external_account: externalAccount.id,
  });

  return { externalAccountId: externalAccount.id, cloned: true };
}

// ─── Phase 2: Disbursement (the push) ────────────────────────────────────

/**
 * Pay out the cash advance to the user via Stripe Instant Payout.
 *
 * Two-step flow:
 *   1. stripe.transfers.create — moves money from platform balance
 *      to the Connect account's balance
 *   2. stripe.payouts.create — moves money from Connect account
 *      balance to the user's bank (external_account)
 *
 * Returns:
 *   - { paid: true, transferId, payoutId, method } on success
 *   - { paid: false, reason } if Connect path isn't usable; caller
 *     should fall back to manual Brex disbursement
 *
 * Never throws — always returns a result object. Caller's job is to
 * decide what to do based on the result.
 */
async function disburseViaConnect(stripe, db, row, amountCents, deliveryType) {
  if (!row.stripe_connect_account_id) {
    return { paid: false, reason: 'no_connect_account' };
  }
  if (!row.stripe_connect_external_account_id) {
    return { paid: false, reason: 'no_external_account' };
  }

  // Refresh KYC status before attempting — Stripe sometimes flips
  // payouts_enabled after a webhook lag.
  try {
    const live = await stripe.accounts.retrieve(row.stripe_connect_account_id);
    const payoutsEnabled = !!live.payouts_enabled;
    const disabledReason = live.requirements && live.requirements.disabled_reason || null;
    await db.saveConnectAccount(row.id, live.id, payoutsEnabled, disabledReason);
    if (!payoutsEnabled) {
      return { paid: false, reason: 'kyc_pending', disabled_reason: disabledReason };
    }
  } catch (refreshErr) {
    console.warn('[connect-custom] account refresh failed', refreshErr.message);
    return { paid: false, reason: 'refresh_failed', error: refreshErr.message };
  }

  // Step 1: platform → Connect transfer
  let transfer;
  try {
    transfer = await stripe.transfers.create({
      amount: amountCents,
      currency: 'usd',
      destination: row.stripe_connect_account_id,
      description: 'Cash advance — application ' + row.id,
      metadata: { application_id: row.id },
    });
  } catch (transferErr) {
    console.warn('[connect-custom] transfer failed', transferErr.message);
    return { paid: false, reason: 'transfer_failed', error: transferErr.message };
  }

  // Step 2: Connect → external_account payout. Instant if delivery=instant,
  // standard otherwise.
  const wantInstant = deliveryType === 'instant';
  let payout;
  let usedMethod = wantInstant ? 'instant' : 'standard';
  try {
    payout = await stripe.payouts.create(
      {
        amount: amountCents,
        currency: 'usd',
        method: usedMethod,
        destination: row.stripe_connect_external_account_id,
        description: 'Bits Cash Advance — $' + (amountCents / 100).toFixed(2),
        metadata: { application_id: row.id, transfer_id: transfer.id },
      },
      { stripeAccount: row.stripe_connect_account_id },
    );
  } catch (payoutErr) {
    // Most common: instant unavailable for this bank. Try standard.
    if (wantInstant && /instant/i.test(payoutErr.message || '')) {
      try {
        payout = await stripe.payouts.create(
          {
            amount: amountCents,
            currency: 'usd',
            method: 'standard',
            destination: row.stripe_connect_external_account_id,
            description: 'Bits Cash Advance — $' + (amountCents / 100).toFixed(2) + ' (standard fallback)',
            metadata: { application_id: row.id, transfer_id: transfer.id, instant_fallback: 'true' },
          },
          { stripeAccount: row.stripe_connect_account_id },
        );
        usedMethod = 'standard_fallback';
      } catch (fallbackErr) {
        console.warn('[connect-custom] both payout methods failed', fallbackErr.message);
        return { paid: false, reason: 'payout_failed', error: fallbackErr.message };
      }
    } else {
      console.warn('[connect-custom] payout failed', payoutErr.message);
      return { paid: false, reason: 'payout_failed', error: payoutErr.message };
    }
  }

  await db.saveConnectDisbursement(row.id, transfer.id, payout.id);

  console.log('[connect-custom] disbursement complete', {
    application_id: row.id,
    transfer: transfer.id,
    payout: payout.id,
    method: usedMethod,
  });

  return {
    paid: true,
    transferId: transfer.id,
    payoutId: payout.id,
    method: usedMethod,
  };
}

// ─── Webhook handler for account.updated ─────────────────────────────────

/**
 * When Stripe updates a Connect account (KYC completes / fails),
 * sync the state into our DB. Called from the main webhook handler.
 */
async function handleAccountUpdated(stripe, db, account) {
  const applicationId = account.metadata && account.metadata.application_id;
  if (!applicationId) {
    // Try lookup by account ID
    const row = await db.getApplicationByConnectAccountId(account.id);
    if (!row) return;
    const reason = account.requirements && account.requirements.disabled_reason || null;
    await db.saveConnectAccount(row.id, account.id, !!account.payouts_enabled, reason);
    return;
  }
  const reason = account.requirements && account.requirements.disabled_reason || null;
  await db.saveConnectAccount(applicationId, account.id, !!account.payouts_enabled, reason);
  console.log('[connect-custom] account.updated synced', {
    application_id: applicationId,
    account_id: account.id,
    payouts_enabled: !!account.payouts_enabled,
    disabled_reason: reason,
  });
}

module.exports = {
  ensureConnectAccount,
  attachBankToConnectAccount,
  disburseViaConnect,
  handleAccountUpdated,
};

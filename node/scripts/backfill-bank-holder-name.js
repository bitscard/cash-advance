'use strict';

// One-off backfill: pull the bank holder name from Stripe FC's ownership
// feature for every application that already has a stripe_fc_account_id
// but no bank_holder_name yet.
//
// Subscribes the account to the 'ownership' feature (idempotent), refreshes
// it, then retrieves and saves the owner's name. Costs ~$0.10 per account
// per Stripe — keep an eye on the running estimate the script prints.
//
// Usage:
//   node node/scripts/backfill-bank-holder-name.js              # dry-run
//   node node/scripts/backfill-bank-holder-name.js --commit     # actually run
//
// Required env vars (script loads .env):
//   STRIPE_SECRET_KEY, DATABASE_URL
//
// Safe to re-run — already-saved rows are skipped.

require('dotenv').config();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const db = require('../db');

const COMMIT = process.argv.includes('--commit');
const COST_PER_CALL = 0.10;

async function main() {
  if (!COMMIT) {
    console.log('🔍 DRY RUN — no changes will be made and no Stripe calls cost-incurring.');
    console.log('   Re-run with --commit to actually fetch + save.');
  } else {
    console.log('🚀 LIVE RUN — every row processed will cost ~$0.10 in Stripe charges.');
  }
  console.log('');

  const { rows } = await db.pool.query(`
    SELECT id, name, stripe_fc_account_id
    FROM applications
    WHERE stripe_fc_account_id IS NOT NULL
      AND (bank_holder_name IS NULL OR bank_holder_name = '')
    ORDER BY created_at DESC
  `);

  const estCost = rows.length * COST_PER_CALL;
  console.log(`Found ${rows.length} applications needing backfill.`);
  console.log(`Estimated Stripe cost: $${estCost.toFixed(2)}`);
  console.log('');

  if (!COMMIT) {
    rows.slice(0, 20).forEach((r, i) => {
      console.log(`  ${i + 1}. ${r.name.padEnd(35)} fc=${r.stripe_fc_account_id}`);
    });
    if (rows.length > 20) console.log(`  …and ${rows.length - 20} more`);
    console.log('');
    console.log('To commit: re-run with --commit');
    await db.pool.end();
    return;
  }

  let processed = 0;
  let saved = 0;
  let empty = 0;
  let errors = 0;

  for (const row of rows) {
    processed++;
    try {
      await stripe.financialConnections.accounts.subscribe(row.stripe_fc_account_id, {
        features: ['ownership'],
      });
      // Refresh isn't strictly required after subscribe (Stripe auto-refreshes
      // on subscribe), but explicit refresh forces immediate availability.
      try {
        await stripe.financialConnections.accounts.refresh(row.stripe_fc_account_id, {
          features: ['ownership'],
        });
      } catch (_) {
        // refresh can race subscribe; ignore here, the retrieve below
        // either gets data or doesn't.
      }
      const acct = await stripe.financialConnections.accounts.retrieve(row.stripe_fc_account_id, {
        expand: ['owners'],
      });
      const owners = (acct.owners && acct.owners.data) || [];
      const ownerName = owners[0] && owners[0].name ? owners[0].name : null;
      if (ownerName) {
        await db.saveBankHolderName(row.id, ownerName);
        saved++;
        console.log(`  [${processed}/${rows.length}] ✓ ${row.name.padEnd(30)} → ${ownerName}`);
      } else {
        empty++;
        console.log(`  [${processed}/${rows.length}] ○ ${row.name.padEnd(30)} (no ownership data)`);
      }
    } catch (e) {
      errors++;
      console.log(`  [${processed}/${rows.length}] ✗ ${row.name.padEnd(30)} ${e.message}`);
    }
    // Light rate-limit: 5/sec to stay well under Stripe's burst limits.
    await new Promise(r => setTimeout(r, 200));
  }

  console.log('');
  console.log(`Done. processed=${processed} saved=${saved} empty=${empty} errors=${errors}`);
  console.log(`Estimated actual Stripe cost: $${(processed * COST_PER_CALL).toFixed(2)}`);
  await db.pool.end();
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});

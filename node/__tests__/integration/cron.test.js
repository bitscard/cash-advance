// Tests the due-date reminder cron:
//   - sendDueDateReminders() finds apps exactly 2 days from due
//   - sets due_date_reminder_sent_at (idempotency on re-run)
//   - setRepayment resets the timestamp so the next advance cycle reminds

const request = require('supertest');
const { app, sendDueDateReminders } = require('../../index');
const db = require('../../db');
const { applyMigrations, truncateAll, closePool, getPool } = require('../dbHelpers');

beforeAll(async () => {
  await applyMigrations();
});
beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await closePool();
});

const ADMIN_HEADER = { 'x-admin-token': process.env.ADMIN_TOKEN };

async function seedFundedApp({ dueDaysFromNow = 2, deliveryType = 'standard' } = {}) {
  const res = await request(app).post('/api/advance/applications').send({
    name: 'Test', email: `cron-${Date.now()}-${Math.random()}@example.com`,
    phone: '+15555550100', dob: '1990-01-01', requested_amount: 25,
    password: 'test-password', ssn: '111223333', state: 'Georgia',
    income_sources: [{ employer: 'Acme', payday: global.TEST_FUTURE_PAYDAY, pay_frequency: 'biweekly' }],
  });
  const application = res.body.application;
  await db.saveDeliveryType(application.id, deliveryType, false);
  const dueDate = new Date();
  dueDate.setDate(dueDate.getDate() + dueDaysFromNow);
  await db.setRepayment(application.id, 25, dueDate.toISOString().slice(0, 10), '');
  await db.updateApplicationStatus(application.id, 'repayment_scheduled');
  return application;
}

describe('sendDueDateReminders()', () => {
  test('finds applications exactly 2 days from due', async () => {
    const dueIn2 = await seedFundedApp({ dueDaysFromNow: 2 });
    await seedFundedApp({ dueDaysFromNow: 1 }); // too close
    await seedFundedApp({ dueDaysFromNow: 5 }); // too far
    const count = await sendDueDateReminders();
    expect(count).toBe(1);
    const updated = await db.getApplicationById(dueIn2.id);
    expect(updated.due_date_reminder_sent_at).not.toBeNull();
  });

  test('idempotent — second run does not re-notify', async () => {
    await seedFundedApp({ dueDaysFromNow: 2 });
    expect(await sendDueDateReminders()).toBe(1);
    expect(await sendDueDateReminders()).toBe(0);
  });

  test('setRepayment resets the sent timestamp', async () => {
    const application = await seedFundedApp({ dueDaysFromNow: 2 });
    await sendDueDateReminders();
    let dbRow = await db.getApplicationById(application.id);
    expect(dbRow.due_date_reminder_sent_at).not.toBeNull();

    // Simulate a new advance cycle.
    const newDue = new Date();
    newDue.setDate(newDue.getDate() + 30);
    await db.setRepayment(application.id, 25, newDue.toISOString().slice(0, 10), '');
    dbRow = await db.getApplicationById(application.id);
    expect(dbRow.due_date_reminder_sent_at).toBeNull();
  });

  test('skips applications without a status of funded or repayment_scheduled', async () => {
    const application = await seedFundedApp({ dueDaysFromNow: 2 });
    // Move it back to 'reviewing'
    await db.updateApplicationStatus(application.id, 'reviewing');
    const count = await sendDueDateReminders();
    expect(count).toBe(0);
  });
});

describe('POST /api/cron/due-date-reminders', () => {
  test('admin-callable endpoint returns count', async () => {
    await seedFundedApp({ dueDaysFromNow: 2 });
    const res = await request(app)
      .post('/api/cron/due-date-reminders')
      .set(ADMIN_HEADER);
    expect(res.status).toBe(200);
    expect(res.body.sent).toBe(1);
  });

  test('requires admin token', async () => {
    const res = await request(app).post('/api/cron/due-date-reminders');
    expect(res.status).toBe(401);
  });
});

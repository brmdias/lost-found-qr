import assert from 'node:assert/strict';
import { createHandler } from '../src/handler.mjs';

function makeDeps() {
  const tables = { items: new Map(), reports: new Map(), rate: new Map() };
  const emails = [];
  const sms = [];
  let clock = 1_700_000_000_000;

  const deps = {
    now: () => clock,
    uuid: (() => {
      let n = 0;
      return () => `report-${++n}`;
    })(),
    async getItem(table, key) {
      return tables[table].get(key.item_id ?? key.pk) ?? null;
    },
    async putItem(table, item, condition) {
      if (condition === 'attribute_not_exists(pk)' && tables[table].has(item.pk)) return false;
      if (condition === 'attribute_not_exists(item_id)' && tables[table].has(item.item_id)) return false;
      tables[table].set(item.item_id ?? item.pk, item);
      return true;
    },
    async increment(table, key, countAttr, expiresAt) {
      const existing = tables[table].get(key.pk) ?? { pk: key.pk, count: 0 };
      existing[countAttr] = (existing[countAttr] ?? 0) + 1;
      existing.expires_at = expiresAt;
      tables[table].set(key.pk, existing);
      return existing[countAttr];
    },
    async sendEmail(email) {
      emails.push(email);
    },
    async sendSms(msg) {
      sms.push(msg);
    },
  };
  deps.tables = tables;
  return { deps, tables, emails, sms, tick: (ms) => (clock += ms) };
}

function getEvent(itemId) {
  return {
    version: '2.0',
    rawPath: `/v1/item/${itemId}`,
    requestContext: { http: { method: 'GET', sourceIp: '203.0.113.9' } },
  };
}

function reportEvent(body, ip = '203.0.113.9') {
  return {
    version: '2.0',
    rawPath: '/v1/report',
    requestContext: { http: { method: 'POST', sourceIp: ip } },
    body: JSON.stringify(body),
  };
}

const tests = [];
function test(name, fn) {
  tests.push([name, fn]);
}

test('GET active item returns only non-private fields', async () => {
  const { deps } = makeDeps();
  deps.tables.items.set('ABC123', {
    item_id: 'ABC123',
    item_label: 'Blue water bottle',
    owner_email: 'owner@example.com',
    owner_phone: '+15551234567',
    status: 'active',
  });
  const handler = createHandler(deps);
  const res = await handler(getEvent('ABC123'));
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.deepEqual(body, { item_id: 'ABC123', item_label: 'Blue water bottle', status: 'active' });
  assert.ok(!res.body.includes('owner@example.com'));
  assert.ok(!res.body.includes('15551234567'));
});

test('GET unknown item returns generic 404', async () => {
  const { deps } = makeDeps();
  const handler = createHandler(deps);
  const res = await handler(getEvent('NOPE99'));
  assert.equal(res.statusCode, 404);
  assert.deepEqual(JSON.parse(res.body), { error: 'item not registered' });
});

test('GET disabled item returns generic 404', async () => {
  const { deps } = makeDeps();
  deps.tables.items.set('OLD111', { item_id: 'OLD111', owner_email: 'owner@example.com', status: 'disabled' });
  const handler = createHandler(deps);
  const res = await handler(getEvent('OLD111'));
  assert.equal(res.statusCode, 404);
  assert.ok(!res.body.includes('owner@example.com'));
});

test('GET item with malformed id returns generic 404', async () => {
  const { deps } = makeDeps();
  const handler = createHandler(deps);
  const res = await handler(getEvent('../etc/passwd'));
  assert.equal(res.statusCode, 404);
});

test('valid report stores report and sends owner email', async () => {
  const { deps, tables, emails, sms } = makeDeps();
  deps.tables.items.set('ABC123', {
    item_id: 'ABC123',
    item_label: 'Blue water bottle',
    owner_email: 'owner@example.com',
    notify_email: true,
    notify_sms: false,
    status: 'active',
  });
  const handler = createHandler(deps);
  const res = await handler(
    reportEvent({
      item_id: 'ABC123',
      finder_name: 'Ana',
      finder_contact: 'ana@example.com',
      message: 'Found your bottle near the fountain.',
    })
  );
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { ok: true });

  const reports = [...tables.reports.values()];
  assert.equal(reports.length, 1);
  assert.equal(reports[0].item_id, 'ABC123');
  assert.equal(reports[0].finder_contact, 'ana@example.com');

  assert.equal(emails.length, 1);
  assert.equal(emails[0].to, 'owner@example.com');
  assert.ok(emails[0].text.includes('ana@example.com'));
  assert.ok(emails[0].text.includes('Found your bottle near the fountain.'));
  assert.equal(sms.length, 0);
});

test('report with notify_sms sends SMS', async () => {
  const { deps, sms } = makeDeps();
  deps.tables.items.set('SMS111', {
    item_id: 'SMS111',
    owner_email: 'owner@example.com',
    owner_phone: '+15551234567',
    notify_email: false,
    notify_sms: true,
    status: 'active',
  });
  const handler = createHandler(deps);
  const res = await handler(
    reportEvent({ item_id: 'SMS111', finder_contact: 'ana@example.com', message: 'Found it at the station.' })
  );
  assert.equal(res.statusCode, 200);
  assert.equal(sms.length, 1);
  assert.ok(sms[0].message.includes('SMS111'));
});

test('invalid payloads return 400', async () => {
  const { deps } = makeDeps();
  const handler = createHandler(deps);
  const cases = [
    reportEvent({ item_id: 'ABC123', finder_contact: 'not-an-email', message: 'long enough message here' }),
    reportEvent({ item_id: 'ABC123', finder_contact: 'ana@example.com', message: 'short' }),
    reportEvent({ item_id: 'ABC123', finder_contact: '', message: 'long enough message here' }),
    reportEvent({ item_id: '', finder_contact: 'ana@example.com', message: 'long enough message here' }),
    { version: '2.0', rawPath: '/v1/report', requestContext: { http: { method: 'POST', sourceIp: '1.2.3.4' } }, body: 'not json' },
  ];
  for (const ev of cases) {
    const res = await handler(ev);
    assert.equal(res.statusCode, 400, JSON.stringify(ev.body));
    assert.ok(JSON.parse(res.body).error);
  }
});

test('unknown item on report returns 404', async () => {
  const { deps } = makeDeps();
  const handler = createHandler(deps);
  const res = await handler(
    reportEvent({ item_id: 'NOPE99', finder_contact: 'ana@example.com', message: 'long enough message here' })
  );
  assert.equal(res.statusCode, 404);
});

test('rate limit blocks the 6th report per hour per IP', async () => {
  const { deps } = makeDeps();
  deps.tables.items.set('ABC123', { item_id: 'ABC123', owner_email: 'owner@example.com', notify_email: false, status: 'active' });
  const handler = createHandler(deps);
  const body = { item_id: 'ABC123', finder_contact: 'ana@example.com', message: 'long enough message here' };
  for (let i = 0; i < 5; i++) {
    const res = await handler(reportEvent(body, '198.51.100.7'));
    assert.equal(res.statusCode, 200, `report ${i + 1}`);
  }
  const sixth = await handler(reportEvent(body, '198.51.100.7'));
  assert.equal(sixth.statusCode, 429);
  const otherIp = await handler(reportEvent(body, '198.51.100.8'));
  assert.equal(otherIp.statusCode, 200);
});

test('rate limit window resets after an hour', async () => {
  const { deps, tick } = makeDeps();
  deps.tables.items.set('ABC123', { item_id: 'ABC123', owner_email: 'owner@example.com', notify_email: false, status: 'active' });
  const handler = createHandler(deps);
  const body = { item_id: 'ABC123', finder_contact: 'ana@example.com', message: 'long enough message here' };
  for (let i = 0; i < 5; i++) {
    await handler(reportEvent(body, '198.51.100.7'));
  }
  assert.equal((await handler(reportEvent(body, '198.51.100.7'))).statusCode, 429);
  tick(61 * 60 * 1000);
  assert.equal((await handler(reportEvent(body, '198.51.100.7'))).statusCode, 200);
});

test('finder input is sanitized', async () => {
  const { deps, tables } = makeDeps();
  deps.tables.items.set('ABC123', { item_id: 'ABC123', owner_email: 'owner@example.com', notify_email: false, status: 'active' });
  const handler = createHandler(deps);
  const res = await handler(
    reportEvent({
      item_id: 'ABC123',
      finder_name: '  \u0000Evil<script>\u001f ',
      finder_contact: 'ana@example.com',
      message: '  Found it\u0007 near the fountain.  ',
    })
  );
  assert.equal(res.statusCode, 200);
  const report = [...tables.reports.values()][0];
  assert.equal(report.finder_name, 'Evil<script>');
  assert.equal(report.message, 'Found it near the fountain.');
});

test('SES failure does not fail the report', async () => {
  const { deps } = makeDeps();
  deps.tables.items.set('ABC123', { item_id: 'ABC123', owner_email: 'owner@example.com', notify_email: true, status: 'active' });
  deps.sendEmail = async () => {
    throw new Error('SES unavailable');
  };
  const handler = createHandler(deps);
  const res = await handler(
    reportEvent({ item_id: 'ABC123', finder_contact: 'ana@example.com', message: 'long enough message here' })
  );
  assert.equal(res.statusCode, 200);
});

test('unknown route returns 404 JSON', async () => {
  const { deps } = makeDeps();
  const handler = createHandler(deps);
  const res = await handler({
    version: '2.0',
    rawPath: '/v1/whatever',
    requestContext: { http: { method: 'GET', sourceIp: '1.2.3.4' } },
  });
  assert.equal(res.statusCode, 404);
  assert.ok(JSON.parse(res.body).error);
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`ok    ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL  ${name}`);
    console.error(err.message);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);

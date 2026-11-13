#!/usr/bin/env node
import fs from 'node:fs';
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { parseCsv } from './lib/csv.mjs';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const csvPath = arg('csv', 'items.csv');
const table = arg('table', process.env.ITEMS_TABLE);
const region = arg('region', process.env.AWS_REGION || 'eu-west-1');
const fallbackOwnerEmail = arg('owner-email', process.env.OWNER_EMAIL || '');

if (!table) {
  console.error('Usage: node scripts/seed-items.mjs --table items --csv items.csv [--owner-email you@example.com] [--region eu-west-1]');
  process.exit(1);
}
if (!fallbackOwnerEmail) {
  console.error('Provide an owner email via --owner-email or a owner_email CSV column.');
  process.exit(1);
}

const rows = parseCsv(fs.readFileSync(csvPath, 'utf8'));
const client = new DynamoDBClient({ region });

let seeded = 0;
for (const row of rows) {
  const item_id = (row.item_id || '').trim();
  const owner_email = (row.owner_email || fallbackOwnerEmail).trim();
  if (!item_id || !owner_email) {
    console.error(`skipping row without item_id or owner_email: ${JSON.stringify(row)}`);
    continue;
  }
  await client.send(
    new PutItemCommand({
      TableName: table,
      Item: {
        item_id: { S: item_id },
        owner_email: { S: owner_email },
        ...(row.owner_phone ? { owner_phone: { S: row.owner_phone.trim() } } : {}),
        notify_email: { BOOL: (row.notify_email || 'true').toLowerCase() !== 'false' },
        notify_sms: { BOOL: (row.notify_sms || 'false').toLowerCase() === 'true' },
        ...(row.item_label ? { item_label: { S: row.item_label.trim() } } : {}),
        status: { S: 'active' },
        created_at: { S: new Date().toISOString() },
      },
      ConditionExpression: 'attribute_not_exists(item_id)',
    })
  ).catch((err) => {
    if (err.name === 'ConditionalCheckFailedException') {
      console.log(`item ${item_id} already exists, skipping`);
      return;
    }
    throw err;
  });
  seeded++;
  console.log(`seeded ${item_id} -> ${owner_email}`);
}

console.log(`done, ${seeded} item(s) processed into table ${table}`);

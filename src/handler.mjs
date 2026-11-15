const ITEM_ID_RE = /^[A-Za-z0-9_-]{4,32}$/;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_RE = /^\+?[0-9][0-9\s().-]{6,19}$/;

const MAX_REPORTS_PER_HOUR = 5;
const RATE_WINDOW_SECONDS = 3600;

const MAX_NAME_LENGTH = 100;
const MIN_MESSAGE_LENGTH = 10;
const MAX_MESSAGE_LENGTH = 1000;

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    },
    body: JSON.stringify(body),
  };
}

function sanitizeText(value, maxLength, { multiline = false } = {}) {
  if (typeof value !== 'string') return '';
  const pattern = multiline ? /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g : /[\u0000-\u001F\u007F]/g;
  return value.replace(pattern, '').trim().slice(0, maxLength);
}

function isValidContact(value) {
  return EMAIL_RE.test(value) || PHONE_RE.test(value);
}

function parseBody(event) {
  let raw = event.body;
  if (raw == null) return null;
  if (event.isBase64Encoded) {
    raw = Buffer.from(raw, 'base64').toString('utf8');
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function sourceIp(event) {
  return event.requestContext?.http?.sourceIp || 'unknown';
}

async function checkRateLimit(deps, ip) {
  const nowSeconds = Math.floor(deps.now() / 1000);
  const windowIndex = Math.floor(nowSeconds / RATE_WINDOW_SECONDS);
  const pk = `${ip}#${windowIndex}`;
  const expiresAt = nowSeconds + 2 * RATE_WINDOW_SECONDS;
  const written = await deps.putItem('rate', { pk, count: 1, expires_at: expiresAt }, 'attribute_not_exists(pk)');
  if (written) return true;
  const count = await deps.increment('rate', { pk }, 'count', expiresAt);
  return count <= MAX_REPORTS_PER_HOUR;
}

function validateReport(body) {
  const item_id = sanitizeText(body.item_id, 32);
  if (!ITEM_ID_RE.test(item_id)) return { error: 'invalid item_id' };

  const finder_name = sanitizeText(body.finder_name ?? '', MAX_NAME_LENGTH);
  const finder_contact = sanitizeText(body.finder_contact ?? '', 254);
  if (!finder_contact) return { error: 'finder_contact is required' };
  if (!isValidContact(finder_contact)) return { error: 'finder_contact must be a valid email or phone number' };

  const message = sanitizeText(body.message ?? '', MAX_MESSAGE_LENGTH, { multiline: true });
  if (message.length < MIN_MESSAGE_LENGTH) return { error: `message must be at least ${MIN_MESSAGE_LENGTH} characters` };

  return { item_id, finder_name, finder_contact, message };
}

function buildEmail(item, report) {
  const label = item.item_label || report.item_id;
  const lines = [
    'Someone found your item.',
    '',
    `Item: ${label} (${report.item_id})`,
    report.finder_name ? `Finder name: ${report.finder_name}` : 'Finder name: (not given)',
    `Contact: ${report.finder_contact}`,
    '',
    'Message:',
    report.message,
    '',
    `Reported at: ${report.created_at}`,
    '',
    'Reply to the finder directly using the contact above.',
  ];
  return {
    to: item.owner_email,
    subject: `Found: ${label}`,
    text: lines.join('\n'),
  };
}

async function notifyOwner(deps, item, report) {
  const { NOTIFY_EMAIL_ENABLED, NOTIFY_SMS_ENABLED } = process.env;

  if (NOTIFY_EMAIL_ENABLED !== 'false' && item.notify_email !== false && item.owner_email && deps.sendEmail) {
    try {
      await deps.sendEmail(buildEmail(item, report));
    } catch (err) {
      console.error('SES email failed', err);
    }
  }

  if (NOTIFY_SMS_ENABLED !== 'false' && item.notify_sms === true && item.owner_phone && deps.sendSms) {
    try {
      await deps.sendSms({
        to: item.owner_phone,
        message: `Someone found your item ${report.item_id}. Check your email.`,
      });
    } catch (err) {
      console.error('SNS SMS failed', err);
    }
  }
}

async function handleGetItem(deps, itemId) {
  if (!ITEM_ID_RE.test(itemId)) {
    return json(404, { error: 'item not registered' });
  }
  const item = await deps.getItem('items', { item_id: itemId });
  if (!item || item.status !== 'active') {
    return json(404, { error: 'item not registered' });
  }
  return json(200, {
    item_id: item.item_id,
    item_label: typeof item.item_label === 'string' ? item.item_label : '',
    status: 'active',
  });
}

async function handleReport(deps, body, ip) {
  if (!body) {
    return json(400, { error: 'invalid JSON body' });
  }
  const fields = validateReport(body);
  if (fields.error) {
    return json(400, { error: fields.error });
  }

  const allowed = await checkRateLimit(deps, ip);
  if (!allowed) {
    return json(429, { error: 'too many reports from this address, try again later' });
  }

  const item = await deps.getItem('items', { item_id: fields.item_id });
  if (!item || item.status !== 'active') {
    return json(404, { error: 'item not registered' });
  }

  const report = {
    report_id: deps.uuid(),
    item_id: fields.item_id,
    finder_name: fields.finder_name,
    finder_contact: fields.finder_contact,
    message: fields.message,
    created_at: new Date(deps.now()).toISOString(),
  };
  await deps.putItem('reports', report, null);
  await notifyOwner(deps, item, report);

  return json(200, { ok: true });
}

export function createHandler(deps) {
  return async function handler(event) {
    try {
      const method = event.requestContext?.http?.method || event.httpMethod || '';
      const path = event.rawPath || event.path || '';

      if (method === 'OPTIONS') {
        return { statusCode: 204, headers: { 'access-control-allow-origin': '*' }, body: '' };
      }

      if (method === 'GET') {
        const match = path.match(/^\/v1\/item\/([^/]+)\/?$/);
        if (match) {
          return await handleGetItem(deps, decodeURIComponent(match[1]));
        }
      }

      if (method === 'POST' && /^\/v1\/report\/?$/.test(path)) {
        const body = parseBody(event);
        return await handleReport(deps, body, sourceIp(event));
      }

      return json(404, { error: 'not found' });
    } catch (err) {
      console.error('unhandled error', err);
      return json(500, { error: 'internal error' });
    }
  };
}

async function defaultDeps() {
  const { DynamoDBClient, GetItemCommand, PutItemCommand, UpdateItemCommand, ConditionalCheckFailedException } =
    await import('@aws-sdk/client-dynamodb');
  const { SESv2Client, SendEmailCommand } = await import('@aws-sdk/client-sesv2');
  const { SNSClient, PublishCommand } = await import('@aws-sdk/client-sns');

  const ddb = new DynamoDBClient({});
  const ses = new SESv2Client({});
  const sns = new SNSClient({});

  const attr = (value) => {
    if (typeof value === 'string') return { S: value };
    if (typeof value === 'number') return { N: String(value) };
    if (typeof value === 'boolean') return { BOOL: value };
    if (value == null) return { NULL: true };
    throw new Error(`unsupported attribute type: ${typeof value}`);
  };
  const marshalItem = (item) =>
    Object.fromEntries(Object.entries(item).map(([k, v]) => [k, attr(v)]));
  const unmarshalItem = (av) =>
    Object.fromEntries(
      Object.entries(av).map(([k, v]) => [
        k,
        v.S !== undefined ? v.S : v.N !== undefined ? Number(v.N) : v.BOOL !== undefined ? v.BOOL : null,
      ])
    );

  const tableNames = {
    items: process.env.ITEMS_TABLE,
    reports: process.env.REPORTS_TABLE,
    rate: process.env.RATE_LIMIT_TABLE,
  };

  return {
    now: () => Date.now(),
    uuid: () => crypto.randomUUID(),
    async getItem(table, key) {
      const res = await ddb.send(
        new GetItemCommand({ TableName: tableNames[table], Key: marshalItem(key), ConsistentRead: true })
      );
      return res.Item ? unmarshalItem(res.Item) : null;
    },
    async putItem(table, item, condition) {
      try {
        await ddb.send(
          new PutItemCommand({
            TableName: tableNames[table],
            Item: marshalItem(item),
            ...(condition ? { ConditionExpression: condition } : {}),
          })
        );
        return true;
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException || err.name === 'ConditionalCheckFailedException') {
          return false;
        }
        throw err;
      }
    },
    async increment(table, key, countAttr, expiresAt) {
      const res = await ddb.send(
        new UpdateItemCommand({
          TableName: tableNames[table],
          Key: marshalItem(key),
          UpdateExpression: 'ADD #c :one SET #e :ttl',
          ExpressionAttributeNames: { '#c': countAttr, '#e': 'expires_at' },
          ExpressionAttributeValues: { ':one': { N: '1' }, ':ttl': { N: String(expiresAt) } },
          ReturnValues: 'UPDATED_NEW',
        })
      );
      return Number(res.Attributes[countAttr].N);
    },
    async sendEmail({ to, subject, text }) {
      await ses.send(
        new SendEmailCommand({
          FromEmailAddress: process.env.SENDER_EMAIL,
          Destination: { ToAddresses: [to] },
          Content: {
            Simple: {
              Subject: { Data: subject, Charset: 'UTF-8' },
              Body: { Text: { Data: text, Charset: 'UTF-8' } },
            },
          },
        })
      );
    },
    async sendSms({ to, message }) {
      await sns.send(new PublishCommand({ PhoneNumber: to, Message: message }));
    },
  };
}

const handler = async (event, context) => {
  const deps = await defaultDeps();
  return createHandler(deps)(event, context);
};

export default handler;

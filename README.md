# Lost & Found QR Stickers

Each sticker carries a QR code linking to `https://yourdomain.com/item/{ID}`. A finder scans it, lands on a mobile-first page, and leaves a message. The owner is notified by email (optionally SMS) and decides whether to reply. The finder never sees any owner data.

## Stack

- **S3 + CloudFront (OAC)** — private static hosting with HTTPS. CloudFront also routes `/v1/*` to the API, so the page calls the API same-origin (no CORS issues in production).
- **API Gateway HTTP API** — cheapest API tier.
- **Lambda (Node.js 22.x, single handler, zero dependencies)** — uses the AWS SDK bundled in the runtime.
- **DynamoDB on-demand** — tables `items`, `reports`, and `rate_limits` (TTL-based rate limiting).
- **SES** email to the owner (SNS SMS optional, per-item opt-in).

## Layout

```
template.yaml          SAM template: everything (S3, CloudFront, API, Lambda, DynamoDB, SES)
src/handler.mjs        Single Lambda: GET /v1/item/{id}, POST /v1/report, rate limit, SES/SNS
frontend/index.html    The finder page (plain HTML/CSS/JS, no build step)
scripts/generate-qr.mjs  CSV -> QR codes (SVG/PNG) + print-ready HTML sticker sheet
scripts/seed-items.mjs   CSV -> seeds the items table
scripts/mock-server.mjs  Local mock of the API for frontend testing
test/run-tests.mjs     Handler tests with fake AWS dependencies (npm test)
items.example.csv      Expected CSV format
```

## API

Base path `/v1` (served both directly by API Gateway and through CloudFront).

- `GET /v1/item/{item_id}` → `200 {item_id, item_label, status}` or `404 {"error":"item not registered"}`. Never returns owner fields.
- `POST /v1/report` `{item_id, finder_name?, finder_contact, message}` → `200 {"ok":true}`. Errors: `400` invalid input, `404` unknown/disabled item, `429` rate limited.
  - `message`: 10–1000 chars. `finder_contact`: email or phone. `finder_name`: optional, ≤100 chars.
  - Rate limit: 5 reports/hour/IP via the `rate_limits` DynamoDB TTL table.

## Deploy

```bash
npm install            # only needed for the QR/seed scripts and tests
sam build
sam deploy --guided    # set SenderEmail to an address you control
```

Then:

1. **Verify the SES identity.** SES sends a verification email to `SenderEmail` on first deploy. Confirm it. In sandbox mode, SES can only send *to* verified addresses too — verify the owner's address for testing, then request production access.
2. **Upload the frontend:**
   ```bash
   BUCKET=$(aws cloudformation describe-stacks --stack-name <stack> \
     --query 'Stacks[0].Outputs[?OutputKey==`SiteBucketName`].OutputValue' --output text)
   aws s3 sync frontend/ s3://$BUCKET/
   ```
3. **Seed items:**
   ```bash
   cp items.example.csv items.csv   # edit with your stickers
   TABLE=$(aws cloudformation describe-stacks --stack-name <stack> \
     --query 'Stacks[0].Outputs[?OutputKey==`ItemsTableName`].OutputValue' --output text)
   node scripts/seed-items.mjs --csv items.csv --table "$TABLE" --owner-email you@example.com
   ```
4. **Generate stickers:**
   ```bash
   node scripts/generate-qr.mjs --csv items.csv \
     --base-url https://<cloudfront-domain> --out stickers --format both --sheet
   ```
   Open `stickers/stickers-sheet.html` and print it. Each sheet cell shows the QR code, the item ID, and the label.
5. `sam deploy` outputs print the **CloudFront URL** and the **API endpoint**.

## Local development

```bash
npm test        # handler tests, no AWS needed
npm run mock    # serves frontend/ + mocked API on http://localhost:8000
# then open http://localhost:8000/item/ABC123
```

## Configuration knobs

Lambda environment variables (set in `template.yaml`):

- `NOTIFY_EMAIL_ENABLED` / `NOTIFY_SMS_ENABLED` — set to `'false'` to stub notifications during bring-up (reports are still stored; failures are logged, never surfaced to finders).
- `SENDER_EMAIL` — SES sender address.

Per-item flags live in the `items` table: `notify_email` (default true), `notify_sms` (default false, requires `owner_phone`).

## Security & privacy notes

- The finder page and `GET /v1/item/{id}` return only `item_id`, `item_label`, `status`. Owner email/phone live only in DynamoDB and in the SES email that goes to the owner alone.
- Disabled or unknown IDs get an identical generic 404 — no data leak either way.
- The S3 bucket is private; only CloudFront (OAC, source-ARN-conditioned bucket policy) can read it.
- Finder input is sanitized (control characters stripped, length-capped) before storage and email.
- API access logs are kept for 30 days.

## Acceptance checklist

- [ ] QR scan opens `https://<cloudfront-domain>/item/{id}` over HTTPS (redirect-to-https is enforced).
- [ ] No owner personal data in page HTML, JS, or API responses (covered by tests).
- [ ] Valid submission stores a report in `reports` and emails the owner (SES sandbox: within seconds to verified addresses; production: within 60s).
- [ ] Unknown/disabled IDs show the generic page (covered by tests).
- [ ] 6th report in an hour from one IP gets `429` (covered by tests).
- [ ] `sam build && sam deploy --guided` works from a clean account.
- [ ] Cost at ~50 scans/month: within AWS Free Tier (Lambda 1M req/mo, DynamoDB 25GB, CloudFront 1TB/mo, CloudFront Functions 2M req/mo).

## Known deviations from the handoff

- **Runtime `nodejs22.x` instead of 20.x** — 20.x is deprecated for new AWS Lambda functions; 22.x is the drop-in replacement.
- **Rate limiting via a dedicated `rate_limits` TTL table** (HTTP APIs don't support usage plans, so the API-Gateway option from the spec isn't available).
- **Email body composed in the handler** instead of a managed SES Template resource — simpler, same content, one less thing to version.
- **`/v1/*` is routed through CloudFront** so the finder page calls the API same-origin; direct API Gateway access still works for testing.

## Out of scope (v1)

Owner accounts / self-service management, scan analytics dashboard, SMS-by-default, commercial lost-and-found integrations.

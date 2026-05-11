#!/usr/bin/env node

const assert = require('assert');

async function main() {
  const webAppUrl = process.env.GAS_WEB_APP_URL;
  if (!webAppUrl) {
    console.log('GAS_WEB_APP_URL is not set. Smoke test skipped.');
    return;
  }

  const url = new URL(webAppUrl);
  if (process.env.GAS_WEBHOOK_TOKEN) {
    url.searchParams.set('token', process.env.GAS_WEBHOOK_TOKEN);
  }

  const payload = {
    type: 'proofpack.ai_intake',
    source: 'lp',
    inquiry_id: `gha-smoke-${Date.now()}`,
    message: 'GitHub Actions GAS smoke test',
  };

  const response = await fetch(url.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    redirect: 'follow',
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`GAS smoke test HTTP ${response.status}: ${text.slice(0, 300)}`);
  }

  const parsed = JSON.parse(text);
  assert.strictEqual(parsed.ok, true);
  assert.strictEqual(parsed.status, 'ai_intake_recorded');
  assert.strictEqual(parsed.source, 'lp');

  console.log('GAS smoke test passed');
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});

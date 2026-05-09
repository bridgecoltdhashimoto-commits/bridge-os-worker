const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

function loadMain(overrides = {}) {
  const rows = [];
  const script = fs.readFileSync('main.gs', 'utf8');
  const context = {
    console,
    PropertiesService: {
      getScriptProperties() {
        return {
          getProperty(key) {
            return overrides.props && Object.prototype.hasOwnProperty.call(overrides.props, key)
              ? overrides.props[key]
              : '';
          },
        };
      },
    },
    Utilities: {
      Charset: { UTF_8: 'UTF-8' },
      DigestAlgorithm: { SHA_256: 'SHA-256' },
      computeDigest() {
        return [1, 2, 3];
      },
    },
    UrlFetchApp: overrides.UrlFetchApp,
    GmailApp: { sendEmail() {} },
  };
  context.global = context;
  vm.createContext(context);
  vm.runInContext(script, context, { filename: 'main.gs' });
  const sheet = {
    getLastColumn: () => 11,
    getRange: () => ({
      getValues: () => [[
        'created_at', 'payment_id', 'event_id', 'buyer_email', 'status', 'reason',
        'model', 'draft_hash', 'draft_text', 'review_required', 'raw_summary',
      ]],
    }),
    appendRow: (row) => rows.push(row),
  };
  return { context, rows, sheet };
}

{
  const { context, rows, sheet } = loadMain({ props: {} });
  const result = context.maybeCreateProofPackAiIntake_(sheet, { payment_id: 'p1', event_id: 'e1', raw_json: '{}' });
  assert.strictEqual(result.status, 'SKIPPED');
  assert.strictEqual(result.reason, 'feature_flag_disabled');
  assert.strictEqual(rows.length, 1);
}

{
  const { context, rows, sheet } = loadMain({ props: { PROOFPACK_AI_INTAKE_ENABLED: 'true' } });
  const result = context.maybeCreateProofPackAiIntake_(sheet, { payment_id: 'p1', event_id: 'e1', raw_json: '{}' });
  assert.strictEqual(result.status, 'SKIPPED');
  assert.strictEqual(result.reason, 'openai_api_key_missing');
  assert.strictEqual(rows.length, 1);
}

{
  const { context, rows, sheet } = loadMain({ props: { PROOFPACK_AI_INTAKE_ENABLED: 'true', OPENAI_API_KEY: 'test' } });
  const result = context.maybeCreateProofPackAiIntake_(sheet, { payment_id: 'p1', event_id: 'e1', raw_json: '{"memo":"返金相談"}' });
  assert.strictEqual(result.status, 'BLOCKED');
  assert.strictEqual(result.reason, 'sensitive_trouble_terms_in_input');
  assert.strictEqual(rows.length, 1);
}

{
  const { context, rows, sheet } = loadMain({
    props: { PROOFPACK_AI_INTAKE_ENABLED: 'true', OPENAI_API_KEY: 'test' },
    UrlFetchApp: {
      fetch() {
        return {
          getResponseCode: () => 200,
          getContentText: () => JSON.stringify({ output_text: '管理者確認用受付メモ\n- 購入確認済み\n- 専門家対応が必要な判断は対象外' }),
        };
      },
    },
  });
  const result = context.maybeCreateProofPackAiIntake_(sheet, { payment_id: 'p1', event_id: 'e1', raw_json: '{}' });
  assert.strictEqual(result.status, 'DRAFT_READY');
  assert.strictEqual(result.reason, 'admin_review_required_not_auto_sent');
  assert.strictEqual(rows.length, 1);
}

console.log('proofpack_ai_intake tests passed');

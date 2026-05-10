const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

const AI_INTAKE_HEADERS = [
  'created_at', 'updated_at', 'source', 'payment_id', 'event_id', 'buyer_email',
  'original_message', 'category', 'risk_level', 'reply_mode', 'draft_only',
  'review_required', 'status', 'reason', 'model', 'safety_model', 'draft_hash',
  'draft_json', 'draft_text', 'safety_notes', 'last_error', 'raw_summary',
];

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
    getLastColumn: () => AI_INTAKE_HEADERS.length,
    getRange: () => ({ getValues: () => [AI_INTAKE_HEADERS] }),
    appendRow: (row) => rows.push(row),
  };
  return { context, rows, sheet };
}

function rowObject(row) {
  return Object.fromEntries(AI_INTAKE_HEADERS.map((header, index) => [header, row[index]]));
}

function responseJson(output) {
  return {
    getResponseCode: () => 200,
    getContentText: () => JSON.stringify({ output_text: JSON.stringify(output) }),
  };
}

{
  const { context, rows, sheet } = loadMain({ props: {} });
  const result = context.maybeCreateProofPackAiIntake_(sheet, { payment_id: 'p1', event_id: 'e1', raw_json: '{}' });
  const row = rowObject(rows[0]);
  assert.strictEqual(result.status, 'SKIPPED');
  assert.strictEqual(result.reason, 'feature_flag_disabled');
  assert.strictEqual(result.reply_mode, 'draft_only');
  assert.strictEqual(row.draft_only, 'TRUE');
  assert.strictEqual(row.review_required, 'TRUE');
  assert.strictEqual(rows.length, 1);
}

{
  const { context, rows, sheet } = loadMain({ props: { PROOFPACK_AI_INTAKE_ENABLED: 'true' } });
  const result = context.maybeCreateProofPackAiIntake_(sheet, { payment_id: 'p1', event_id: 'e1', raw_json: '{}' });
  const row = rowObject(rows[0]);
  assert.strictEqual(result.status, 'SKIPPED');
  assert.strictEqual(result.reason, 'openai_api_key_missing');
  assert.strictEqual(row.last_error, '');
  assert.strictEqual(rows.length, 1);
}

{
  const { context, rows, sheet } = loadMain({ props: { PROOFPACK_AI_INTAKE_ENABLED: 'true', OPENAI_API_KEY: 'test' } });
  const result = context.maybeCreateProofPackAiIntake_(sheet, {
    source: 'line',
    payment_id: 'p1',
    event_id: 'e1',
    original_message: '返金相談です',
    raw_json: '{}',
  });
  const row = rowObject(rows[0]);
  assert.strictEqual(result.status, 'BLOCKED');
  assert.strictEqual(result.reason, 'sensitive_trouble_terms_in_input');
  assert.strictEqual(row.source, 'line');
  assert.strictEqual(row.category, 'sensitive_trouble');
  assert.strictEqual(row.risk_level, 'high');
  assert.strictEqual(row.draft_json, '');
  assert.strictEqual(rows.length, 1);
}

{
  let fetchCount = 0;
  const answer = {
    category: 'purchase_intake',
    risk_level: 'low',
    reply_mode: 'draft_only',
    draft_only: true,
    review_required: true,
    reply_draft: '管理者確認用受付メモです。納品状況を確認してください。',
    next_action_button_label: '内容を確認して本人判断で進める',
    safety_notes: '回答AI初期確認済み',
  };
  const safety = {
    safe_to_log: true,
    safe_to_send: false,
    blocked: false,
    category: 'purchase_intake',
    risk_level: 'low',
    reply_mode: 'draft_only',
    draft_only: true,
    review_required: true,
    safety_notes: '安全チェックAI確認済み',
  };
  const { context, rows, sheet } = loadMain({
    props: { PROOFPACK_AI_INTAKE_ENABLED: 'true', OPENAI_API_KEY: 'test' },
    UrlFetchApp: {
      fetch() {
        fetchCount += 1;
        return fetchCount === 1 ? responseJson(answer) : responseJson(safety);
      },
    },
  });
  const result = context.maybeCreateProofPackAiIntake_(sheet, { source: 'gmail', payment_id: 'p1', event_id: 'e1', raw_json: '{}' });
  const row = rowObject(rows[0]);
  const draft = JSON.parse(row.draft_json);
  assert.strictEqual(fetchCount, 2);
  assert.strictEqual(result.status, 'DRAFT_READY');
  assert.strictEqual(result.reason, 'draft_only_admin_review_required');
  assert.strictEqual(row.source, 'gmail');
  assert.strictEqual(row.category, 'purchase_intake');
  assert.strictEqual(row.risk_level, 'low');
  assert.strictEqual(row.reply_mode, 'draft_only');
  assert.strictEqual(row.draft_only, 'TRUE');
  assert.strictEqual(row.review_required, 'TRUE');
  assert.strictEqual(draft.schema_version, 'bridge_proofpack_ai_intake_v1');
  assert.strictEqual(draft.auto_send_allowed, false);
  assert.strictEqual(draft.next_action_button_label, '内容を確認して本人判断で進める');
  assert.strictEqual(rows.length, 1);
}

{
  let fetchCount = 0;
  const answer = {
    category: 'purchase_intake',
    risk_level: 'low',
    reply_mode: 'draft_only',
    draft_only: true,
    review_required: true,
    reply_draft: '管理者確認用受付メモです。',
    next_action_button_label: '内容を確認して本人判断で進める',
  };
  const safety = {
    safe_to_log: false,
    safe_to_send: false,
    blocked: true,
    category: 'sensitive_trouble',
    risk_level: 'high',
    reply_mode: 'draft_only',
    draft_only: true,
    review_required: true,
    safety_notes: '安全チェックAIでブロック',
  };
  const { context, rows, sheet } = loadMain({
    props: { PROOFPACK_AI_INTAKE_ENABLED: 'true', OPENAI_API_KEY: 'test' },
    UrlFetchApp: {
      fetch() {
        fetchCount += 1;
        return fetchCount === 1 ? responseJson(answer) : responseJson(safety);
      },
    },
  });
  const result = context.maybeCreateProofPackAiIntake_(sheet, { source: 'lp', payment_id: 'p1', event_id: 'e1', raw_json: '{}' });
  const row = rowObject(rows[0]);
  assert.strictEqual(fetchCount, 2);
  assert.strictEqual(result.status, 'BLOCKED');
  assert.strictEqual(result.reason, 'safety_ai_blocked');
  assert.strictEqual(row.source, 'lp');
  assert.strictEqual(row.risk_level, 'high');
  assert.strictEqual(row.draft_json, '');
  assert.strictEqual(rows.length, 1);
}

{
  const { context, rows, sheet } = loadMain({ props: {} });
  const payload = {
    type: 'proofpack.ai_intake',
    source: 'line',
    line_event_id: 'line-e1',
    message: '納品URLについて質問です',
  };
  assert.strictEqual(context.isProofPackExternalAiIntakePayload_(payload), true);
  const result = context.recordProofPackExternalAiIntake_(sheet, payload, JSON.stringify(payload));
  const row = rowObject(rows[0]);
  assert.strictEqual(result.status, 'SKIPPED');
  assert.strictEqual(result.reason, 'feature_flag_disabled');
  assert.strictEqual(row.source, 'line');
  assert.strictEqual(row.event_id, 'line-e1');
  assert.strictEqual(row.original_message, '納品URLについて質問です');
  assert.strictEqual(row.raw_summary.includes('source=line'), true);
  assert.strictEqual(rows.length, 1);
}

{
  const { context, rows, sheet } = loadMain({ props: { PROOFPACK_AI_INTAKE_ENABLED: 'true', OPENAI_API_KEY: 'test' } });
  const payload = {
    type: 'proofpack.ai_intake',
    source: 'gmail',
    message_id: 'gmail-m1',
    email: 'customer@example.com',
    subject: '返金について',
    body: '納品URLを確認したいです',
  };
  assert.strictEqual(context.isProofPackExternalAiIntakePayload_(payload), true);
  const result = context.recordProofPackExternalAiIntake_(sheet, payload, JSON.stringify(payload));
  const row = rowObject(rows[0]);
  assert.strictEqual(result.status, 'BLOCKED');
  assert.strictEqual(result.reason, 'sensitive_trouble_terms_in_input');
  assert.strictEqual(row.source, 'gmail');
  assert.strictEqual(row.event_id, 'gmail-m1');
  assert.strictEqual(row.buyer_email, 'customer@example.com');
  assert.strictEqual(row.category, 'sensitive_trouble');
  assert.strictEqual(row.risk_level, 'high');
  assert.strictEqual(row.draft_json, '');
  assert.strictEqual(rows.length, 1);
}

{
  const { context } = loadMain({ props: {} });
  assert.strictEqual(context.isProofPackExternalAiIntakePayload_({ source: 'square', type: 'payment.updated', message: 'x' }), false);
  assert.strictEqual(context.isProofPackExternalAiIntakePayload_({ source: 'lp', type: 'proofpack.ai_intake', inquiry: '問い合わせです' }), true);
}

console.log('proofpack_ai_intake tests passed');

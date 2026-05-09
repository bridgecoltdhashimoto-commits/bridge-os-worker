/**
 * Stage 1 + Stage 2 + Stage 3 (minimal):
 * Square -> Worker -> GAS -> Sheets -> Gmail
 * Stage 3: Fulfillment Queue placeholder processing
 */
function doPost(e) {
  const props = PropertiesService.getScriptProperties();
  const expectedToken = props.getProperty('WEBHOOK_TOKEN');
  const adminEmail = props.getProperty('ADMIN_EMAIL');
  const ss = getSpreadsheet_();
  const sheets = ensureSystemSheets_(ss);
  const logSheet = sheets.squareLogs;

  try {
    const receivedToken = (e && e.parameter && e.parameter.token) ? e.parameter.token : '';
    if (!expectedToken || receivedToken !== expectedToken) {
      logSheet.appendRow([new Date(), 'UNAUTHORIZED', '', '', '', 'invalid token']);
      return jsonResponse_({ ok: false, reason: 'unauthorized' });
    }

    const rawData = (e && e.postData && e.postData.contents) ? e.postData.contents : '{}';
    const payload = JSON.parse(rawData);

    const eventId = payload.event_id || '';
    const eventType = payload.type || '';
    const payment = payload.data && payload.data.object && payload.data.object.payment ? payload.data.object.payment : {};
    const amount = payment.amount_money && typeof payment.amount_money.amount !== 'undefined'
      ? Number(payment.amount_money.amount)
      : '';
    const currency = payment.amount_money && payment.amount_money.currency ? payment.amount_money.currency : '';
    const paymentId = payment.id || '';
    const paymentStatus = payment.status || '';
    const buyerEmail = extractBuyerEmail_(payload, payment);

    if (eventType !== 'payment.updated') {
      return jsonResponse_({ ok: true, status: 'ignored', reason: 'non_target_event' });
    }

    if (paymentStatus !== 'COMPLETED') {
      return jsonResponse_({ ok: true, status: 'ignored', reason: 'non_completed_payment' });
    }

    if (paymentId && isPaymentIdAlreadyLogged_(logSheet, paymentId)) {
      return jsonResponse_({ ok: true, status: 'ignored', reason: 'duplicate_payment_id' });
    }

    logSheet.appendRow([new Date(), 'RECEIVED', eventId, eventType, paymentId, amount]);
    appendQueueIfNotExists_(sheets.queue, eventId, paymentId, buyerEmail, amount, currency, rawData);
    appendEvidence_(sheets.evidence, eventId, paymentId, rawData);
    appendRevenueAudit_(sheets.revenueAudit, eventId, paymentId, amount, currency, paymentStatus, buyerEmail);

    if (adminEmail) {
      GmailApp.sendEmail(
        adminEmail,
        '【BRIDGE OS TEST】Square 100円決済テスト完了',
        [
          'Square 100円決済テストの疎通が完了しました。',
          '',
          `event_id: ${eventId}`,
          `event_type: ${eventType}`,
          `payment_id: ${paymentId}`,
          `amount: ${amount}`,
          `received_at: ${new Date().toISOString()}`,
        ].join('\n')
      );
    }

    return jsonResponse_({ ok: true, status: 'recorded' });
  } catch (err) {
    logSheet.appendRow([new Date(), 'ERROR', '', '', '', String(err && err.message ? err.message : err)]);
    return jsonResponse_({ ok: false, reason: String(err && err.message ? err.message : err) });
  }
}

function getSpreadsheet_() {
  const props = PropertiesService.getScriptProperties();
  const ssId = props.getProperty('SHEET_ID');
  return ssId ? SpreadsheetApp.openById(ssId) : SpreadsheetApp.getActiveSpreadsheet();
}

function ensureSystemSheets_(ss) {
  return {
    squareLogs: getOrCreateSheetWithHeader_(ss, 'Square_Logs', ['Timestamp', 'Status', 'Event ID', 'Event Type', 'Payment ID', 'Amount']),
    queue: getOrCreateSheetWithHeader_(ss, 'System_Fulfillment_Queue', ['received_at', 'status', 'payment_id', 'event_id', 'buyer_email', 'amount', 'currency', 'raw_json', 'tries', 'last_error', 'updated_at', 'delivery_url', 'done_at']),
    evidence: getOrCreateSheetWithHeader_(ss, 'System_Evidence_Vault', ['received_at', 'provider', 'event_id', 'payment_id', 'type', 'payload_hash', 'raw_json']),
    revenueAudit: getOrCreateSheetWithHeader_(ss, 'System_Revenue_Audit', ['received_at', 'payment_id', 'event_id', 'amount', 'currency', 'status', 'buyer_email']),
    fulfillmentLog: getOrCreateSheetWithHeader_(ss, 'System_Fulfillment_Log', ['sent_at', 'payment_id', 'event_id', 'buyer_email', 'delivery_url', 'mail_subject', 'mail_body_hash', 'status', 'created_at']),
    fulfillmentDLQ: getOrCreateSheetWithHeader_(ss, 'System_Fulfillment_DLQ', ['event_id', 'payment_id', 'buyer_email', 'error', 'raw_row', 'timestamp']),
    aiIntakeLog: getOrCreateSheetWithHeader_(ss, 'System_AI_Intake_Log', ['created_at', 'updated_at', 'source', 'payment_id', 'event_id', 'buyer_email', 'original_message', 'category', 'risk_level', 'reply_mode', 'draft_only', 'review_required', 'status', 'reason', 'model', 'safety_model', 'draft_hash', 'draft_json', 'draft_text', 'safety_notes', 'last_error', 'raw_summary']),
  };
}

function getOrCreateSheetWithHeader_(ss, name, headers) {
  const sheet = ss.getSheetByName(name) || ss.insertSheet(name);

  if (sheet.getLastRow() === 0) {
    sheet.appendRow(headers);
    return sheet;
  }

  const lastColumn = sheet.getLastColumn();
  const existingHeaders = lastColumn > 0
    ? sheet.getRange(1, 1, 1, lastColumn).getValues()[0]
    : [];

  const existingHeaderSet = {};
  existingHeaders.forEach(function (header) {
    existingHeaderSet[String(header)] = true;
  });

  const missingHeaders = headers.filter(function (header) {
    return !existingHeaderSet[String(header)];
  });

  if (missingHeaders.length > 0) {
    const startCol = lastColumn + 1;
    sheet.getRange(1, startCol, 1, missingHeaders.length).setValues([missingHeaders]);
  }

  return sheet;
}

function isPaymentIdAlreadyLogged_(sheet, paymentId) {
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) {
    return false;
  }

  const paymentIdValues = sheet.getRange(2, 5, lastRow - 1, 1).getValues();
  return paymentIdValues.some(function (row) {
    return row[0] === paymentId;
  });
}

function appendQueueIfNotExists_(queueSheet, eventId, paymentId, buyerEmail, amount, currency, rawData) {
  if (paymentId && isPaymentIdExistsInQueue_(queueSheet, paymentId)) {
    return;
  }

  const now = new Date();
  queueSheet.appendRow([now.toISOString(), 'ENQUEUED', paymentId, eventId, buyerEmail, amount, currency, rawData, 0, '', now.toISOString()]);
}

function isPaymentIdExistsInQueue_(queueSheet, paymentId) {
  const lastRow = queueSheet.getLastRow();
  if (lastRow <= 1) {
    return false;
  }
  const values = queueSheet.getRange(2, 3, lastRow - 1, 1).getValues();
  return values.some(function (row) {
    return row[0] === paymentId;
  });
}

function appendEvidence_(evidenceSheet, eventId, paymentId, rawData) {
  const hashBytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, rawData, Utilities.Charset.UTF_8);
  const payloadHash = hashBytes.map(function (b) {
    const v = (b < 0) ? b + 256 : b;
    return ('0' + v.toString(16)).slice(-2);
  }).join('');

  evidenceSheet.appendRow([new Date().toISOString(), 'square', eventId, paymentId, 'payment.updated', payloadHash, rawData]);
}

function appendRevenueAudit_(auditSheet, eventId, paymentId, amount, currency, status, buyerEmail) {
  auditSheet.appendRow([new Date().toISOString(), paymentId, eventId, amount, currency, status, buyerEmail]);
}

function extractBuyerEmail_(payload, payment) {
  const candidates = [
    payment && payment.buyer_email_address,
    payment && payment.receipt_email,
    payment && payment.customer_details && payment.customer_details.email_address,
    payload && payload.data && payload.data.object && payload.data.object.customer && payload.data.object.customer.email_address,
  ];

  for (var i = 0; i < candidates.length; i++) {
    if (candidates[i]) {
      return String(candidates[i]);
    }
  }
  return '';
}

function STAGE3_manualTest() {
  return processFulfillmentQueue();
}

function processFulfillmentQueue() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    return { ok: false, reason: 'lock_not_acquired' };
  }

  const ss = getSpreadsheet_();
  const sheets = ensureSystemSheets_(ss);
  const queueSheet = sheets.queue;
  const logSheet = sheets.fulfillmentLog;
  const dlqSheet = sheets.fulfillmentDLQ;
  const aiIntakeLogSheet = sheets.aiIntakeLog;
  try {
    const values = queueSheet.getDataRange().getValues();
    if (values.length <= 1) {
      return { ok: true, processed: 0, failed: 0, skipped: 0 };
    }

    const headers = values[0];
    const col = getHeaderIndexMap_(headers);
    let processed = 0;
    let failed = 0;
    let skipped = 0;

    for (var i = 1; i < values.length; i++) {
      const row = values[i];
      const sheetRow = i + 1;
      const status = String(row[col.status] || '');
      const paymentId = String(row[col.payment_id] || '');
      const eventId = String(row[col.event_id] || '');
      const buyerEmail = String(row[col.buyer_email] || '');
      const rawJson = String(row[col.raw_json] || '');

      if (status !== 'ENQUEUED') {
        skipped++;
        continue;
      }

      try {
        const startedAt = new Date().toISOString();
        setCellByHeader_(queueSheet, sheetRow, col, 'status', 'PROCESSING');
        setCellByHeader_(queueSheet, sheetRow, col, 'updated_at', startedAt);

        const delivery = getDeliveryConfig_();
        const aiIntakeResult = maybeCreateProofPackAiIntake_(aiIntakeLogSheet, {
          source: 'square',
          payment_id: paymentId,
          event_id: eventId,
          buyer_email: buyerEmail,
          raw_json: rawJson,
          original_message: extractProofPackOriginalMessage_(rawJson),
        });
        if (!buyerEmail) {
          throw new Error('buyer_email is empty');
        }

        const mail = buildDeliveryMail_(delivery.shopName, delivery.deliveryUrl, delivery.supportFormUrl);
        GmailApp.sendEmail(buyerEmail, mail.subject, mail.body);
        notifyAdminOfProofPackAiIntake_(delivery.adminEmail, aiIntakeResult);

        const doneAt = new Date().toISOString();
        setCellByHeader_(queueSheet, sheetRow, col, 'delivery_url', delivery.deliveryUrl);
        setCellByHeader_(queueSheet, sheetRow, col, 'done_at', doneAt);
        setCellByHeader_(queueSheet, sheetRow, col, 'updated_at', doneAt);
        setCellByHeader_(queueSheet, sheetRow, col, 'status', 'DONE');
        appendFulfillmentLog_(logSheet, {
          sent_at: doneAt,
          payment_id: paymentId,
          event_id: eventId,
          buyer_email: buyerEmail,
          delivery_url: delivery.deliveryUrl,
          mail_subject: mail.subject,
          mail_body_hash: toSha256Hex_(mail.body),
          status: 'SENT',
          created_at: doneAt,
        });
        processed++;
      } catch (err) {
        failed++;
        const message = String(err && err.message ? err.message : err);
        const currentTries = Number(row[col.tries] || 0);
        const updatedAt = new Date().toISOString();

        safeSetCellByHeader_(queueSheet, sheetRow, col, 'tries', currentTries + 1);
        safeSetCellByHeader_(queueSheet, sheetRow, col, 'last_error', message);
        safeSetCellByHeader_(queueSheet, sheetRow, col, 'updated_at', updatedAt);
        safeSetCellByHeader_(queueSheet, sheetRow, col, 'status', 'ERROR');

        appendFulfillmentDlq_(dlqSheet, {
          event_id: eventId,
          payment_id: paymentId,
          buyer_email: buyerEmail,
          error: message,
          raw_row: JSON.stringify(row),
          timestamp: updatedAt,
        });
      }
    }

    return { ok: true, processed: processed, failed: failed, skipped: skipped };
  } finally {
    lock.releaseLock();
  }
}

function getHeaderIndexMap_(headers) {
  const map = {};
  headers.forEach(function (header, index) {
    map[String(header)] = index;
  });
  return map;
}

function setCellByHeader_(sheet, rowNumber, col, header, value) {
  if (typeof col[header] === 'undefined') {
    throw new Error('Missing required header: ' + header);
  }
  sheet.getRange(rowNumber, col[header] + 1).setValue(value);
}

function safeSetCellByHeader_(sheet, rowNumber, col, header, value) {
  if (typeof col[header] === 'undefined') {
    return;
  }
  sheet.getRange(rowNumber, col[header] + 1).setValue(value);
}

function appendFulfillmentLog_(logSheet, row) {
  appendRowByHeader_(logSheet, row);
}

function appendFulfillmentDlq_(dlqSheet, row) {
  appendRowByHeader_(dlqSheet, row);
}

function appendRowByHeader_(sheet, rowObj) {
  const lastColumn = sheet.getLastColumn();
  const headers = lastColumn > 0 ? sheet.getRange(1, 1, 1, lastColumn).getValues()[0] : [];
  const row = headers.map(function (header) {
    const key = String(header);
    return Object.prototype.hasOwnProperty.call(rowObj, key) ? rowObj[key] : '';
  });
  sheet.appendRow(row);
}

function getDeliveryConfig_() {
  const props = PropertiesService.getScriptProperties();
  const shopName = String(props.getProperty('SHOP_NAME') || 'BRIDGE OS');
  const deliveryUrl = String(props.getProperty('DELIVERY_URL') || '');
  const supportFormUrl = String(props.getProperty('SUPPORT_FORM_URL') || '');
  const adminEmail = String(props.getProperty('ADMIN_EMAIL') || '');
  if (!deliveryUrl) {
    throw new Error('DELIVERY_URL is required');
  }
  return { shopName: shopName, deliveryUrl: deliveryUrl, supportFormUrl: supportFormUrl, adminEmail: adminEmail };
}

function buildDeliveryMail_(shopName, deliveryUrl, supportFormUrl) {
  const subject = '【納品】BRIDGE ProofPack Starter ご購入ありがとうございます';
  const lines = [
    'このたびは「BRIDGE ProofPack Starter」をご購入いただき、誠にありがとうございます。',
    '',
    '以下URLより納品データをご確認ください。',
    '納品URL: ' + deliveryUrl,
    '',
    '【12点セット内容】',
    '01_取引前チェックリスト',
    '02_相手先確認シート',
    '03_未払い時系列整理シート',
    '04_取引条件確認シート',
    '05_見積前確認テンプレ',
    '06_受注確認テンプレ',
    '07_納品完了確認テンプレ',
    '08_変更・キャンセル確認テンプレ',
    '09_クレーム一次返信テンプレ',
    '10_LINE・メール証拠保存ルール',
    '11_専門家相談前の資料整理シート',
    '12_使い方・免責ガイド',
    '',
    '【使い方（かんたん3ステップ）】',
    'STEP1: テンプレートに時系列・金額・連絡内容を記入してください。',
    'STEP2: 関連資料を証拠ファイル目録に沿って整理し、保存してください。',
    'STEP3: サマリー作成ガイドに沿って要点をまとめ、提出前セルフチェックを実施してください。',
    '',
    '【ご案内】',
    '・本商品は、記録整理を補助するためのデジタルコンテンツです。',
    '・法律相談、債権回収、代理交渉その他の専門業務は提供しておりません。',
    '・サポートは納品不備（ファイル欠落・破損・URL不達）に限り対応いたします。',
    '',
    '発行元: 株式会社BRIDGE',
  ];
  if (supportFormUrl) {
    lines.push('納品不備のご連絡窓口: ' + supportFormUrl);
  }
  return { subject: subject, body: lines.join('\n') };
}


function maybeCreateProofPackAiIntake_(aiIntakeLogSheet, context) {
  const config = getProofPackAiIntakeConfig_();
  const normalizedContext = normalizeProofPackAiIntakeContext_(context);
  const now = new Date().toISOString();
  const baseRow = {
    created_at: now,
    updated_at: now,
    source: normalizedContext.source,
    payment_id: normalizedContext.payment_id,
    event_id: normalizedContext.event_id,
    buyer_email: normalizedContext.buyer_email,
    original_message: normalizedContext.original_message,
    category: 'unknown',
    risk_level: 'unknown',
    reply_mode: 'draft_only',
    draft_only: 'TRUE',
    review_required: 'TRUE',
    status: 'SKIPPED',
    reason: '',
    model: config.model,
    safety_model: config.safetyModel,
    draft_hash: '',
    draft_json: '',
    draft_text: '',
    safety_notes: '',
    last_error: '',
    raw_summary: summarizeProofPackRawJson_(normalizedContext.raw_json),
  };

  if (!config.enabled) {
    baseRow.reason = 'feature_flag_disabled';
    baseRow.safety_notes = 'AI受付はfeature flagで無効化されています。';
    appendRowByHeader_(aiIntakeLogSheet, baseRow);
    return baseRow;
  }

  if (!config.apiKey) {
    baseRow.reason = 'openai_api_key_missing';
    baseRow.safety_notes = 'OpenAI API key未設定のためAI受付のみスキップしました。納品フローは継続します。';
    appendRowByHeader_(aiIntakeLogSheet, baseRow);
    return baseRow;
  }

  if (containsProofPackSensitiveTroubleTerms_(normalizedContext.original_message || normalizedContext.raw_json)) {
    baseRow.status = 'BLOCKED';
    baseRow.reason = 'sensitive_trouble_terms_in_input';
    baseRow.category = 'sensitive_trouble';
    baseRow.risk_level = 'high';
    baseRow.safety_notes = '入力に未払い・クレーム・返金・法的トラブル関連の禁止語を検出したため、回答ドラフトは作成しません。';
    appendRowByHeader_(aiIntakeLogSheet, baseRow);
    return baseRow;
  }

  let answerDraft;
  try {
    answerDraft = createProofPackAnswerDraft_(config, normalizedContext, baseRow.raw_summary);
  } catch (err) {
    baseRow.status = 'ERROR';
    baseRow.reason = 'answer_ai_error';
    baseRow.last_error = String(err && err.message ? err.message : err).slice(0, 300);
    appendRowByHeader_(aiIntakeLogSheet, baseRow);
    return baseRow;
  }

  baseRow.category = normalizeProofPackCategory_(answerDraft.category);
  baseRow.risk_level = normalizeProofPackRiskLevel_(answerDraft.risk_level);
  baseRow.reply_mode = 'draft_only';

  let safetyReview;
  try {
    safetyReview = createProofPackSafetyReview_(config, normalizedContext, answerDraft);
  } catch (err) {
    baseRow.status = 'ERROR';
    baseRow.reason = 'safety_ai_error';
    baseRow.last_error = String(err && err.message ? err.message : err).slice(0, 300);
    appendRowByHeader_(aiIntakeLogSheet, baseRow);
    return baseRow;
  }

  baseRow.category = normalizeProofPackCategory_(safetyReview.category || answerDraft.category);
  baseRow.risk_level = normalizeProofPackRiskLevel_(safetyReview.risk_level || answerDraft.risk_level);
  baseRow.safety_notes = String(safetyReview.safety_notes || '');

  const deterministicBlockReason = getProofPackDeterministicBlockReason_(normalizedContext, answerDraft);
  const blockedBySafetyAi = safetyReview.blocked === true ||
    safetyReview.safe_to_log !== true ||
    safetyReview.safe_to_send !== false ||
    safetyReview.reply_mode !== 'draft_only' ||
    safetyReview.draft_only !== true ||
    safetyReview.review_required !== true;
  if (deterministicBlockReason || blockedBySafetyAi) {
    baseRow.status = 'BLOCKED';
    baseRow.reason = deterministicBlockReason || 'safety_ai_blocked';
    baseRow.category = baseRow.category === 'unknown' ? 'sensitive_trouble' : baseRow.category;
    baseRow.risk_level = 'high';
    baseRow.safety_notes = [baseRow.safety_notes, deterministicBlockReason].filter(Boolean).join(' / ');
    appendRowByHeader_(aiIntakeLogSheet, baseRow);
    return baseRow;
  }

  const structuredDraft = buildProofPackStructuredDraft_(answerDraft, safetyReview, normalizedContext);
  const draftJson = JSON.stringify(structuredDraft);
  baseRow.status = 'DRAFT_READY';
  baseRow.reason = 'draft_only_admin_review_required';
  baseRow.category = structuredDraft.category;
  baseRow.risk_level = structuredDraft.risk_level;
  baseRow.reply_mode = structuredDraft.reply_mode;
  baseRow.draft_only = structuredDraft.draft_only ? 'TRUE' : 'FALSE';
  baseRow.review_required = structuredDraft.review_required ? 'TRUE' : 'FALSE';
  baseRow.draft_json = draftJson;
  baseRow.draft_text = structuredDraft.reply_draft;
  baseRow.draft_hash = toSha256Hex_(draftJson);
  appendRowByHeader_(aiIntakeLogSheet, baseRow);
  return baseRow;
}

function normalizeProofPackAiIntakeContext_(context) {
  const rawJson = String((context && context.raw_json) || '');
  return {
    source: normalizeProofPackSource_((context && context.source) || 'square'),
    payment_id: String((context && context.payment_id) || ''),
    event_id: String((context && context.event_id) || ''),
    buyer_email: String((context && context.buyer_email) || ''),
    raw_json: rawJson,
    original_message: String((context && context.original_message) || extractProofPackOriginalMessage_(rawJson)),
  };
}

function normalizeProofPackSource_(source) {
  const value = String(source || '').toLowerCase();
  const allowed = ['square', 'line', 'gmail', 'lp', 'manual', 'unknown'];
  return allowed.indexOf(value) >= 0 ? value : 'unknown';
}

function getProofPackAiIntakeConfig_() {
  const props = PropertiesService.getScriptProperties();
  const model = String(props.getProperty('PROOFPACK_AI_INTAKE_MODEL') || 'gpt-4o-mini');
  return {
    enabled: String(props.getProperty('PROOFPACK_AI_INTAKE_ENABLED') || 'false').toLowerCase() === 'true',
    apiKey: String(props.getProperty('OPENAI_API_KEY') || ''),
    model: model,
    safetyModel: String(props.getProperty('PROOFPACK_AI_SAFETY_MODEL') || model),
    endpoint: String(props.getProperty('OPENAI_RESPONSES_URL') || 'https://api.openai.com/v1/responses'),
  };
}

function createProofPackAnswerDraft_(config, context, rawSummary) {
  const prompt = buildProofPackAnswerDraftPrompt_(context, rawSummary);
  const parsed = callOpenAiJsonForProofPack_(config, config.model, prompt);
  return normalizeProofPackAnswerDraft_(parsed);
}

function createProofPackSafetyReview_(config, context, answerDraft) {
  const prompt = buildProofPackSafetyReviewPrompt_(context, answerDraft);
  const parsed = callOpenAiJsonForProofPack_(config, config.safetyModel, prompt);
  return normalizeProofPackSafetyReview_(parsed);
}

function buildProofPackAnswerDraftPrompt_(context, rawSummary) {
  return [
    'あなたはBRIDGE ProofPack AI受付 v1の回答AIです。',
    '購入者へ自動送信しない管理者確認用ドラフトだけをStructured JSONで作成してください。',
    '必ずJSONオブジェクトのみを返してください。Markdownや説明文は禁止です。',
    '未払い、クレーム、返金、法的トラブルに関する文面・助言・交渉文・請求文は絶対に作らないでください。',
    'reply_modeは必ずdraft_only、draft_onlyはtrue、review_requiredはtrueにしてください。',
    '本人判断ボタン文言は「内容を確認して本人判断で進める」に固定してください。',
    'JSON schema: {"category":"purchase_intake|delivery_support|general_question|sensitive_trouble|unknown","risk_level":"low|medium|high","reply_mode":"draft_only","draft_only":true,"review_required":true,"reply_draft":"string","next_action_button_label":"内容を確認して本人判断で進める","safety_notes":"string"}',
    '',
    '受付情報:',
    'source: ' + context.source,
    'payment_id: ' + context.payment_id,
    'event_id: ' + context.event_id,
    'buyer_email_present: ' + (context.buyer_email ? 'yes' : 'no'),
    'original_message: ' + context.original_message,
    'raw_summary: ' + String(rawSummary || ''),
  ].join('\n');
}

function buildProofPackSafetyReviewPrompt_(context, answerDraft) {
  return [
    'あなたはBRIDGE ProofPack AI受付 v1の安全チェックAIです。',
    '回答AIのStructured JSONを検査し、購入者へ自動送信されないdraft_onlyであることを確認してください。',
    '未払い、クレーム、返金、法的トラブルに関する文面・助言・交渉文・請求文が含まれる場合はblocked=trueにしてください。',
    'safe_to_sendは常にfalseにしてください。このシステムではAI文面を自動送信しません。',
    '必ずJSONオブジェクトのみを返してください。Markdownや説明文は禁止です。',
    'JSON schema: {"safe_to_log":true,"safe_to_send":false,"blocked":false,"category":"purchase_intake|delivery_support|general_question|sensitive_trouble|unknown","risk_level":"low|medium|high","reply_mode":"draft_only","draft_only":true,"review_required":true,"safety_notes":"string"}',
    '',
    'source: ' + context.source,
    'original_message: ' + context.original_message,
    'answer_draft_json: ' + JSON.stringify(answerDraft),
  ].join('\n');
}

function callOpenAiJsonForProofPack_(config, model, prompt) {
  const response = UrlFetchApp.fetch(config.endpoint, {
    method: 'post',
    contentType: 'application/json',
    headers: {
      Authorization: 'Bearer ' + config.apiKey,
    },
    muteHttpExceptions: true,
    payload: JSON.stringify({
      model: model,
      input: prompt,
      temperature: 0.1,
      max_output_tokens: 700,
    }),
  });

  const code = response.getResponseCode();
  const body = response.getContentText();
  if (code < 200 || code >= 300) {
    throw new Error('openai_api_error_' + code + ': ' + body.slice(0, 300));
  }
  const text = extractOpenAiProofPackText_(JSON.parse(body));
  if (!text) {
    throw new Error('empty_ai_response');
  }
  return parseProofPackJsonObject_(text);
}

function parseProofPackJsonObject_(text) {
  const trimmed = String(text || '').trim();
  try {
    return JSON.parse(trimmed);
  } catch (_) {}

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced && fenced[1]) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch (_) {}
  }

  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    return JSON.parse(trimmed.slice(start, end + 1));
  }

  throw new Error('invalid_structured_json');
}

function normalizeProofPackAnswerDraft_(draft) {
  if (!draft || typeof draft !== 'object') {
    throw new Error('answer_json_not_object');
  }
  const replyDraft = String(draft.reply_draft || '').trim();
  if (!replyDraft) {
    throw new Error('answer_reply_draft_empty');
  }
  if (String(draft.reply_mode || '') !== 'draft_only' || draft.draft_only !== true || draft.review_required !== true) {
    throw new Error('answer_not_draft_only_or_review_required');
  }
  if (String(draft.next_action_button_label || '') !== '内容を確認して本人判断で進める') {
    throw new Error('answer_invalid_self_judgment_button_label');
  }
  return {
    category: normalizeProofPackCategory_(draft.category),
    risk_level: normalizeProofPackRiskLevel_(draft.risk_level),
    reply_mode: 'draft_only',
    draft_only: true,
    review_required: true,
    reply_draft: replyDraft,
    next_action_button_label: '内容を確認して本人判断で進める',
    safety_notes: String(draft.safety_notes || ''),
  };
}

function normalizeProofPackSafetyReview_(review) {
  if (!review || typeof review !== 'object') {
    throw new Error('safety_json_not_object');
  }
  return {
    safe_to_log: review.safe_to_log === true,
    safe_to_send: review.safe_to_send === true,
    blocked: review.blocked === true,
    category: normalizeProofPackCategory_(review.category),
    risk_level: normalizeProofPackRiskLevel_(review.risk_level),
    reply_mode: String(review.reply_mode || '') === 'draft_only' ? 'draft_only' : 'invalid',
    draft_only: review.draft_only === true,
    review_required: review.review_required === true,
    safety_notes: String(review.safety_notes || ''),
  };
}

function buildProofPackStructuredDraft_(answerDraft, safetyReview, context) {
  return {
    schema_version: 'bridge_proofpack_ai_intake_v1',
    source: context.source,
    category: normalizeProofPackCategory_(safetyReview.category || answerDraft.category),
    risk_level: normalizeProofPackRiskLevel_(safetyReview.risk_level || answerDraft.risk_level),
    reply_mode: 'draft_only',
    draft_only: true,
    review_required: true,
    auto_send_allowed: false,
    reply_draft: answerDraft.reply_draft,
    next_action_button_label: '内容を確認して本人判断で進める',
    safety_notes: String(safetyReview.safety_notes || answerDraft.safety_notes || ''),
  };
}

function normalizeProofPackCategory_(category) {
  const value = String(category || '').toLowerCase();
  const allowed = ['purchase_intake', 'delivery_support', 'general_question', 'sensitive_trouble', 'unknown'];
  return allowed.indexOf(value) >= 0 ? value : 'unknown';
}

function normalizeProofPackRiskLevel_(riskLevel) {
  const value = String(riskLevel || '').toLowerCase();
  const allowed = ['low', 'medium', 'high', 'unknown'];
  return allowed.indexOf(value) >= 0 ? value : 'unknown';
}

function getProofPackDeterministicBlockReason_(context, answerDraft) {
  if (containsProofPackSensitiveTroubleTerms_(context.original_message || context.raw_json)) {
    return 'sensitive_trouble_terms_in_input';
  }
  if (containsProofPackSensitiveTroubleTerms_(answerDraft.reply_draft)) {
    return 'sensitive_trouble_terms_in_answer_draft';
  }
  if (answerDraft.reply_mode !== 'draft_only' || answerDraft.draft_only !== true || answerDraft.review_required !== true) {
    return 'not_draft_only_or_review_required';
  }
  if (answerDraft.next_action_button_label !== '内容を確認して本人判断で進める') {
    return 'invalid_self_judgment_button_label';
  }
  return '';
}

function extractOpenAiProofPackText_(response) {
  if (!response) {
    return '';
  }
  if (response.output_text) {
    return String(response.output_text).trim();
  }
  if (response.output && response.output.length) {
    const parts = [];
    response.output.forEach(function (item) {
      if (!item || !item.content) {
        return;
      }
      item.content.forEach(function (content) {
        if (content && content.text) {
          parts.push(String(content.text));
        }
      });
    });
    return parts.join('\n').trim();
  }
  return '';
}

function extractProofPackOriginalMessage_(rawJson) {
  if (!rawJson) {
    return '';
  }
  try {
    const payload = JSON.parse(rawJson);
    const payment = payload.data && payload.data.object && payload.data.object.payment ? payload.data.object.payment : {};
    const candidates = [
      payload.message,
      payload.text,
      payload.body,
      payload.original_message,
      payload.inquiry,
      payload.question,
      payment.note,
      payment.buyer_note,
    ];
    for (var i = 0; i < candidates.length; i++) {
      if (candidates[i]) {
        return String(candidates[i]).slice(0, 2000);
      }
    }
  } catch (_) {}
  return '';
}

function summarizeProofPackRawJson_(rawJson) {
  if (!rawJson) {
    return '';
  }
  try {
    const payload = JSON.parse(rawJson);
    const payment = payload.data && payload.data.object && payload.data.object.payment ? payload.data.object.payment : {};
    const amount = payment.amount_money && typeof payment.amount_money.amount !== 'undefined' ? payment.amount_money.amount : '';
    const currency = payment.amount_money && payment.amount_money.currency ? payment.amount_money.currency : '';
    const status = payment.status || '';
    return ['type=' + String(payload.type || ''), 'payment_status=' + String(status), 'amount=' + String(amount), 'currency=' + String(currency)].join(', ');
  } catch (err) {
    return 'unparseable_raw_json';
  }
}

function containsProofPackSensitiveTroubleTerms_(text) {
  const normalized = String(text || '').toLowerCase();
  const blockedTerms = [
    '未払い',
    '未収',
    '滞納',
    '督促',
    '請求書未払い',
    'クレーム',
    '苦情',
    '返金',
    '返品',
    'キャンセル返金',
    '法的',
    '法律',
    '訴訟',
    '裁判',
    '弁護士',
    '内容証明',
    '債権回収',
    '代理交渉',
    'refund',
    'claim',
    'complaint',
    'legal',
    'lawsuit',
    'attorney',
    'lawyer',
  ];
  return blockedTerms.some(function (term) {
    return normalized.indexOf(term.toLowerCase()) !== -1;
  });
}

function notifyAdminOfProofPackAiIntake_(adminEmail, aiIntakeResult) {
  if (!adminEmail || !aiIntakeResult || aiIntakeResult.status !== 'DRAFT_READY') {
    return;
  }
  GmailApp.sendEmail(
    adminEmail,
    '【要確認】BRIDGE ProofPack AI受付ドラフトを作成しました',
    [
      'BRIDGE ProofPack AI受付 v1が管理者確認用ドラフトを作成しました。',
      'この内容は購入者へ自動送信していません。必ずSystem_AI_Intake_Logで確認してください。',
      '',
      'source: ' + aiIntakeResult.source,
      'category: ' + aiIntakeResult.category,
      'risk_level: ' + aiIntakeResult.risk_level,
      'reply_mode: ' + aiIntakeResult.reply_mode,
      'payment_id: ' + aiIntakeResult.payment_id,
      'event_id: ' + aiIntakeResult.event_id,
      'draft_hash: ' + aiIntakeResult.draft_hash,
    ].join('\n')
  );
}

function toSha256Hex_(text) {
  const hashBytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(text), Utilities.Charset.UTF_8);
  return hashBytes.map(function (b) {
    const v = b < 0 ? b + 256 : b;
    return ('0' + v.toString(16)).slice(-2);
  }).join('');
}

function jsonResponse_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

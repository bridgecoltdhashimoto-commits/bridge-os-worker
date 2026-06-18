/**
 * Stage 1 + Stage 2 + Stage 3 (minimal) - v18 direct panic context:
 * Square -> Worker -> GAS -> Sheets -> Gmail
 * Stage 3: Fulfillment Queue placeholder processing
 */
function doPost(e) {
  bridgeEnsurePanicProductMap_();

  /*
   * 重要：
   * PanicフォームPOSTとPanic対象Square webhookは、既存BRIDGE OSのキュー処理より前で処理する。
   *
   * 理由：
   * - フォームPOSTはWEBHOOK_TOKENではなく、Panic個別tokenで認証するため
   * - Panic側の関数は内部でLockServiceを使うため、既存BRIDGE OSのscript lock取得中に呼ぶと不安定になるため
   * - 対象外の既存ProofPack / estimate_frontは従来どおり既存キューへ流すため
   */

  var panicPost = panicHandleDoPost_(e);
  if (panicPost) return panicPost;

  var panicFallbackPost = bridgeHandlePanicFormPostFallback_(e);
  if (panicFallbackPost) return panicFallbackPost;

  let logSheet = null;

  try {
    const props = PropertiesService.getScriptProperties();
    const expectedToken = props.getProperty('WEBHOOK_TOKEN');
    const adminEmail = props.getProperty('ADMIN_EMAIL');
    const ss = getSpreadsheet_();
    const sheets = ensureSystemSheets_(ss);
    logSheet = sheets.squareLogs;

    const receivedToken = (e && e.parameter && e.parameter.token) ? e.parameter.token : '';
    if (!expectedToken || receivedToken !== expectedToken) {
      logSheet.appendRow([new Date(), 'UNAUTHORIZED', '', '', '', 'invalid token']);
      return jsonResponse_({ ok: false, reason: 'unauthorized' });
    }

    const rawData = (e && e.postData && e.postData.contents) ? e.postData.contents : '{}';
    const payload = JSON.parse(rawData);

    if (isProofPackExternalAiIntakePayload_(payload)) {
      const result = recordProofPackExternalAiIntake_(sheets.aiIntakeLog, payload, rawData);
      return jsonResponse_({ ok: true, status: 'ai_intake_recorded', source: result.source, intake_status: result.status, reason: result.reason });
    }

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
    const product = resolveProductFromPayment_(payload, payment, sheets.productMaster);

    if (eventType !== 'payment.updated') {
      return jsonResponse_({ ok: true, status: 'ignored', reason: 'non_target_event' });
    }

    if (paymentStatus !== 'COMPLETED') {
      return jsonResponse_({ ok: true, status: 'ignored', reason: 'non_completed_payment' });
    }

    /*
     * Panic対象商品の場合は、既存BRIDGE OSキューには入れず、Panic側へ直行する。
     * 既存Product_Masterでvariation_id判定済みの情報をpayloadへ補強してから渡す。
     * ここは既存BRIDGE OSのscript lockを取得する前に実行する。
     */
    var panicContext = bridgeResolvePanicContext_(payload, payment, buyerEmail, product);
    if (panicContext && panicContext.variation_id) {
      var panicWebhook = panicCreateFormForPayment_(panicContext);
      return panicJsonOutput_(panicWebhook);
    }

    /*
     * ここから先は既存BRIDGE OSの通常納品処理。
     * Panic対象外だけを既存キューへ入れる。
     */
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(30000)) {
      return jsonResponse_({ ok: false, reason: 'lock_not_acquired' });
    }

    try {
      if (paymentId && isPaymentIdAlreadyReceivedOrQueuedOrSent_(sheets, paymentId)) {
        return jsonResponse_({ ok: true, status: 'ignored', reason: 'duplicate_payment_id' });
      }

      logSheet.appendRow([new Date(), 'RECEIVED', eventId, eventType, paymentId, amount]);
      appendQueueIfNotExists_(sheets.queue, eventId, paymentId, buyerEmail, amount, currency, rawData, product);
      appendEvidence_(sheets.evidence, eventId, paymentId, rawData);
      appendRevenueAudit_(sheets.revenueAudit, eventId, paymentId, amount, currency, paymentStatus, buyerEmail, product);

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
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    if (logSheet) {
      logSheet.appendRow([new Date(), 'ERROR', '', '', '', String(err && err.message ? err.message : err)]);
    }
    return jsonResponse_({ ok: false, reason: String(err && err.message ? err.message : err) });
  }
}

/**
 * PanicフォームPOSTの補助分岐。
 *
 * PanicPdfAddon.gs側の panicHandleDoPost_(e) が action/mode を見て処理するが、
 * テストPOSTや一部ブラウザPOSTで action が欠落しても、
 * payment_id + token + Panicフォーム項目が揃っていればPanicフォームとして処理する。
 *
 * WEBHOOK_TOKEN認証とは別系統の購入者フォームtokenを使うため、
 * 既存Square webhook認証へ落とさない。
 */
function bridgeHandlePanicFormPostFallback_(e) {
  bridgeEnsurePanicProductMap_();

  if (!e || !e.parameter) {
    return null;
  }

  var params = e.parameter;
  var hasPaymentToken = !!(params.payment_id && params.token);
  var hasPanicFields = !!(
    params.current_issue ||
    params.relationship ||
    params.started_when ||
    params.amount_or_impact ||
    params.evidence ||
    params.biggest_problem_today ||
    params.danger_flag ||
    params.free_note ||
    params.display_name ||
    params.customer_email
  );
  var hasWebhookJson = !!(e.postData && e.postData.contents && String(e.postData.contents || '').trim().charAt(0) === '{');

  if (!hasPaymentToken || !hasPanicFields || hasWebhookJson) {
    return null;
  }

  try {
    var result = panicProcessFormSubmit_(panicBuildFormDataFromParameters_(params));
    return HtmlService.createHtmlOutput(panicBuildSubmitResultHtml_(result))
      .setTitle('BRIDGE 相談前整理フォーム');
  } catch (err) {
    return HtmlService.createHtmlOutput(panicBuildSubmitResultHtml_({
      ok: false,
      status: PANIC_STATUS.ERROR,
      error_message: String(err && err.message ? err.message : err)
    })).setTitle('BRIDGE 相談前整理フォーム');
  }
}


/**
 * Panic商品定義を既存PanicPdfAddon.gs側のPANIC_PRODUCT_MAPへ補完する。
 * 既存ファイル側で一部商品だけが登録されている場合でも、5商品すべてがPanic処理に入るようにする。
 */
function bridgeEnsurePanicProductMap_() {
  if (typeof PANIC_PRODUCT_MAP === 'undefined' || !PANIC_PRODUCT_MAP) {
    PANIC_PRODUCT_MAP = {};
  }

  var catalog = bridgeGetPanicCatalog_();
  for (var i = 0; i < catalog.length; i++) {
    var item = catalog[i];
    PANIC_PRODUCT_MAP[item.variation_id] = {
      product_key: item.product_key,
      sku: item.sku,
      price: item.price
    };
  }
}

function bridgeGetPanicCatalog_() {
  return [
    {
      product_key: 'panic_nav_1000',
      sku: 'BRIDGE-PANIC-NAV-1000',
      variation_id: 'AQ5KGY3VPS42RXMIIVTHVIBA',
      price: 1000
    },
    {
      product_key: 'panic_pack_9800',
      sku: 'BRIDGE-PANIC-PACK-9800',
      variation_id: '5WCLFAOXWKWF5LFYK2QMMRCE',
      price: 9800
    },
    {
      product_key: 'panic_sort_29800',
      sku: 'BRIDGE-PANIC-SORT-29800',
      variation_id: 'BSQTVUMUHNSDHXXIANPEE2ZJ',
      price: 29800
    },
    {
      product_key: 'panic_done_49800',
      sku: 'BRIDGE-PANIC-DONE-49800',
      variation_id: 'E3B3YP4SFRKOIJLRSXDJINDK',
      price: 49800
    },
    {
      product_key: 'biz_proof_148000',
      sku: 'BRIDGE-BIZ-PROOF-148000',
      variation_id: 'N6B26JXPKVLKVUXDKD6IPVBM',
      price: 148000
    }
  ];
}

/**
 * Product_MasterまたはpayloadからPanic対象のcontextを直接作る。
 * panicHandleSquareWebhookIfTarget_ の内部抽出に依存せず、5商品のvariation_idを確実に渡す。
 */
function bridgeResolvePanicContext_(payload, payment, buyerEmail, product) {
  bridgeEnsurePanicProductMap_();

  var productKey = product && product.product_key ? String(product.product_key) : '';
  var matchType = product && product.match_type ? String(product.match_type).toLowerCase() : '';
  var matchValue = product && product.match_value ? String(product.match_value) : '';
  var variationId = '';

  if (matchType === 'variation_id' && bridgeIsKnownPanicVariationId_(matchValue)) {
    variationId = matchValue;
  }

  if (!variationId) {
    variationId = bridgeFindKnownPanicVariationId_(payload);
  }

  if (!variationId && bridgeIsPanicProductKey_(productKey)) {
    variationId = bridgeVariationIdForPanicProductKey_(productKey);
  }

  if (!bridgeIsKnownPanicVariationId_(variationId)) {
    return null;
  }

  var catalogItem = bridgeGetPanicCatalogItemByVariationId_(variationId);
  if (!catalogItem) {
    return null;
  }

  var paymentId = payment && payment.id ? String(payment.id) : String((payload && (payload.payment_id || payload.paymentId)) || '');
  if (!paymentId && payload) {
    paymentId = String(panicFindFirstValueByKeys_(payload, ['payment_id', 'paymentId', 'id']) || '');
  }

  var email = buyerEmail || '';
  if (!email && payment) {
    email = payment.buyer_email_address || payment.receipt_email || '';
  }
  if (!email && payload) {
    email = payload.customer_email || payload.buyer_email_address || payload.email || '';
  }

  return {
    payment_id: paymentId,
    variation_id: variationId,
    product_key: catalogItem.product_key,
    sku: catalogItem.sku,
    price: catalogItem.price,
    customer_email: email,
    amount: payment && payment.amount_money ? payment.amount_money.amount : catalogItem.price,
    source: 'SQUARE_WEBHOOK'
  };
}

function bridgeGetPanicCatalogItemByVariationId_(variationId) {
  var catalog = bridgeGetPanicCatalog_();
  for (var i = 0; i < catalog.length; i++) {
    if (catalog[i].variation_id === String(variationId || '')) {
      return catalog[i];
    }
  }
  return null;
}

function bridgeVariationIdForPanicProductKey_(productKey) {
  var catalog = bridgeGetPanicCatalog_();
  for (var i = 0; i < catalog.length; i++) {
    if (catalog[i].product_key === String(productKey || '')) {
      return catalog[i].variation_id;
    }
  }
  return '';
}

/**
 * Panic webhook判定補強。
 *
 * Square payloadやテストpayloadの構造差で variation_id が深い位置にある場合でも、
 * Product_Masterで解決済みのvariation_id情報をPanic側へ確実に渡す。
 */
function bridgeBuildPanicWebhookPayload_(payload, payment, buyerEmail, product) {
  if (!payload || typeof payload !== 'object') {
    return payload;
  }

  var copy = JSON.parse(JSON.stringify(payload));
  var resolvedPaymentId = payment && payment.id ? String(payment.id) : String(copy.payment_id || copy.paymentId || '');
  var resolvedAmount = payment && payment.amount_money && typeof payment.amount_money.amount !== 'undefined'
    ? Number(payment.amount_money.amount)
    : (typeof copy.amount !== 'undefined' ? Number(copy.amount) : '');

  var productKey = product && product.product_key ? String(product.product_key) : '';
  var matchType = product && product.match_type ? String(product.match_type).toLowerCase() : '';
  var matchValue = product && product.match_value ? String(product.match_value) : '';
  var variationId = '';

  if (matchType === 'variation_id' && matchValue) {
    variationId = matchValue;
  }

  if (!variationId) {
    variationId = bridgeFindKnownPanicVariationId_(copy);
  }

  if (!bridgeIsPanicProductKey_(productKey) && !bridgeIsKnownPanicVariationId_(variationId)) {
    return copy;
  }

  copy.payment_id = copy.payment_id || resolvedPaymentId;
  copy.paymentId = copy.paymentId || resolvedPaymentId;
  copy.variation_id = variationId || copy.variation_id || '';
  copy.product_key = productKey || copy.product_key || '';
  copy.sku = product && product.notes ? String(product.notes) : (copy.sku || '');
  copy.customer_email = copy.customer_email || buyerEmail || '';
  copy.buyer_email_address = copy.buyer_email_address || buyerEmail || '';
  copy.amount = copy.amount || resolvedAmount;

  if (!copy.data) copy.data = {};
  if (!copy.data.object) copy.data.object = {};
  if (!copy.data.object.payment) copy.data.object.payment = payment || {};
  copy.data.object.payment.id = copy.data.object.payment.id || resolvedPaymentId;
  copy.data.object.payment.buyer_email_address = copy.data.object.payment.buyer_email_address || buyerEmail || '';
  if (!copy.data.object.payment.amount_money && resolvedAmount !== '') {
    copy.data.object.payment.amount_money = { amount: resolvedAmount, currency: 'JPY' };
  }

  if (!copy.data.object.order) {
    copy.data.object.order = {
      id: copy.data.object.payment.order_id || ('order_' + resolvedPaymentId),
      line_items: []
    };
  }
  if (!copy.data.object.order.line_items || !copy.data.object.order.line_items.length) {
    copy.data.object.order.line_items = [{
      name: productKey || copy.product_key || '',
      catalog_object_id: variationId || '',
      variation_id: variationId || '',
      quantity: '1',
      total_money: {
        amount: resolvedAmount || 0,
        currency: 'JPY'
      }
    }];
  }

  return copy;
}

function bridgeIsPanicProductKey_(productKey) {
  return [
    'panic_nav_1000',
    'panic_pack_9800',
    'panic_sort_29800',
    'panic_done_49800',
    'biz_proof_148000'
  ].indexOf(String(productKey || '')) >= 0;
}

function bridgeIsKnownPanicVariationId_(variationId) {
  return [
    'AQ5KGY3VPS42RXMIIVTHVIBA',
    '5WCLFAOXWKWF5LFYK2QMMRCE',
    'BSQTVUMUHNSDHXXIANPEE2ZJ',
    'E3B3YP4SFRKOIJLRSXDJINDK',
    'N6B26JXPKVLKVUXDKD6IPVBM'
  ].indexOf(String(variationId || '')) >= 0;
}

function bridgeFindKnownPanicVariationId_(value) {
  if (value === null || typeof value === 'undefined') {
    return '';
  }

  if (typeof value === 'string') {
    return bridgeIsKnownPanicVariationId_(value) ? value : '';
  }

  if (typeof value !== 'object') {
    return '';
  }

  if (Array.isArray(value)) {
    for (var i = 0; i < value.length; i++) {
      var foundInArray = bridgeFindKnownPanicVariationId_(value[i]);
      if (foundInArray) {
        return foundInArray;
      }
    }
    return '';
  }

  var keys = Object.keys(value);
  for (var k = 0; k < keys.length; k++) {
    var found = bridgeFindKnownPanicVariationId_(value[keys[k]]);
    if (found) {
      return found;
    }
  }

  return '';
}

function getSpreadsheet_() {
  const props = PropertiesService.getScriptProperties();
  const ssId = props.getProperty('SHEET_ID');
  return ssId ? SpreadsheetApp.openById(ssId) : SpreadsheetApp.getActiveSpreadsheet();
}

function ensureSystemSheets_(ss) {
  return {
    squareLogs: getOrCreateSheetWithHeader_(ss, 'Square_Logs', ['Timestamp', 'Status', 'Event ID', 'Event Type', 'Payment ID', 'Amount']),
    queue: getOrCreateSheetWithHeader_(ss, 'System_Fulfillment_Queue', ['received_at', 'status', 'payment_id', 'event_id', 'buyer_email', 'amount', 'currency', 'raw_json', 'tries', 'last_error', 'updated_at', 'delivery_url', 'done_at', 'product_key', 'product_name', 'match_type', 'match_value']),
    productMaster: getOrCreateSheetWithHeader_(ss, 'Product_Master', ['product_key', 'product_name', 'active', 'match_type', 'match_value', 'delivery_url', 'mail_subject', 'mail_body_template', 'support_url', 'notes', 'created_at', 'updated_at']),
    evidence: getOrCreateSheetWithHeader_(ss, 'System_Evidence_Vault', ['received_at', 'provider', 'event_id', 'payment_id', 'type', 'payload_hash', 'raw_json']),
    revenueAudit: getOrCreateSheetWithHeader_(ss, 'System_Revenue_Audit', ['received_at', 'payment_id', 'event_id', 'amount', 'currency', 'status', 'buyer_email', 'product_key', 'product_name']),
    fulfillmentLog: getOrCreateSheetWithHeader_(ss, 'System_Fulfillment_Log', ['sent_at', 'payment_id', 'event_id', 'buyer_email', 'delivery_url', 'mail_subject', 'mail_body_hash', 'status', 'created_at', 'product_key', 'product_name']),
    fulfillmentDLQ: getOrCreateSheetWithHeader_(ss, 'System_Fulfillment_DLQ', ['event_id', 'payment_id', 'buyer_email', 'error', 'raw_row', 'timestamp', 'product_key', 'product_name']),
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
  return isPaymentIdExistsInSquareLogs_(sheet, paymentId);
}

function isPaymentIdExistsInSquareLogs_(sheet, paymentId) {
  return isPaymentIdExistsInSheetColumn_(sheet, paymentId, 'Payment ID', 5);
}

function isPaymentIdExistsInQueue_(queueSheet, paymentId) {
  return isPaymentIdExistsInSheetColumn_(queueSheet, paymentId, 'payment_id', 3);
}

function isPaymentIdAlreadySent_(fulfillmentLogSheet, paymentId) {
  if (!paymentId || !fulfillmentLogSheet || fulfillmentLogSheet.getLastRow() <= 1) {
    return false;
  }

  const lastRow = fulfillmentLogSheet.getLastRow();
  const lastColumn = fulfillmentLogSheet.getLastColumn();
  const paymentIdColumn = getHeaderColumnNumber_(fulfillmentLogSheet, 'payment_id', 2);
  const statusColumn = getHeaderColumnNumber_(fulfillmentLogSheet, 'status', 8);
  if (!paymentIdColumn || !statusColumn) {
    return false;
  }

  const values = fulfillmentLogSheet.getRange(2, 1, lastRow - 1, lastColumn).getValues();
  const targetPaymentId = String(paymentId);
  return values.some(function (row) {
    return String(row[paymentIdColumn - 1] || '') === targetPaymentId &&
      String(row[statusColumn - 1] || '').toUpperCase() === 'SENT';
  });
}

function isPaymentIdAlreadyReceivedOrQueuedOrSent_(sheets, paymentId) {
  if (!paymentId || !sheets) {
    return false;
  }
  return isPaymentIdExistsInSquareLogs_(sheets.squareLogs, paymentId) ||
    isPaymentIdExistsInQueue_(sheets.queue, paymentId) ||
    isPaymentIdAlreadySent_(sheets.fulfillmentLog, paymentId);
}

function isPaymentIdExistsInSheetColumn_(sheet, paymentId, headerName, fallbackColumn) {
  if (!paymentId || !sheet || sheet.getLastRow() <= 1) {
    return false;
  }

  const columnNumber = getHeaderColumnNumber_(sheet, headerName, fallbackColumn);
  if (!columnNumber) {
    return false…8495 tokens truncated… source + '-' + toSha256Hex_(JSON.stringify(payload)).slice(0, 16);
}

function extractProofPackExternalEmail_(payload) {
  const candidates = [
    payload.buyer_email,
    payload.email,
    payload.from_email,
    payload.reply_to,
    payload.from && payload.from.email,
    payload.contact && payload.contact.email,
  ];
  for (var i = 0; i < candidates.length; i++) {
    if (candidates[i]) {
      return String(candidates[i]);
    }
  }
  return '';
}

function extractProofPackOriginalMessageFromPayload_(payload) {
  const candidates = [
    payload.original_message,
    payload.message,
    payload.text,
    payload.subject && payload.body ? String(payload.subject) + '\n' + String(payload.body) : '',
    payload.subject,
    payload.body,
    payload.inquiry,
    payload.question,
    payload.content,
    payload.description,
  ];
  for (var i = 0; i < candidates.length; i++) {
    if (candidates[i]) {
      return String(candidates[i]).slice(0, 2000);
    }
  }
  return '';
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
    const source = normalizeProofPackSource_(payload.source || payload.channel || payload.intake_source || '');
    const messagePresent = extractProofPackOriginalMessageFromPayload_(payload) ? 'yes' : 'no';
    return ['type=' + String(payload.type || ''), 'source=' + String(source || ''), 'message_present=' + messagePresent, 'payment_status=' + String(status), 'amount=' + String(amount), 'currency=' + String(currency)].join(', ');
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

/**
 * Web App GET entrypoint.
 *
 * - Panicフォーム表示は PanicPdfAddon.gs の panicHandleDoGet_(e) に渡す
 * - 通常アクセスでは OK を返す
 */
function doGet(e) {
  try {
    bridgeEnsurePanicProductMap_();
    var panicGet = panicHandleDoGet_(e);
    if (panicGet) return panicGet;

    return ContentService
      .createTextOutput('OK')
      .setMimeType(ContentService.MimeType.TEXT);
  } catch (err) {
    return ContentService
      .createTextOutput('ERROR: doGet failed: ' + (err && err.message ? err.message : err))
      .setMimeType(ContentService.MimeType.TEXT);
  }
}

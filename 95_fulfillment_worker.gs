var BRIDGEOS_FULFILLMENT_SPREADSHEET_ID = '17EbmZQpM7sNLDThGFJRJ65wK9gRacHtRx2ahFH_sjvI';
var BRIDGEOS_FULFILLMENT_MAX_ROWS = 5;
var BRIDGEOS_LITE_PRODUCT_KEY = 'proofpack_lite_1980';
var BRIDGEOS_LITE_PRODUCT_NAME = '未払い・取引トラブル 相談前整理パック Lite';
var BRIDGEOS_LITE_SKU = 'PROOFPACK_LITE_1980';
var BRIDGEOS_LITE_VARIATION_ID = 'ZLAQ3LFQDTMHMTTYWJUR5LKQ';
var BRIDGEOS_LITE_DELIVERY_URL = 'https://docs.google.com/spreadsheets/d/13HlWVhOUDcbrS5n8lkweOmzzPmeFW6RZrPFrDieoqQk/edit';
var BRIDGEOS_INTERNAL_TEST_EMAIL = 'bridge.co.ltd.hashimoto@gmail.com';

var BRIDGEOS_PRODUCT_HEADERS = [
  'product_key', 'product_name', 'active', 'match_type', 'match_value',
  'delivery_url', 'mail_subject', 'mail_body_template', 'support_url',
  'notes', 'created_at', 'updated_at'
];
var BRIDGEOS_QUEUE_HEADERS = [
  'received_at', 'status', 'payment_id', 'event_id', 'buyer_email',
  'amount', 'currency', 'raw_json', 'tries', 'last_error', 'updated_at',
  'delivery_url', 'done_at', 'product_key', 'product_name', 'match_type',
  'match_value'
];
var BRIDGEOS_LOG_HEADERS = [
  'sent_at', 'payment_id', 'event_id', 'buyer_email', 'delivery_url',
  'mail_subject', 'mail_body_hash', 'status', 'created_at', 'product_key',
  'product_name'
];
var BRIDGEOS_DLQ_HEADERS = [
  'event_id', 'payment_id', 'buyer_email', 'error', 'raw_row', 'timestamp',
  'product_key', 'product_name'
];
var BRIDGEOS_PROCESSABLE_STATUSES = {
  '': true,
  ENQUEUED: true,
  PENDING: true,
  QUEUED: true,
  READY: true
};
var BRIDGEOS_LITE_BLOCKLIST = [
  'https://square.link/u/2DMaPdjS',
  '4,980',
  '4980',
  'ProofPack Starter',
  'Full'
];

function BRIDGEOS_fulfillmentWorker() {
  return BRIDGEOS_withFulfillmentLock_(function () {
    return BRIDGEOS_processFulfillmentQueueInternal_();
  });
}

function BRIDGEOS_processFulfillmentQueue() {
  return BRIDGEOS_fulfillmentWorker();
}

function BRIDGEOS_installFulfillmentTrigger() {
  var triggers = ScriptApp.getProjectTriggers() || [];
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'BRIDGEOS_fulfillmentWorker') {
      Logger.log('BRIDGEOS_fulfillmentWorker trigger already exists.');
      return { ok: true, installed: false, reason: 'already_exists' };
    }
  }

  ScriptApp.newTrigger('BRIDGEOS_fulfillmentWorker')
    .timeBased()
    .everyMinutes(1)
    .create();
  Logger.log('Installed 1-minute trigger for BRIDGEOS_fulfillmentWorker.');
  return { ok: true, installed: true };
}

function BRIDGEOS_testProofPackLiteDryRun() {
  return BRIDGEOS_withFulfillmentLock_(function () {
    var spreadsheet = BRIDGEOS_openControlSpreadsheet_();
    var productSheet = BRIDGEOS_getRequiredSheet_(spreadsheet, 'Product_Master');
    var logSheet = BRIDGEOS_getRequiredSheet_(spreadsheet, 'System_Fulfillment_Log');
    var productMap = BRIDGEOS_requireHeaders_(productSheet, BRIDGEOS_PRODUCT_HEADERS, false);
    var logMap = BRIDGEOS_requireHeaders_(logSheet, BRIDGEOS_LOG_HEADERS, true);
    var product = BRIDGEOS_getLiteProduct_(productSheet, productMap, true);
    var testContext = {
      payment_id: 'DRY_RUN_' + String(new Date().getTime()),
      event_id: 'DRY_RUN',
      buyer_email: BRIDGEOS_INTERNAL_TEST_EMAIL,
      amount: '1980',
      currency: 'JPY',
      raw_json: ''
    };
    var mail = BRIDGEOS_buildDeliveryMail_(product, testContext);
    var result = BRIDGEOS_sendDeliveryMail_(mail, BRIDGEOS_INTERNAL_TEST_EMAIL);

    BRIDGEOS_appendFulfillmentLog_(logSheet, logMap, {
      sent_at: new Date().toISOString(),
      payment_id: testContext.payment_id,
      event_id: testContext.event_id,
      buyer_email: result.recipient,
      delivery_url: mail.delivery_url,
      mail_subject: mail.subject,
      mail_body_hash: BRIDGEOS_hashText_(mail.body),
      status: 'TEST_SENT',
      created_at: new Date().toISOString(),
      product_key: product.product_key,
      product_name: product.product_name
    });

    Logger.log('ProofPack Lite dry run sent to internal test address.');
    return {
      ok: true,
      status: 'TEST_SENT',
      recipient: result.recipient,
      product_key: product.product_key,
      queue_changed: false
    };
  });
}

function BRIDGEOS_processOneQueueRowForTest(paymentId) {
  var targetPaymentId = String(paymentId || '').trim();
  if (!targetPaymentId) {
    throw new Error('paymentId is required');
  }

  return BRIDGEOS_withFulfillmentLock_(function () {
    var sheets = BRIDGEOS_getFulfillmentSheets_(true);
    var product = BRIDGEOS_getLiteProduct_(sheets.product, sheets.productMap, true);
    var queueRow = BRIDGEOS_findQueueRowByPaymentId_(
      sheets.queue,
      sheets.queueMap,
      targetPaymentId
    );

    if (!queueRow) {
      throw new Error('Queue row not found for payment_id: ' + targetPaymentId);
    }
    if (!BRIDGEOS_PROCESSABLE_STATUSES[queueRow.status]) {
      throw new Error('Queue row is not processable. status=' + queueRow.status);
    }
    if (BRIDGEOS_normalizeEmail_(queueRow.buyer_email) !== BRIDGEOS_normalizeEmail_(BRIDGEOS_INTERNAL_TEST_EMAIL)) {
      throw new Error('Test send blocked: buyer_email is not the internal test address');
    }
    if (!BRIDGEOS_queueRowMatchesLite_(queueRow, product)) {
      throw new Error('Test send blocked: queue row is not ProofPack Lite');
    }
    if (BRIDGEOS_hasAlreadySent_(sheets.log, sheets.logMap, targetPaymentId)) {
      throw new Error('Test send blocked: payment_id is already recorded as SENT');
    }

    var mail = BRIDGEOS_buildDeliveryMail_(product, queueRow);
    var result = BRIDGEOS_sendDeliveryMail_(mail, BRIDGEOS_INTERNAL_TEST_EMAIL);
    var now = new Date().toISOString();
    BRIDGEOS_appendFulfillmentLog_(sheets.log, sheets.logMap, {
      sent_at: now,
      payment_id: queueRow.payment_id,
      event_id: queueRow.event_id,
      buyer_email: result.recipient,
      delivery_url: mail.delivery_url,
      mail_subject: mail.subject,
      mail_body_hash: BRIDGEOS_hashText_(mail.body),
      status: 'SENT',
      created_at: now,
      product_key: product.product_key,
      product_name: product.product_name
    });
    BRIDGEOS_updateQueueRowStatus_(sheets.queue, sheets.queueMap, queueRow.sheet_row, 'SENT', {
      last_error: '',
      updated_at: now,
      delivery_url: mail.delivery_url,
      done_at: now,
      product_key: product.product_key,
      product_name: product.product_name
    });

    Logger.log('ProofPack Lite test queue row sent and marked SENT: ' + targetPaymentId);
    return {
      ok: true,
      status: 'SENT',
      payment_id: targetPaymentId,
      recipient: result.recipient
    };
  });
}

function BRIDGEOS_processFulfillmentQueueInternal_() {
  var sheets = BRIDGEOS_getFulfillmentSheets_(true);
  var product = BRIDGEOS_getLiteProduct_(sheets.product, sheets.productMap, false);
  if (!product) {
    return { ok: true, processed: 0, failed: 0, skipped: 0, reason: 'lite_inactive_or_missing' };
  }

  var queueRows = BRIDGEOS_getPendingFulfillmentRows_(sheets.queue, sheets.queueMap);
  var processed = 0;
  var failed = 0;
  var skipped = 0;

  for (var i = 0; i < queueRows.length && processed + failed < BRIDGEOS_FULFILLMENT_MAX_ROWS; i++) {
    var queueRow = queueRows[i];
    if (!BRIDGEOS_queueRowMatchesLite_(queueRow, product)) {
      skipped++;
      continue;
    }

    try {
      if (BRIDGEOS_hasAlreadySent_(sheets.log, sheets.logMap, queueRow.payment_id)) {
        BRIDGEOS_updateQueueRowStatus_(sheets.queue, sheets.queueMap, queueRow.sheet_row, 'DUPLICATE_SKIPPED', {
          last_error: 'payment_id already recorded as SENT',
          updated_at: new Date().toISOString(),
          product_key: product.product_key,
          product_name: product.product_name
        });
        skipped++;
        continue;
      }

      if (!BRIDGEOS_isValidEmail_(queueRow.buyer_email)) {
        throw new Error('buyer_email is invalid');
      }

      var mail = BRIDGEOS_buildDeliveryMail_(product, queueRow);
      var result = BRIDGEOS_sendDeliveryMail_(mail, queueRow.buyer_email);
      var now = new Date().toISOString();
      BRIDGEOS_appendFulfillmentLog_(sheets.log, sheets.logMap, {
        sent_at: now,
        payment_id: queueRow.payment_id,
        event_id: queueRow.event_id,
        buyer_email: result.recipient,
        delivery_url: mail.delivery_url,
        mail_subject: mail.subject,
        mail_body_hash: BRIDGEOS_hashText_(mail.body),
        status: 'SENT',
        created_at: now,
        product_key: product.product_key,
        product_name: product.product_name
      });
      BRIDGEOS_updateQueueRowStatus_(sheets.queue, sheets.queueMap, queueRow.sheet_row, 'SENT', {
        last_error: '',
        updated_at: now,
        delivery_url: mail.delivery_url,
        done_at: now,
        product_key: product.product_key,
        product_name: product.product_name
      });
      processed++;
    } catch (error) {
      failed++;
      BRIDGEOS_recordQueueFailure_(sheets, queueRow, product, error);
    }
  }

  return {
    ok: failed === 0,
    processed: processed,
    failed: failed,
    skipped: skipped,
    max_rows: BRIDGEOS_FULFILLMENT_MAX_ROWS
  };
}

function BRIDGEOS_getFulfillmentSheets_(includeDlq) {
  var spreadsheet = BRIDGEOS_openControlSpreadsheet_();
  var result = {
    product: BRIDGEOS_getRequiredSheet_(spreadsheet, 'Product_Master'),
    queue: BRIDGEOS_getRequiredSheet_(spreadsheet, 'System_Fulfillment_Queue'),
    log: BRIDGEOS_getRequiredSheet_(spreadsheet, 'System_Fulfillment_Log')
  };
  result.productMap = BRIDGEOS_requireHeaders_(result.product, BRIDGEOS_PRODUCT_HEADERS, false);
  result.queueMap = BRIDGEOS_requireHeaders_(result.queue, BRIDGEOS_QUEUE_HEADERS, false);
  result.logMap = BRIDGEOS_requireHeaders_(result.log, BRIDGEOS_LOG_HEADERS, true);

  if (includeDlq) {
    result.dlq = BRIDGEOS_getRequiredSheet_(spreadsheet, 'System_Fulfillment_DLQ');
    result.dlqMap = BRIDGEOS_requireHeaders_(result.dlq, BRIDGEOS_DLQ_HEADERS, true);
  }
  return result;
}

function BRIDGEOS_getLiteProduct_(sheet, headerMap, allowInactive) {
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) {
    if (allowInactive) {
      throw new Error('Product_Master has no data rows');
    }
    return null;
  }

  var values = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues() || [];
  for (var i = 0; i < values.length; i++) {
    var row = BRIDGEOS_rowToObject_(values[i] || [], headerMap);
    if (String(row.product_key || '').trim() !== BRIDGEOS_LITE_PRODUCT_KEY) {
      continue;
    }
    if (!allowInactive && !BRIDGEOS_isTruthy_(row.active)) {
      return null;
    }

    var deliveryUrl = String(row.delivery_url || '').trim();
    if (deliveryUrl !== BRIDGEOS_LITE_DELIVERY_URL) {
      throw new Error('ProofPack Lite delivery_url does not match the approved URL');
    }
    row.product_name = String(row.product_name || BRIDGEOS_LITE_PRODUCT_NAME).trim();
    return row;
  }

  if (allowInactive) {
    throw new Error('Product_Master row not found: ' + BRIDGEOS_LITE_PRODUCT_KEY);
  }
  return null;
}

function BRIDGEOS_getPendingFulfillmentRows_(sheet, headerMap) {
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) {
    return [];
  }

  var values = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues() || [];
  var rows = [];
  for (var i = 0; i < values.length; i++) {
    var row = BRIDGEOS_rowToObject_(values[i] || [], headerMap);
    row.sheet_row = i + 2;
    row.status = String(row.status || '').trim().toUpperCase();
    if (BRIDGEOS_PROCESSABLE_STATUSES[row.status]) {
      rows.push(row);
    }
  }
  return rows;
}

function BRIDGEOS_findQueueRowByPaymentId_(sheet, headerMap, paymentId) {
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) {
    return null;
  }

  var values = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues() || [];
  for (var i = 0; i < values.length; i++) {
    var row = BRIDGEOS_rowToObject_(values[i] || [], headerMap);
    if (String(row.payment_id || '').trim() === paymentId) {
      row.sheet_row = i + 2;
      row.status = String(row.status || '').trim().toUpperCase();
      return row;
    }
  }
  return null;
}

function BRIDGEOS_queueRowMatchesLite_(queueRow, product) {
  if (String(queueRow.product_key || '').trim() === BRIDGEOS_LITE_PRODUCT_KEY) {
    return true;
  }

  var matchType = String(queueRow.match_type || '').trim().toLowerCase();
  var matchValue = String(queueRow.match_value || '').trim();
  if (matchType === 'variation_id' && matchValue === BRIDGEOS_LITE_VARIATION_ID) {
    return true;
  }
  if (matchType === 'sku' && matchValue.toUpperCase() === BRIDGEOS_LITE_SKU) {
    return true;
  }
  if (product && matchType === String(product.match_type || '').trim().toLowerCase() &&
      matchValue && matchValue === String(product.match_value || '').trim()) {
    return true;
  }

  var identifiers = BRIDGEOS_extractVariationAndSku_(BRIDGEOS_parseJsonSafe_(queueRow.raw_json));
  return identifiers.variation_id === BRIDGEOS_LITE_VARIATION_ID ||
    identifiers.sku.toUpperCase() === BRIDGEOS_LITE_SKU;
}

function BRIDGEOS_buildDeliveryMail_(product, queueRow) {
  if (!product || String(product.product_key || '') !== BRIDGEOS_LITE_PRODUCT_KEY) {
    throw new Error('ProofPack Lite product is required');
  }

  var deliveryUrl = String(product.delivery_url || '').trim();
  if (deliveryUrl !== BRIDGEOS_LITE_DELIVERY_URL) {
    throw new Error('ProofPack Lite delivery_url does not match the approved URL');
  }

  var tokens = {
    product_key: BRIDGEOS_LITE_PRODUCT_KEY,
    product_name: String(product.product_name || BRIDGEOS_LITE_PRODUCT_NAME),
    delivery_url: deliveryUrl,
    support_url: String(product.support_url || ''),
    buyer_email: String(queueRow && queueRow.buyer_email || ''),
    payment_id: String(queueRow && queueRow.payment_id || ''),
    event_id: String(queueRow && queueRow.event_id || '')
  };
  var defaultSubject = '【納品】' + BRIDGEOS_LITE_PRODUCT_NAME + ' ご購入ありがとうございます';
  var subject = BRIDGEOS_applyTemplate_(String(product.mail_subject || defaultSubject), tokens).trim();
  var configuredBody = BRIDGEOS_applyTemplate_(String(product.mail_body_template || ''), tokens).trim();
  var requiredBody = [
    'このたびは「' + tokens.product_name + '」をご購入いただき、ありがとうございます。',
    '',
    '納品URLはこちらです。',
    deliveryUrl,
    '',
    'このファイルは閲覧用です。Googleスプレッドシートの「ファイル」から「コピーを作成」を選び、ご自身のGoogle Driveにコピーしてご利用ください。',
    '',
    '【商品の位置づけ】',
    '本商品は、未払い・報酬未払い・取引トラブルについて、無料相談・弁護士相談・行政相談・取引相談の前に、事実・時系列・金額・証拠・連絡履歴と、相談時に話す内容を整理するための商品です。',
    '法律相談、税務判断、代理交渉、回収代行、解決保証を行うものではありません。',
    '',
    '危険、脅迫、暴力、自傷他害のおそれがある場合は、この商品の利用より先に警察・専門機関・公的窓口へ相談してください。',
    '',
    '株式会社BRIDGE'
  ].join('\n');
  var body = configuredBody ? configuredBody + '\n\n' + requiredBody : requiredBody;

  BRIDGEOS_assertLiteMailSafe_(subject, body);
  if (body.indexOf(BRIDGEOS_LITE_DELIVERY_URL) < 0) {
    throw new Error('ProofPack Lite delivery URL is missing from mail body');
  }
  return {
    subject: subject,
    body: body,
    delivery_url: deliveryUrl
  };
}

function BRIDGEOS_sendDeliveryMail_(mail, recipient) {
  var normalizedRecipient = BRIDGEOS_normalizeEmail_(recipient);
  if (!BRIDGEOS_isValidEmail_(normalizedRecipient)) {
    throw new Error('recipient email is invalid');
  }

  BRIDGEOS_assertLiteMailSafe_(mail.subject, mail.body);
  var quota = MailApp.getRemainingDailyQuota();
  if (quota < 1) {
    throw new Error('MailApp daily quota is exhausted');
  }
  MailApp.sendEmail(normalizedRecipient, mail.subject, mail.body);
  return { ok: true, recipient: normalizedRecipient, quota_before_send: quota };
}

function BRIDGEOS_assertLiteMailSafe_(subject, body) {
  var combined = String(subject || '') + '\n' + String(body || '');
  var lower = combined.toLowerCase();
  for (var i = 0; i < BRIDGEOS_LITE_BLOCKLIST.length; i++) {
    var blocked = BRIDGEOS_LITE_BLOCKLIST[i];
    if (lower.indexOf(String(blocked).toLowerCase()) >= 0) {
      throw new Error('Lite mail contains blocked text: ' + blocked);
    }
  }
}

function BRIDGEOS_appendFulfillmentLog_(sheet, headerMap, rowObject) {
  BRIDGEOS_appendRowByHeader_(sheet, headerMap, rowObject);
}

function BRIDGEOS_appendFulfillmentDLQ_(sheet, headerMap, rowObject) {
  BRIDGEOS_appendRowByHeader_(sheet, headerMap, rowObject);
}

function BRIDGEOS_hasAlreadySent_(sheet, headerMap, paymentId) {
  if (!paymentId || sheet.getLastRow() <= 1) {
    return false;
  }
  var values = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues() || [];
  for (var i = 0; i < values.length; i++) {
    var row = BRIDGEOS_rowToObject_(values[i] || [], headerMap);
    if (String(row.payment_id || '') === String(paymentId) &&
        String(row.status || '').toUpperCase() === 'SENT') {
      return true;
    }
  }
  return false;
}

function BRIDGEOS_updateQueueRowStatus_(sheet, headerMap, rowNumber, status, patch) {
  var values = patch || {};
  values.status = status;
  var keys = Object.keys(values);
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    if (!Object.prototype.hasOwnProperty.call(headerMap, key)) {
      throw new Error('Queue header is missing: ' + key);
    }
    sheet.getRange(rowNumber, headerMap[key] + 1).setValue(values[key]);
  }
}

function BRIDGEOS_recordQueueFailure_(sheets, queueRow, product, error) {
  var message = String(error && error.message ? error.message : error);
  var tries = Number(queueRow.tries || 0) + 1;
  var now = new Date().toISOString();
  BRIDGEOS_updateQueueRowStatus_(sheets.queue, sheets.queueMap, queueRow.sheet_row, 'ERROR', {
    tries: tries,
    last_error: message,
    updated_at: now,
    product_key: product ? product.product_key : String(queueRow.product_key || ''),
    product_name: product ? product.product_name : String(queueRow.product_name || '')
  });
  BRIDGEOS_appendFulfillmentDLQ_(sheets.dlq, sheets.dlqMap, {
    event_id: String(queueRow.event_id || ''),
    payment_id: String(queueRow.payment_id || ''),
    buyer_email: String(queueRow.buyer_email || ''),
    error: message,
    raw_row: JSON.stringify(queueRow || {}),
    timestamp: now,
    product_key: product ? product.product_key : String(queueRow.product_key || ''),
    product_name: product ? product.product_name : String(queueRow.product_name || '')
  });
  Logger.log('Fulfillment error payment_id=' + String(queueRow.payment_id || '') + ': ' + message);
}

function BRIDGEOS_openControlSpreadsheet_() {
  return SpreadsheetApp.openById(BRIDGEOS_FULFILLMENT_SPREADSHEET_ID);
}

function BRIDGEOS_getRequiredSheet_(spreadsheet, name) {
  var sheet = spreadsheet.getSheetByName(name);
  if (!sheet) {
    throw new Error('Required sheet not found: ' + name);
  }
  return sheet;
}

function BRIDGEOS_requireHeaders_(sheet, requiredHeaders, initializeIfCompletelyEmpty) {
  if (!Array.isArray(requiredHeaders) || requiredHeaders.length === 0) {
    throw new Error('Required header definition is empty for sheet: ' + sheet.getName());
  }

  var lastRow = sheet.getLastRow();
  var lastColumn = sheet.getLastColumn();
  if (lastRow === 0 && lastColumn === 0) {
    if (!initializeIfCompletelyEmpty) {
      throw new Error('Required sheet is completely empty: ' + sheet.getName());
    }
    sheet.getRange(1, 1, 1, requiredHeaders.length).setValues([requiredHeaders]);
    lastRow = 1;
    lastColumn = requiredHeaders.length;
  }
  if (lastRow === 0 || lastColumn === 0) {
    throw new Error('Header row is missing from sheet: ' + sheet.getName());
  }

  var headerValues = sheet.getRange(1, 1, 1, lastColumn).getValues();
  var headers = headerValues && headerValues[0] ? headerValues[0] : [];
  var headerMap = BRIDGEOS_buildHeaderMap_(headers);
  var missing = [];
  for (var i = 0; i < requiredHeaders.length; i++) {
    if (!Object.prototype.hasOwnProperty.call(headerMap, requiredHeaders[i])) {
      missing.push(requiredHeaders[i]);
    }
  }
  if (missing.length > 0) {
    throw new Error('Missing required headers in ' + sheet.getName() + ': ' + missing.join(', '));
  }
  return headerMap;
}

function BRIDGEOS_buildHeaderMap_(headers) {
  var map = {};
  var safeHeaders = Array.isArray(headers) ? headers : [];
  for (var i = 0; i < safeHeaders.length; i++) {
    var key = String(safeHeaders[i] || '').trim();
    if (key) {
      map[key] = i;
    }
  }
  return map;
}

function BRIDGEOS_rowToObject_(row, headerMap) {
  var result = {};
  var safeRow = Array.isArray(row) ? row : [];
  var safeMap = headerMap && typeof headerMap === 'object' ? headerMap : {};
  var keys = Object.keys(safeMap);
  for (var i = 0; i < keys.length; i++) {
    result[keys[i]] = safeRow[safeMap[keys[i]]];
  }
  return result;
}

function BRIDGEOS_appendRowByHeader_(sheet, headerMap, rowObject) {
  var width = sheet.getLastColumn();
  if (width <= 0) {
    throw new Error('Cannot append to sheet without headers: ' + sheet.getName());
  }
  var row = [];
  for (var i = 0; i < width; i++) {
    row.push('');
  }
  var keys = Object.keys(rowObject || {});
  for (var j = 0; j < keys.length; j++) {
    var key = keys[j];
    if (!Object.prototype.hasOwnProperty.call(headerMap, key)) {
      throw new Error('Header is missing from ' + sheet.getName() + ': ' + key);
    }
    row[headerMap[key]] = rowObject[key];
  }
  sheet.appendRow(row);
}

function BRIDGEOS_parseJsonSafe_(rawJson) {
  if (rawJson && typeof rawJson === 'object') {
    return rawJson;
  }
  try {
    return JSON.parse(String(rawJson || '{}'));
  } catch (error) {
    return {};
  }
}

function BRIDGEOS_extractVariationAndSku_(payload) {
  var result = { variation_id: '', sku: '' };
  BRIDGEOS_scanIdentifiers_(payload, result, 0);
  return result;
}

function BRIDGEOS_scanIdentifiers_(value, result, depth) {
  if (!value || typeof value !== 'object' || depth > 8 || (result.variation_id && result.sku)) {
    return;
  }
  if (Array.isArray(value)) {
    for (var i = 0; i < value.length; i++) {
      BRIDGEOS_scanIdentifiers_(value[i], result, depth + 1);
    }
    return;
  }

  var variationKeys = ['variation_id', 'variationId', 'item_variation_id', 'catalog_object_id'];
  var skuKeys = ['sku', 'SKU'];
  var j;
  for (j = 0; j < variationKeys.length && !result.variation_id; j++) {
    if (value[variationKeys[j]]) {
      result.variation_id = String(value[variationKeys[j]]);
    }
  }
  for (j = 0; j < skuKeys.length && !result.sku; j++) {
    if (value[skuKeys[j]]) {
      result.sku = String(value[skuKeys[j]]);
    }
  }

  var keys = Object.keys(value);
  for (j = 0; j < keys.length; j++) {
    BRIDGEOS_scanIdentifiers_(value[keys[j]], result, depth + 1);
  }
}

function BRIDGEOS_applyTemplate_(template, tokens) {
  return String(template || '').replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, function (match, key) {
    return Object.prototype.hasOwnProperty.call(tokens, key) ? String(tokens[key]) : '';
  });
}

function BRIDGEOS_hashText_(text) {
  var value = String(text || '');
  var hash = 2166136261;
  for (var i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return ('00000000' + (hash >>> 0).toString(16)).slice(-8);
}

function BRIDGEOS_isTruthy_(value) {
  var normalized = String(value === true ? 'true' : value || '').trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'y';
}

function BRIDGEOS_normalizeEmail_(value) {
  return String(value || '').trim().toLowerCase();
}

function BRIDGEOS_isValidEmail_(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

function BRIDGEOS_withFulfillmentLock_(callback) {
  if (typeof callback !== 'function') {
    throw new Error('Fulfillment callback is required');
  }
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    return { ok: false, reason: 'lock_not_acquired' };
  }
  try {
    return callback();
  } finally {
    lock.releaseLock();
  }
}

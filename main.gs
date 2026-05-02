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
    fulfillmentLog: getOrCreateSheetWithHeader_(ss, 'System_Fulfillment_Log', ['timestamp', 'level', 'payment_id', 'event_id', 'message']),
    fulfillmentDLQ: getOrCreateSheetWithHeader_(ss, 'System_Fulfillment_DLQ', ['timestamp', 'payment_id', 'event_id', 'error_type', 'error_message', 'raw_json']),
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
  const ss = getSpreadsheet_();
  const sheets = ensureSystemSheets_(ss);
  const queueSheet = sheets.queue;
  const logSheet = sheets.fulfillmentLog;
  const dlqSheet = sheets.fulfillmentDLQ;
  const values = queueSheet.getDataRange().getValues();

  if (values.length <= 1) {
    appendFulfillmentLog_(logSheet, 'INFO', '', '', 'Stage3 queue processing skipped: no queue rows');
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
    const rawJson = String(row[col.raw_json] || '');

    if (status !== 'ENQUEUED') {
      skipped++;
      continue;
    }

    try {
      const startedAt = new Date().toISOString();
      setCellByHeader_(queueSheet, sheetRow, col, 'status', 'PROCESSING');
      setCellByHeader_(queueSheet, sheetRow, col, 'updated_at', startedAt);
      appendFulfillmentLog_(logSheet, 'INFO', paymentId, eventId, 'Stage3 fulfillment started');

      const doneAt = new Date().toISOString();
      setCellByHeader_(queueSheet, sheetRow, col, 'delivery_url', 'STAGE3_PLACEHOLDER_DELIVERY');
      setCellByHeader_(queueSheet, sheetRow, col, 'done_at', doneAt);
      setCellByHeader_(queueSheet, sheetRow, col, 'updated_at', doneAt);
      setCellByHeader_(queueSheet, sheetRow, col, 'status', 'DONE');

      appendFulfillmentLog_(logSheet, 'INFO', paymentId, eventId, 'Stage3 fulfillment completed with placeholder delivery');
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

      appendFulfillmentLog_(logSheet, 'ERROR', paymentId, eventId, message);
      dlqSheet.appendRow([updatedAt, paymentId, eventId, 'FULFILLMENT_ERROR', message, rawJson]);
    }
  }

  return { ok: true, processed: processed, failed: failed, skipped: skipped };
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

function appendFulfillmentLog_(logSheet, level, paymentId, eventId, message) {
  logSheet.appendRow([new Date().toISOString(), level, paymentId, eventId, message]);
}

function jsonResponse_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

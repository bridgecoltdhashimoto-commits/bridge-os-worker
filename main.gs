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
        if (!buyerEmail) {
          throw new Error('buyer_email is empty');
        }

        const mail = buildDeliveryMail_(delivery.shopName, delivery.deliveryUrl, delivery.supportFormUrl);
        GmailApp.sendEmail(buyerEmail, mail.subject, mail.body);

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

        dlqSheet.appendRow([eventId, paymentId, buyerEmail, message, JSON.stringify(row), updatedAt]);
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
  logSheet.appendRow([
    row.sent_at || '',
    row.payment_id || '',
    row.event_id || '',
    row.buyer_email || '',
    row.delivery_url || '',
    row.mail_subject || '',
    row.mail_body_hash || '',
    row.status || '',
    row.created_at || new Date().toISOString(),
  ]);
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
  const subject = '【' + shopName + '】ご購入コンテンツのご案内';
  const lines = [
    'このたびはご購入ありがとうございます。',
    '',
    '以下よりコンテンツをご利用ください。',
    deliveryUrl,
    '',
    '※個別相談・法的判断には対応しておりません。',
  ];
  if (supportFormUrl) {
    lines.push('お問い合わせフォーム: ' + supportFormUrl);
  }
  return { subject: subject, body: lines.join('\\n') };
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

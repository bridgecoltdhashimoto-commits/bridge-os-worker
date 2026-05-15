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

    if (paymentId && isPaymentIdAlreadyLogged_(logSheet, paymentId)) {
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
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) {
    return false;
  }

  const paymentIdValues = sheet.getRange(2, 5, lastRow - 1, 1).getValues();
  return paymentIdValues.some(function (row) {
    return row[0] === paymentId;
  });
}

function appendQueueIfNotExists_(queueSheet, eventId, paymentId, buyerEmail, amount, currency, rawData, product) {
  if (paymentId && isPaymentIdExistsInQueue_(queueSheet, paymentId)) {
    return;
  }

  const now = new Date();
  appendRowByHeader_(queueSheet, {
    received_at: now.toISOString(),
    status: 'ENQUEUED',
    payment_id: paymentId,
    event_id: eventId,
    buyer_email: buyerEmail,
    amount: amount,
    currency: currency,
    raw_json: rawData,
    tries: 0,
    last_error: '',
    updated_at: now.toISOString(),
    product_key: product && product.product_key ? product.product_key : 'UNKNOWN_PRODUCT',
    product_name: product && product.product_name ? product.product_name : '',
    match_type: product && product.match_type ? product.match_type : '',
    match_value: product && product.match_value ? product.match_value : '',
  });
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

function appendRevenueAudit_(auditSheet, eventId, paymentId, amount, currency, status, buyerEmail, product) {
  appendRowByHeader_(auditSheet, {
    received_at: new Date().toISOString(),
    payment_id: paymentId,
    event_id: eventId,
    amount: amount,
    currency: currency,
    status: status,
    buyer_email: buyerEmail,
    product_key: product && product.product_key ? product.product_key : 'UNKNOWN_PRODUCT',
    product_name: product && product.product_name ? product.product_name : '',
  });
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
  return processFulfillmentQueue_({ dryRun: false });
}

function processFulfillmentQueue_(options) {
  const dryRun = !!(options && options.dryRun);
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
        if (!dryRun) {
          setCellByHeader_(queueSheet, sheetRow, col, 'status', 'PROCESSING');
          setCellByHeader_(queueSheet, sheetRow, col, 'updated_at', startedAt);
        }

        const payload = parseJsonSafe_(rawJson);
        const payment = payload && payload.data && payload.data.object && payload.data.object.payment ? payload.data.object.payment : {};
        const product = resolveProductForQueueRow_(sheets.productMaster, row, col, payload, payment);
        if (!product || product.product_key === 'UNKNOWN_PRODUCT') {
          throw new Error('UNKNOWN_PRODUCT: product could not be resolved from Square payload');
        }
        const delivery = getDeliveryConfigForProduct_(product);
        const aiIntakeResult = (!dryRun && product.product_key === 'proofpack_starter') ? maybeCreateProofPackAiIntake_(aiIntakeLogSheet, {
          source: 'square',
          payment_id: paymentId,
          event_id: eventId,
          buyer_email: buyerEmail,
          raw_json: rawJson,
          original_message: extractProofPackOriginalMessage_(rawJson),
        }) : null;
        if (!buyerEmail) {
          throw new Error('buyer_email is empty');
        }

        const mail = buildDeliveryMailByProduct_(product, {
          shopName: delivery.shopName,
          deliveryUrl: delivery.deliveryUrl,
          supportFormUrl: delivery.supportFormUrl,
          buyerEmail: buyerEmail,
          paymentId: paymentId,
          eventId: eventId,
        });
        if (dryRun) {
          processed++;
          continue;
        }
        GmailApp.sendEmail(buyerEmail, mail.subject, mail.body);
        if (product.product_key === 'proofpack_starter') {
          notifyAdminOfProofPackAiIntake_(delivery.adminEmail, aiIntakeResult);
        }

        const doneAt = new Date().toISOString();
        safeSetCellByHeader_(queueSheet, sheetRow, col, 'product_key', product.product_key);
        safeSetCellByHeader_(queueSheet, sheetRow, col, 'product_name', product.product_name);
        safeSetCellByHeader_(queueSheet, sheetRow, col, 'match_type', product.match_type);
        safeSetCellByHeader_(queueSheet, sheetRow, col, 'match_value', product.match_value);
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
          product_key: product.product_key,
          product_name: product.product_name,
        });
        processed++;
      } catch (err) {
        failed++;
        const message = String(err && err.message ? err.message : err);
        if (dryRun) {
          continue;
        }
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
          product_key: typeof col.product_key !== 'undefined' ? String(row[col.product_key] || '') : '',
          product_name: typeof col.product_name !== 'undefined' ? String(row[col.product_name] || '') : '',
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
  const config = getBaseDeliverySettings_();
  if (!config.deliveryUrl) {
    throw new Error('DELIVERY_URL is required');
  }
  return config;
}

function getBaseDeliverySettings_() {
  const props = PropertiesService.getScriptProperties();
  return {
    shopName: String(props.getProperty('SHOP_NAME') || 'BRIDGE OS'),
    deliveryUrl: String(props.getProperty('DELIVERY_URL') || ''),
    supportFormUrl: String(props.getProperty('SUPPORT_FORM_URL') || ''),
    adminEmail: String(props.getProperty('ADMIN_EMAIL') || ''),
  };
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



function getDeliveryConfigForProduct_(product) {
  const base = getBaseDeliverySettings_();
  const deliveryUrl = String(product && product.delivery_url ? product.delivery_url : base.deliveryUrl);
  const supportFormUrl = String(product && product.support_url ? product.support_url : base.supportFormUrl);
  if (!deliveryUrl) {
    throw new Error('delivery_url is required for product: ' + String(product && product.product_key ? product.product_key : 'UNKNOWN_PRODUCT'));
  }
  return {
    shopName: base.shopName,
    deliveryUrl: deliveryUrl,
    supportFormUrl: supportFormUrl,
    adminEmail: base.adminEmail,
  };
}

function buildDeliveryMailByProduct_(product, context) {
  const deliveryUrl = String(context && context.deliveryUrl ? context.deliveryUrl : (product && product.delivery_url) || '');
  const supportFormUrl = String(context && context.supportFormUrl ? context.supportFormUrl : (product && product.support_url) || '');
  const productKey = String(product && product.product_key ? product.product_key : '');
  const productName = String(product && product.product_name ? product.product_name : '');
  const subjectTemplate = String(product && product.mail_subject ? product.mail_subject : '');
  const bodyTemplate = String(product && product.mail_body_template ? product.mail_body_template : '');

  if (productKey === 'proofpack_starter' && !subjectTemplate && !bodyTemplate) {
    return buildDeliveryMail_(context && context.shopName, deliveryUrl, supportFormUrl);
  }

  if (productKey === 'estimate_front' && !subjectTemplate && !bodyTemplate) {
    return buildEstimateFrontDeliveryMail_(productName, deliveryUrl, supportFormUrl);
  }

  const tokens = {
    shop_name: String(context && context.shopName ? context.shopName : 'BRIDGE OS'),
    product_key: productKey,
    product_name: productName,
    delivery_url: deliveryUrl,
    support_url: supportFormUrl,
    buyer_email: String(context && context.buyerEmail ? context.buyerEmail : ''),
    payment_id: String(context && context.paymentId ? context.paymentId : ''),
    event_id: String(context && context.eventId ? context.eventId : ''),
  };
  const subject = applyTemplate_(subjectTemplate || '【納品】' + productName + ' ご購入ありがとうございます', tokens);
  const body = bodyTemplate
    ? applyTemplate_(bodyTemplate, tokens)
    : buildGenericDeliveryMailBody_(tokens);
  return { subject: subject, body: body };
}

function buildEstimateFrontDeliveryMail_(productName, deliveryUrl, supportFormUrl) {
  const safeProductName = productName || 'BRIDGE 見積前受付フロント';
  const subject = '【納品】' + safeProductName + ' ご購入ありがとうございます';
  const lines = [
    'このたびは「' + safeProductName + '」をご購入いただき、誠にありがとうございます。',
    '',
    '以下URLより、購入者向け納品パッケージをご確認ください。',
    '納品URL: ' + deliveryUrl,
    '',
    '【納品パッケージ内容】',
    '01_導入チェックリスト',
    '02_受付フォーム項目テンプレート',
    '03_自動返信テンプレート',
    '04_運用ルール_免責',
    'Product_Master_見積前受付フロント_sample.csv',
    '',
    '【初回設定の流れ】',
    'STEP1: 導入チェックリストで事業者名、対応エリア、返信目安、予約金/着手金の方針を確認してください。',
    'STEP2: 受付フォーム項目テンプレートから、自社に必要な質問だけを選んでください。',
    'STEP3: 自動返信テンプレートを自社の営業時間、返信目安、注意事項に合わせて調整してください。',
    'STEP4: 本番公開前に、必ずテストモードまたは下書き確認で送信内容を確認してください。',
    '',
    '【ご案内】',
    '・本商品は、見積前の受付導線と情報整理を補助するデジタルコンテンツです。',
    '・工事可否、見積金額、契約条件、法律・税務判断は提供しておりません。',
    '・Square決済リンクや本番メール送信は、内容確認後に購入者または運用担当者が設定してください。',
    '・既存のBRIDGE ProofPack Starterとは別商品の納品パッケージです。',
    '',
    '発行元: 株式会社BRIDGE',
  ];
  if (supportFormUrl) {
    lines.push('納品不備のご連絡窓口: ' + supportFormUrl);
  }
  return { subject: subject, body: lines.join('\n') };
}

function buildGenericDeliveryMailBody_(tokens) {
  const lines = [
    'このたびは「' + tokens.product_name + '」をご購入いただき、誠にありがとうございます。',
    '',
    '以下URLより納品データをご確認ください。',
    '納品URL: ' + tokens.delivery_url,
    '',
    '発行元: 株式会社BRIDGE',
  ];
  if (tokens.support_url) {
    lines.push('納品不備のご連絡窓口: ' + tokens.support_url);
  }
  return lines.join('\n');
}

function applyTemplate_(template, tokens) {
  return String(template || '').replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, function (_, key) {
    return Object.prototype.hasOwnProperty.call(tokens, key) ? tokens[key] : '';
  });
}

function resolveProductForQueueRow_(productSheet, row, col, payload, payment) {
  const queuedProductKey = typeof col.product_key !== 'undefined' ? String(row[col.product_key] || '') : '';
  if (queuedProductKey && queuedProductKey !== 'UNKNOWN_PRODUCT') {
    const productFromMaster = findProductByKey_(getActiveProductRows_(productSheet), queuedProductKey);
    if (productFromMaster) {
      return productFromMaster;
    }
    if (queuedProductKey === 'proofpack_starter') {
      return getProofPackFallbackProduct_('queued', queuedProductKey);
    }
    return getUnknownProduct_();
  }
  return resolveProductFromPayment_(payload, payment, productSheet);
}

function resolveProductFromPayment_(payload, payment, productSheet) {
  const products = getActiveProductRows_(productSheet);
  const text = buildProductSearchText_(payload, payment);
  const amount = payment && payment.amount_money && typeof payment.amount_money.amount !== 'undefined'
    ? Number(payment.amount_money.amount)
    : '';

  const nonAmountMatch = findMatchingProduct_(products, text, amount, false);
  if (nonAmountMatch) {
    return nonAmountMatch;
  }

  const amountMatch = findMatchingProduct_(products, text, amount, true);
  if (amountMatch) {
    return amountMatch;
  }

  if (amount === 100) {
    return getProofPackFallbackProduct_('amount', '100');
  }

  return getUnknownProduct_();
}

function findMatchingProduct_(products, text, amount, amountOnly) {
  for (var i = 0; i < products.length; i++) {
    const product = products[i];
    const matchType = String(product.match_type || '').toLowerCase();
    const matchValue = String(product.match_value || '');
    if (!matchValue) {
      continue;
    }
    if (amountOnly) {
      if (matchType === 'amount' && Number(matchValue) === amount) {
        product.match_type = 'amount';
        product.match_value = matchValue;
        return product;
      }
      continue;
    }
    if (matchType === 'amount') {
      continue;
    }
    if ((matchType === 'product_key' || matchType === 'key') && text.indexOf(String(product.product_key || '').toLowerCase()) >= 0) {
      product.match_type = matchType;
      product.match_value = product.product_key;
      return product;
    }
    if ((matchType === 'product_name' || matchType === 'name') && text.indexOf(String(product.product_name || '').toLowerCase()) >= 0) {
      product.match_type = matchType;
      product.match_value = product.product_name;
      return product;
    }
    if (text.indexOf(matchValue.toLowerCase()) >= 0) {
      product.match_type = matchType || 'text';
      product.match_value = matchValue;
      return product;
    }
  }
  return null;
}

function getActiveProductRows_(productSheet) {
  if (!productSheet || productSheet.getLastRow() <= 1) {
    return [];
  }
  const values = productSheet.getDataRange().getValues();
  const headers = values[0];
  const col = getHeaderIndexMap_(headers);
  const products = [];
  for (var i = 1; i < values.length; i++) {
    const row = values[i];
    const active = String(row[col.active] || '').toLowerCase();
    const productKey = String(row[col.product_key] || '');
    if (!productKey || ['true', '1', 'yes', 'y'].indexOf(active) < 0) {
      continue;
    }
    products.push({
      product_key: productKey,
      product_name: String(row[col.product_name] || productKey),
      active: String(row[col.active] || ''),
      match_type: String(row[col.match_type] || ''),
      match_value: String(row[col.match_value] || ''),
      delivery_url: String(row[col.delivery_url] || ''),
      mail_subject: String(row[col.mail_subject] || ''),
      mail_body_template: String(row[col.mail_body_template] || ''),
      support_url: String(row[col.support_url] || ''),
      notes: String(row[col.notes] || ''),
    });
  }
  return products;
}

function findProductByKey_(products, productKey) {
  for (var i = 0; i < products.length; i++) {
    if (String(products[i].product_key) === String(productKey)) {
      return products[i];
    }
  }
  if (String(productKey) === 'proofpack_starter') {
    return getProofPackFallbackProduct_('queued', productKey);
  }
  return null;
}

function buildProductSearchText_(payload, payment) {
  const candidates = [
    payment && payment.note,
    payment && payment.order_id,
    payment && payment.payment_link_id,
    payment && payment.checkout_id,
    payment && payment.receipt_number,
    payment && payment.receipt_url,
    payload && payload.merchant_id,
    JSON.stringify(payload || {}),
  ];
  return candidates.filter(Boolean).join(' ').toLowerCase();
}

function getProofPackFallbackProduct_(matchType, matchValue) {
  return {
    product_key: 'proofpack_starter',
    product_name: 'BRIDGE ProofPack Starter',
    active: 'TRUE',
    match_type: matchType || 'fallback',
    match_value: matchValue || '',
    delivery_url: '',
    mail_subject: '',
    mail_body_template: '',
    support_url: '',
    notes: 'Backward-compatible fallback for the existing ProofPack Starter delivery.',
  };
}

function getUnknownProduct_() {
  return {
    product_key: 'UNKNOWN_PRODUCT',
    product_name: '',
    active: 'FALSE',
    match_type: 'none',
    match_value: '',
    delivery_url: '',
    mail_subject: '',
    mail_body_template: '',
    support_url: '',
  };
}

function parseJsonSafe_(rawJson) {
  try {
    return JSON.parse(String(rawJson || '{}'));
  } catch (err) {
    return {};
  }
}

function TEST_resolveProductFromSamplePayload() {
  const payload = buildSampleSquarePaymentPayload_('payment-test-proofpack', 100, 'BRIDGE ProofPack Starter');
  const product = resolveProductFromPayment_(payload, payload.data.object.payment, null);
  return { ok: product.product_key === 'proofpack_starter', product: product };
}

function TEST_buildDeliveryMailByProduct() {
  const product = {
    product_key: 'estimate_front',
    product_name: 'BRIDGE 見積前受付フロント',
    mail_subject: '【納品】{{product_name}}',
    mail_body_template: 'ご購入ありがとうございます。\n納品URL: {{delivery_url}}\nお問い合わせ: {{support_url}}',
    delivery_url: 'https://example.com/estimate-front',
    support_url: 'https://example.com/support',
  };
  const mail = buildDeliveryMailByProduct_(product, {
    shopName: 'BRIDGE OS',
    deliveryUrl: product.delivery_url,
    supportFormUrl: product.support_url,
    buyerEmail: 'buyer@example.com',
    paymentId: 'payment-test-estimate',
    eventId: 'event-test-estimate',
  });
  return { ok: mail.subject.indexOf(product.product_name) >= 0 && mail.body.indexOf(product.delivery_url) >= 0, mail: mail };
}

function TEST_processFulfillmentQueue_dryRun() {
  return processFulfillmentQueue_({ dryRun: true });
}

function buildSampleSquarePaymentPayload_(paymentId, amount, note) {
  return {
    event_id: 'event-' + paymentId,
    type: 'payment.updated',
    data: {
      object: {
        payment: {
          id: paymentId,
          status: 'COMPLETED',
          amount_money: { amount: amount, currency: 'JPY' },
          buyer_email_address: 'buyer@example.com',
          note: note,
        },
      },
    },
  };
}

function isProofPackExternalAiIntakePayload_(payload) {
  if (!payload) {
    return false;
  }
  const source = normalizeProofPackSource_(payload.source || payload.channel || payload.intake_source);
  const externalSources = ['line', 'gmail', 'lp'];
  if (externalSources.indexOf(source) < 0) {
    return false;
  }
  const type = String(payload.type || payload.event_type || '').toLowerCase();
  return type === 'proofpack.ai_intake' || type === 'proofpack_ai_intake' || !!extractProofPackOriginalMessageFromPayload_(payload);
}

function recordProofPackExternalAiIntake_(aiIntakeLogSheet, payload, rawData) {
  const context = buildProofPackExternalAiIntakeContext_(payload, rawData);
  return maybeCreateProofPackAiIntake_(aiIntakeLogSheet, context);
}

function buildProofPackExternalAiIntakeContext_(payload, rawData) {
  const source = normalizeProofPackSource_(payload.source || payload.channel || payload.intake_source);
  return {
    source: source,
    payment_id: String(payload.payment_id || payload.paymentId || ''),
    event_id: extractProofPackExternalEventId_(payload, source),
    buyer_email: extractProofPackExternalEmail_(payload),
    raw_json: rawData,
    original_message: extractProofPackOriginalMessageFromPayload_(payload),
  };
}

function extractProofPackExternalEventId_(payload, source) {
  const candidates = [
    payload.event_id,
    payload.eventId,
    payload.message_id,
    payload.messageId,
    payload.gmail_message_id,
    payload.line_event_id,
    payload.inquiry_id,
    payload.id,
  ];
  for (var i = 0; i < candidates.length; i++) {
    if (candidates[i]) {
      return String(candidates[i]);
    }
  }
  return source + '-' + toSha256Hex_(JSON.stringify(payload)).slice(0, 16);
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

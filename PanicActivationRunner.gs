/**
 * BRIDGE Panic Activation Runner v18
 *
 * 目的：
 * - 実決済なしで、本番GAS /exec URLへテストPOSTする
 * - WEBHOOK_TOKENはScript Propertiesから直接読む
 * - PANIC_GMAIL_MODE=DRAFT の間だけDRAFTテストを実行する
 * - 5商品のProduct_Master active / variation_id判定を確認する
 * - POST後はSpreadsheet反映を待つため、状態をポーリングしてから判定する
 * - 全DRAFTテスト成功後だけ PANIC_GMAIL_MODE=SEND に切り替える
 *
 * 注意：
 * - このファイルは検収用Runnerです
 * - main.gs / PanicPdfAddon.gs の本体ロジックは変更しません
 * - SEND切替後はDRAFTテスト関数を再実行しないでください
 */

var PANIC_ACTIVATION_PROD_URL =
  'https://script.google.com/macros/s/AKfycbxKvkDCgNeN9gHjrExH2yxLyWreR9-4ubXJwD84voBX9gaxvAUjaZhMUCZhzgsVeADt/exec';

var PANIC_ACTIVATION_PRODUCT_MASTER_SHEET_NAME = 'Product_Master';
var PANIC_ACTIVATION_MARKER_PREFIX = 'PANIC_ACTIVATION_TEST_OK_';
var PANIC_ACTIVATION_CURRENT_RUN_ID_KEY = 'PANIC_ACTIVATION_CURRENT_RUN_ID';
var PANIC_ACTIVATION_MARKER_MAX_AGE_MS = 12 * 60 * 60 * 1000;
var PANIC_ACTIVATION_WAIT_TIMEOUT_MS = 120000;
var PANIC_ACTIVATION_WAIT_INTERVAL_MS = 3000;
var PANIC_ACTIVATION_FRESH_READ_PADDING_ROWS = 50;
var PANIC_ACTIVATION_FRESH_READ_SEQUENCE = 0;

var PANIC_ACTIVATION_PRODUCTS = [
  {
    product_key: 'panic_nav_1000',
    sku: 'BRIDGE-PANIC-NAV-1000',
    variation_id: 'AQ5KGY3VPS42RXMIIVTHVIBA',
    amount: 1000
  },
  {
    product_key: 'panic_pack_9800',
    sku: 'BRIDGE-PANIC-PACK-9800',
    variation_id: '5WCLFAOXWKWF5LFYK2QMMRCE',
    amount: 9800
  },
  {
    product_key: 'panic_sort_29800',
    sku: 'BRIDGE-PANIC-SORT-29800',
    variation_id: 'BSQTVUMUHNSDHXXIANPEE2ZJ',
    amount: 29800
  },
  {
    product_key: 'panic_done_49800',
    sku: 'BRIDGE-PANIC-DONE-49800',
    variation_id: 'E3B3YP4SFRKOIJLRSXDJINDK',
    amount: 49800
  },
  {
    product_key: 'biz_proof_148000',
    sku: 'BRIDGE-BIZ-PROOF-148000',
    variation_id: 'N6B26JXPKVLKVUXDKD6IPVBM',
    amount: 148000
  }
];

var PANIC_ACTIVATION_REQUIRED_MARKERS = [
  'PREFLIGHT',
  'PRODUCT_MASTER',
  'ALL_5_FORM_CREATED_DRAFT',
  'NORMAL_PDF_DELIVERY_DRAFT',
  'SAFETY_STOP_DRAFT',
  'DUPLICATE_WEBHOOK_DRAFT'
];

/**
 * 1回目に実行。
 * Script Properties / 本番URL / Product_Master を確認する。
 * メール送信・PDF作成・Product_Master変更はしない。
 */
function activation_preflight_status() {
  var props = PropertiesService.getScriptProperties();
  var runId = activationCreateRunId_();
  props.setProperty(PANIC_ACTIVATION_CURRENT_RUN_ID_KEY, runId);

  var result = {
    ok: true,
    run_id: runId,
    prod_url: PANIC_ACTIVATION_PROD_URL,
    PANIC_SPREADSHEET_ID: props.getProperty('PANIC_SPREADSHEET_ID') ? 'SET' : 'MISSING',
    PANIC_GMAIL_MODE: activationToText_(props.getProperty('PANIC_GMAIL_MODE')),
    PANIC_TEST_RECIPIENT_EMAIL: activationToText_(props.getProperty('PANIC_TEST_RECIPIENT_EMAIL')),
    WEBHOOK_TOKEN: props.getProperty('WEBHOOK_TOKEN') ? 'SET' : 'MISSING',
    OPENAI_API_KEY: props.getProperty('OPENAI_API_KEY') ? 'SET_NOT_TOUCHED' : 'MISSING_OR_NOT_SET'
  };

  var response = UrlFetchApp.fetch(PANIC_ACTIVATION_PROD_URL, {
    method: 'get',
    muteHttpExceptions: true
  });

  result.prod_url_http_code = response.getResponseCode();
  result.prod_url_body = activationToText_(response.getContentText()).trim();

  if (result.PANIC_SPREADSHEET_ID !== 'SET') {
    result.ok = false;
    result.reason = 'PANIC_SPREADSHEET_ID is missing.';
  }

  if (activationToText_(result.PANIC_GMAIL_MODE).toUpperCase() !== 'DRAFT') {
    result.ok = false;
    result.reason = 'PANIC_GMAIL_MODE is not DRAFT. Do not run DRAFT tests.';
  }

  if (!result.PANIC_TEST_RECIPIENT_EMAIL) {
    result.ok = false;
    result.reason = 'PANIC_TEST_RECIPIENT_EMAIL is missing.';
  }

  if (result.WEBHOOK_TOKEN !== 'SET') {
    result.ok = false;
    result.reason = 'WEBHOOK_TOKEN is missing.';
  }

  if (result.prod_url_http_code < 200 || result.prod_url_http_code >= 300) {
    result.ok = false;
    result.reason = 'Production URL did not return 2xx.';
  }

  if (result.prod_url_body !== 'OK') {
    result.ok = false;
    result.reason = 'Production URL body is not OK. body=' + result.prod_url_body;
  }

  if (!result.ok) {
    Logger.log(JSON.stringify(result, null, 2));
    throw new Error(result.reason);
  }

  result.product_master = activation_check_product_master_targets();

  activationSetMarker_('PREFLIGHT', result);
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

/**
 * Product_Masterの対象5商品だけを確認する。
 * 変更はしない。
 */
function activation_check_product_master_targets() {
  var check = activationAssertProductMasterActive_();
  activationSetMarker_('PRODUCT_MASTER', check);
  Logger.log(JSON.stringify(check, null, 2));
  return check;
}

/**
 * 2回目に実行。
 * 対象5商品のWebhook入口テスト。
 * 実決済なし。
 * DRAFTモードでフォーム案内ドラフトまで確認する。
 */
function activation_test_all_5_products_form_created_DRAFT() {
  activationAssertDraftReady_();
  activationAssertProductMasterActive_();

  var results = [];

  for (var i = 0; i < PANIC_ACTIVATION_PRODUCTS.length; i++) {
    var product = PANIC_ACTIVATION_PRODUCTS[i];
    var paymentId = activationPaymentId_('activation_form_' + product.product_key);
    var response = activationPostSquareWebhook_(product, paymentId);
    activationAssertWebhookStatus_(response, ['FORM_CREATED'], paymentId);
    SpreadsheetApp.flush();

    var state = activationWaitForState_(paymentId, ['FORM_CREATED'], {
      require_form_url: true,
      require_draft_id: true,
      product_key: product.product_key,
      variation_id: product.variation_id
    });

    if (activationGetGmailMode_() !== 'DRAFT') {
      throw new Error('PANIC_GMAIL_MODE changed during all-products test. current=' + activationGetGmailMode_());
    }

    results.push({
      product_key: product.product_key,
      variation_id: product.variation_id,
      payment_id: paymentId,
      webhook_response: response,
      state_status: state.status,
      form_url: state.form_url,
      draft_id: state.draft_id
    });
  }

  var result = {
    ok: true,
    test: 'activation_test_all_5_products_form_created_DRAFT',
    gmail_mode: activationGetGmailMode_(),
    results: results
  };

  activationSetMarker_('ALL_5_FORM_CREATED_DRAFT', result);
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

/**
 * 3回目に実行。
 * 通常PDF納品の本番URL経由テスト。
 * Webhook作成 → フォームPOST → PDF作成 → Gmailドラフトまで確認。
 * 実送信はしない。
 */
function activation_test_normal_pdf_delivery_DRAFT() {
  activationAssertDraftReady_();
  activationAssertProductMasterActive_();

  var product = PANIC_ACTIVATION_PRODUCTS[0];
  var paymentId = activationPaymentId_('activation_normal');
  var webhookResponse = activationPostSquareWebhook_(product, paymentId);
  activationAssertWebhookStatus_(webhookResponse, ['FORM_CREATED'], paymentId);

  var state = activationWaitForState_(paymentId, ['FORM_CREATED'], {
    require_form_url: true,
    require_draft_id: true,
    product_key: product.product_key,
    variation_id: product.variation_id
  });

  if (!state.token) {
    throw new Error('State token is empty after webhook. payment_id=' + paymentId);
  }

  var formData = panicBuildNormalTestForm_(paymentId, state.token);
  formData.product_key = product.product_key;
  formData.variation_id = product.variation_id;
  formData.amount_or_impact = '本番URL経由DRAFT通常納品テスト。実決済なし。';
  formData.free_note = 'activation_test_normal_pdf_delivery_DRAFT';

  var formResponse = activationPostForm_(formData);

  var finalState = activationWaitForState_(paymentId, ['DELIVERED'], {
    require_pdf_url: true,
    require_doc_url: true,
    require_draft_id: true,
    product_key: product.product_key,
    variation_id: product.variation_id
  });

  if (activationGetGmailMode_() !== 'DRAFT') {
    throw new Error('PANIC_GMAIL_MODE changed during normal test. current=' + activationGetGmailMode_());
  }

  var result = {
    ok: true,
    test: 'activation_test_normal_pdf_delivery_DRAFT',
    gmail_mode: activationGetGmailMode_(),
    payment_id: paymentId,
    webhook_response: webhookResponse,
    form_http_code: formResponse.http_code,
    form_body_head: formResponse.body_head,
    final_status: finalState.status,
    pdf_url: finalState.pdf_url,
    doc_url: finalState.doc_url,
    draft_id: finalState.draft_id
  };

  activationSetMarker_('NORMAL_PDF_DELIVERY_DRAFT', result);
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

/**
 * 4回目に実行。
 * SAFETY_STOPの本番URL経由テスト。
 * 危険入力で通常PDFを作らず、SAFETY_STOPになることを確認する。
 */
function activation_test_safety_stop_DRAFT() {
  activationAssertDraftReady_();
  activationAssertProductMasterActive_();

  var product = PANIC_ACTIVATION_PRODUCTS[0];
  var paymentId = activationPaymentId_('activation_safety');
  var webhookResponse = activationPostSquareWebhook_(product, paymentId);
  activationAssertWebhookStatus_(webhookResponse, ['FORM_CREATED'], paymentId);

  var state = activationWaitForState_(paymentId, ['FORM_CREATED'], {
    require_form_url: true,
    require_draft_id: true,
    product_key: product.product_key,
    variation_id: product.variation_id
  });

  if (!state.token) {
    throw new Error('State token is empty after safety webhook. payment_id=' + paymentId);
  }

  var formData = panicBuildNormalTestForm_(paymentId, state.token);
  formData.product_key = product.product_key;
  formData.variation_id = product.variation_id;
  formData.danger_flag = 'yes';
  formData.current_issue = '今すぐ危ない。身体の危険がある。';
  formData.free_note = 'activation_test_safety_stop_DRAFT';

  var formResponse = activationPostForm_(formData);

  var finalState = activationWaitForState_(paymentId, ['SAFETY_STOP'], {
    require_draft_id: true,
    product_key: product.product_key,
    variation_id: product.variation_id
  });

  if (finalState.pdf_url) {
    throw new Error('Safety stop should not create normal PDF. payment_id=' + paymentId);
  }

  if (finalState.doc_url) {
    throw new Error('Safety stop should not create normal Doc. payment_id=' + paymentId);
  }

  if (activationGetGmailMode_() !== 'DRAFT') {
    throw new Error('PANIC_GMAIL_MODE changed during safety test. current=' + activationGetGmailMode_());
  }

  var result = {
    ok: true,
    test: 'activation_test_safety_stop_DRAFT',
    gmail_mode: activationGetGmailMode_(),
    payment_id: paymentId,
    webhook_response: webhookResponse,
    form_http_code: formResponse.http_code,
    form_body_head: formResponse.body_head,
    final_status: finalState.status,
    safety_status: finalState.safety_status || '',
    pdf_url: finalState.pdf_url || '',
    doc_url: finalState.doc_url || '',
    draft_id: finalState.draft_id || ''
  };

  activationSetMarker_('SAFETY_STOP_DRAFT', result);
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

/**
 * 5回目に実行。
 * 重複防止テスト。
 * 同じpayment_idで2回Webhook POSTし、2回目がSKIPPED_DUPLICATEになることを確認。
 */
function activation_test_duplicate_webhook_DRAFT() {
  activationAssertDraftReady_();
  activationAssertProductMasterActive_();

  var product = PANIC_ACTIVATION_PRODUCTS[0];
  var paymentId = activationPaymentId_('activation_duplicate');

  var first = activationPostSquareWebhook_(product, paymentId);
  var baseState = activationWaitForState_(paymentId, ['FORM_CREATED'], {
    require_form_url: true,
    require_draft_id: true,
    product_key: product.product_key,
    variation_id: product.variation_id
  });
  var second = activationPostSquareWebhook_(product, paymentId);

  if (!first || activationToText_(first.status) !== 'FORM_CREATED') {
    throw new Error('Expected first webhook response FORM_CREATED. actual=' + JSON.stringify(first));
  }

  if (!second || activationToText_(second.status) !== 'SKIPPED_DUPLICATE') {
    throw new Error('Expected second webhook response SKIPPED_DUPLICATE. actual=' + JSON.stringify(second));
  }

  if (activationGetGmailMode_() !== 'DRAFT') {
    throw new Error('PANIC_GMAIL_MODE changed during duplicate test. current=' + activationGetGmailMode_());
  }

  var result = {
    ok: true,
    test: 'activation_test_duplicate_webhook_DRAFT',
    gmail_mode: activationGetGmailMode_(),
    payment_id: paymentId,
    first_response: first,
    second_response: second,
    state_status: baseState.status,
    form_url: baseState.form_url || '',
    draft_id: baseState.draft_id || ''
  };

  activationSetMarker_('DUPLICATE_WEBHOOK_DRAFT', result);
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

/**
 * 6回目、全DRAFTテスト成功後だけ実行。
 * これを実行すると、以後の本番購入者メールは送信モードになる。
 */
function activation_SWITCH_PANIC_GMAIL_MODE_TO_SEND_AFTER_DRAFT_TESTS_PASS() {
  var props = PropertiesService.getScriptProperties();
  var current = activationGetGmailMode_();

  if (current !== 'DRAFT') {
    throw new Error('PANIC_GMAIL_MODE is not DRAFT. Current=' + current);
  }

  activationAssertProductMasterActive_();
  activationRequireAllRecentMarkers_();

  props.setProperty('PANIC_GMAIL_MODE', 'SEND');

  var result = {
    ok: true,
    changed: 'PANIC_GMAIL_MODE',
    before: current,
    after: props.getProperty('PANIC_GMAIL_MODE'),
    note: 'Do not run DRAFT test functions after switching to SEND.'
  };

  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

/**
 * SEND切替後の確認専用。
 * POST・PDF作成・メール送信はしない。
 */
function activation_after_send_status_check() {
  var props = PropertiesService.getScriptProperties();

  var result = {
    ok: true,
    PANIC_GMAIL_MODE: props.getProperty('PANIC_GMAIL_MODE') || '',
    PANIC_SPREADSHEET_ID: props.getProperty('PANIC_SPREADSHEET_ID') ? 'SET' : 'MISSING',
    WEBHOOK_TOKEN: props.getProperty('WEBHOOK_TOKEN') ? 'SET' : 'MISSING',
    prod_url: PANIC_ACTIVATION_PROD_URL,
    product_master: activationAssertProductMasterActive_()
  };

  if (activationToText_(result.PANIC_GMAIL_MODE).toUpperCase() !== 'SEND') {
    result.ok = false;
    result.reason = 'PANIC_GMAIL_MODE is not SEND.';
  }

  if (!result.ok) {
    Logger.log(JSON.stringify(result, null, 2));
    throw new Error(result.reason);
  }

  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

/**
 * 再テストしたい場合だけ実行。
 * テスト済みマーカーだけ削除する。
 * Product_MasterやGmail設定は変更しない。
 */
function activation_clear_test_markers_ONLY_IF_RETESTING() {
  var props = PropertiesService.getScriptProperties();
  var all = props.getProperties();
  var removed = [];

  for (var key in all) {
    if (key && activationToText_(key).indexOf(PANIC_ACTIVATION_MARKER_PREFIX) === 0) {
      props.deleteProperty(key);
      removed.push(key);
    }
  }
  props.deleteProperty(PANIC_ACTIVATION_CURRENT_RUN_ID_KEY);

  var result = {
    ok: true,
    removed: removed,
    current_run_id_removed: true
  };

  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

/* =========================
 * 内部関数
 * ========================= */

function activationAssertDraftReady_() {
  var props = PropertiesService.getScriptProperties();
  var mode = activationGetGmailMode_();
  var token = props.getProperty('WEBHOOK_TOKEN');

  if (mode !== 'DRAFT') {
    throw new Error('PANIC_GMAIL_MODE must be DRAFT for this test. Current=' + mode);
  }

  if (!token) {
    throw new Error('WEBHOOK_TOKEN is missing in Script Properties.');
  }

  if (!props.getProperty('PANIC_SPREADSHEET_ID')) {
    throw new Error('PANIC_SPREADSHEET_ID is missing in Script Properties.');
  }

  if (!props.getProperty('PANIC_TEST_RECIPIENT_EMAIL')) {
    throw new Error('PANIC_TEST_RECIPIENT_EMAIL is missing in Script Properties.');
  }

  return true;
}

function activationGetGmailMode_() {
  var value = activationToText_(PropertiesService.getScriptProperties().getProperty('PANIC_GMAIL_MODE')).toUpperCase();
  return value === 'SEND' ? 'SEND' : 'DRAFT';
}

function activationPaymentId_(prefix) {
  return prefix + '_' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd_HHmmss') + '_' + Utilities.getUuid().replace(/-/g, '').substring(0, 8);
}

function activationBuildSquarePayload_(product, paymentId) {
  var email = PropertiesService.getScriptProperties().getProperty('PANIC_TEST_RECIPIENT_EMAIL');

  return {
    event_id: 'evt_' + paymentId,
    type: 'payment.updated',
    merchant_id: 'BRIDGE_ACTIVATION_TEST',
    source: 'ACTIVATION_TEST',
    variation_id: product.variation_id,
    product_key: product.product_key,
    sku: product.sku,
    customer_email: email,
    data: {
      object: {
        payment: {
          id: paymentId,
          status: 'COMPLETED',
          amount_money: {
            amount: product.amount,
            currency: 'JPY'
          },
          buyer_email_address: email,
          note: [
            'BRIDGE activation test',
            product.product_key,
            product.sku,
            product.variation_id
          ].join(' / '),
          order_id: 'order_' + paymentId,
          receipt_number: 'receipt_' + paymentId
        },
        order: {
          id: 'order_' + paymentId,
          line_items: [
            {
              name: product.product_key,
              catalog_object_id: product.variation_id,
              variation_id: product.variation_id,
              quantity: '1',
              total_money: {
                amount: product.amount,
                currency: 'JPY'
              }
            }
          ]
        }
      }
    }
  };
}

function activationPostSquareWebhook_(product, paymentId) {
  var token = PropertiesService.getScriptProperties().getProperty('WEBHOOK_TOKEN');
  if (!token) {
    throw new Error('WEBHOOK_TOKEN is missing.');
  }

  var url = PANIC_ACTIVATION_PROD_URL + '?token=' + encodeURIComponent(token);
  var payload = activationBuildSquarePayload_(product, paymentId);

  var response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  var code = response.getResponseCode();
  var body = response.getContentText();

  if (code < 200 || code >= 300) {
    throw new Error('Webhook POST failed. code=' + code + ' body=' + body);
  }

  var parsed = activationParseJsonSafe_(body);
  if (!parsed || parsed.ok === false) {
    throw new Error('Webhook returned non-ok body: ' + body);
  }

  return parsed;
}

function activationPostForm_(formData) {
  var response = UrlFetchApp.fetch(PANIC_ACTIVATION_PROD_URL, {
    method: 'post',
    payload: formData,
    muteHttpExceptions: true
  });

  var code = response.getResponseCode();
  var body = response.getContentText();

  if (code < 200 || code >= 300) {
    throw new Error('Form POST failed. code=' + code + ' body=' + body);
  }

  return {
    http_code: code,
    body_head: activationToText_(body).substring(0, 500)
  };
}


function activationAssertWebhookStatus_(response, expectedStatuses, paymentId) {
  var expectedMap = {};
  for (var i = 0; i < expectedStatuses.length; i++) {
    expectedMap[expectedStatuses[i]] = true;
  }

  var actual = activationToText_(response && response.status ? response.status : '');
  if (!expectedMap[actual]) {
    throw new Error('Webhook did not return expected Panic status. payment_id=' + paymentId + ' expected=' + expectedStatuses.join('|') + ' response=' + JSON.stringify(response));
  }

  if (response && response.handled === false) {
    throw new Error('Webhook was not handled by Panic route. payment_id=' + paymentId + ' response=' + JSON.stringify(response));
  }
}

function activationWaitForState_(paymentId, expectedStatuses, options) {
  options = options || {};
  var timeoutMs = options.timeout_ms || PANIC_ACTIVATION_WAIT_TIMEOUT_MS;
  var started = new Date().getTime();
  var lastState = null;
  var expectedMap = {};

  for (var i = 0; i < expectedStatuses.length; i++) {
    expectedMap[expectedStatuses[i]] = true;
  }

  while (new Date().getTime() - started <= timeoutMs) {
    SpreadsheetApp.flush();
    lastState = activationFindStateByPaymentIdDirect_(paymentId);
    if (lastState && activationStateMatches_(lastState, expectedMap, options)) {
      return lastState;
    }
    Utilities.sleep(PANIC_ACTIVATION_WAIT_INTERVAL_MS);
  }

  var diagnostics = activationBuildStateTimeoutDiagnostics_(paymentId, lastState);
  throw new Error(
    'Timed out waiting for state. payment_id=' + paymentId +
    ' expected=' + expectedStatuses.join('|') +
    ' diagnostics=' + JSON.stringify(diagnostics)
  );
}

/**
 * PanicPdfAddon.gs の panicFindStateByPaymentId_ は既存側の String() 実装に依存するため、
 * 検収Runnerでは直接 Panic_PDF_State を読みに行く。
 * これにより、実ログ・実Stateに存在するのに Runner が null 判定する事故を避ける。
 */
function activationFindStateByPaymentIdDirect_(paymentId) {
  var rows = activationFindRowsByPaymentIdDirect_('Panic_PDF_State', paymentId, 1);
  return rows.length ? rows[0] : null;
}

function activationFindLogRowsByPaymentIdDirect_(paymentId) {
  return activationFindRowsByPaymentIdDirect_('Panic_PDF_Log', paymentId, 5);
}

/**
 * TextFinderでpayment_id列を直接検索し、同一実行内のgetLastRowキャッシュを避ける。
 * TextFinderで見つからない場合は、末尾に余白を足した可変範囲を読み直す。
 */
function activationFindRowsByPaymentIdDirect_(sheetName, paymentId, limit) {
  if (!paymentId) {
    return [];
  }

  var props = PropertiesService.getScriptProperties();
  var spreadsheetId = props.getProperty('PANIC_SPREADSHEET_ID');
  if (!spreadsheetId) {
    throw new Error('PANIC_SPREADSHEET_ID is missing while reading ' + sheetName + '.');
  }

  var ss = SpreadsheetApp.openById(spreadsheetId);
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    throw new Error(sheetName + ' sheet not found.');
  }

  var lastCol = sheet.getLastColumn();
  if (lastCol < 1) {
    return [];
  }

  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var paymentCol = activationFindHeaderIndex_(headers, 'payment_id');
  if (paymentCol < 0) {
    throw new Error('payment_id header not found in ' + sheetName + '.');
  }

  var target = activationToText_(paymentId).trim();
  var records = [];
  var seenRows = {};

  try {
    var matches = sheet.createTextFinder(target)
      .matchCase(true)
      .matchEntireCell(true)
      .findAll();

    matches.sort(function(a, b) {
      return b.getRow() - a.getRow();
    });

    for (var i = 0; i < matches.length; i++) {
      var match = matches[i];
      if (match.getRow() <= 1 || match.getColumn() !== paymentCol + 1) {
        continue;
      }
      var rowNumber = match.getRow();
      var rowValues = sheet.getRange(rowNumber, 1, 1, lastCol).getValues()[0];
      records.push(activationBuildRowObject_(headers, rowValues, rowNumber));
      seenRows[rowNumber] = true;
      if (records.length >= limit) {
        return records;
      }
    }
  } catch (finderError) {
    Logger.log('TextFinder fallback for ' + sheetName + ': ' + activationToText_(finderError && finderError.message ? finderError.message : finderError));
  }

  var values = activationReadSheetValuesWithPadding_(sheet, lastCol);
  for (var r = values.length - 1; r >= 1; r--) {
    var actualRow = r + 1;
    if (seenRows[actualRow]) {
      continue;
    }
    if (activationToText_(values[r][paymentCol]).trim() === target) {
      records.push(activationBuildRowObject_(headers, values[r], actualRow));
      if (records.length >= limit) {
        break;
      }
    }
  }

  return records;
}

function activationReadSheetValuesWithPadding_(sheet, lastCol) {
  PANIC_ACTIVATION_FRESH_READ_SEQUENCE += 1;
  var visibleLastRow = Math.max(sheet.getLastRow(), 2);
  var maxRows = Math.max(sheet.getMaxRows(), visibleLastRow);
  var requestedRows = visibleLastRow +
    PANIC_ACTIVATION_FRESH_READ_PADDING_ROWS +
    PANIC_ACTIVATION_FRESH_READ_SEQUENCE;
  var readRows = Math.min(maxRows, requestedRows);
  return sheet.getRange(1, 1, readRows, lastCol).getValues();
}

function activationFindHeaderIndex_(headers, headerName) {
  for (var i = 0; i < headers.length; i++) {
    if (activationToText_(headers[i]).trim() === headerName) {
      return i;
    }
  }
  return -1;
}

function activationBuildRowObject_(headers, rowValues, rowNumber) {
  var obj = {};
  for (var i = 0; i < headers.length; i++) {
    var key = activationToText_(headers[i]).trim();
    if (key) {
      obj[key] = rowValues[i];
    }
  }
  obj._row = rowNumber;
  return obj;
}

function activationBuildStateTimeoutDiagnostics_(paymentId, lastState) {
  var directState = activationFindStateByPaymentIdDirect_(paymentId);
  var logRows = activationFindLogRowsByPaymentIdDirect_(paymentId);
  var safeLogs = [];

  for (var i = 0; i < logRows.length; i++) {
    safeLogs.push({
      row: logRows[i]._row,
      status: activationToText_(logRows[i].status),
      source: activationToText_(logRows[i].source),
      error_message: activationToText_(logRows[i].error_message),
      message: activationToText_(logRows[i].message)
    });
  }

  return {
    last_state: activationSafeStateDiagnostic_(lastState),
    direct_state: activationSafeStateDiagnostic_(directState),
    log_rows: safeLogs
  };
}

function activationSafeStateDiagnostic_(state) {
  if (!state) {
    return null;
  }
  return {
    row: state._row || '',
    product_key: activationToText_(state.product_key),
    variation_id: activationToText_(state.variation_id),
    status: activationToText_(state.status),
    safety_status: activationToText_(state.safety_status),
    has_form_url: !!state.form_url,
    has_draft_id: !!state.draft_id,
    has_doc_url: !!state.doc_url,
    has_pdf_url: !!state.pdf_url,
    error_message: activationToText_(state.error_message)
  };
}

function activationStateMatches_(state, expectedMap, options) {
  if (!state) {
    return false;
  }

  var status = activationToText_(state.status);
  if (!expectedMap[status]) {
    return false;
  }

  if (options.product_key && activationToText_(state.product_key) !== options.product_key) {
    return false;
  }

  if (options.variation_id && activationToText_(state.variation_id) !== options.variation_id) {
    return false;
  }

  if (options.require_form_url && !state.form_url) {
    return false;
  }

  if (options.require_draft_id && !state.draft_id) {
    return false;
  }

  if (options.require_pdf_url && !state.pdf_url) {
    return false;
  }

  if (options.require_doc_url && !state.doc_url) {
    return false;
  }

  return true;
}

function activationParseJsonSafe_(text) {
  try {
    return JSON.parse(activationToText_(text || '{}'));
  } catch (err) {
    return {
      ok: false,
      parse_error: activationToText_(err && err.message ? err.message : err),
      raw: activationToText_(text).substring(0, 500)
    };
  }
}

function activationAssertProductMasterActive_() {
  var props = PropertiesService.getScriptProperties();
  var spreadsheetId = props.getProperty('PANIC_SPREADSHEET_ID');
  if (!spreadsheetId) {
    throw new Error('PANIC_SPREADSHEET_ID is missing.');
  }

  var ss = SpreadsheetApp.openById(spreadsheetId);
  var sheet = ss.getSheetByName(PANIC_ACTIVATION_PRODUCT_MASTER_SHEET_NAME);
  if (!sheet) {
    throw new Error('Product_Master sheet not found.');
  }

  if (sheet.getLastRow() < 2) {
    throw new Error('Product_Master has no data rows.');
  }

  var values = sheet.getDataRange().getValues();
  var headers = values[0];
  var col = activationGetHeaderMap_(headers);

  activationRequireHeader_(col, 'product_key');
  activationRequireHeader_(col, 'active');
  activationRequireHeader_(col, 'match_type');
  activationRequireHeader_(col, 'match_value');

  var results = [];

  for (var i = 0; i < PANIC_ACTIVATION_PRODUCTS.length; i++) {
    var product = PANIC_ACTIVATION_PRODUCTS[i];
    var rowObj = activationFindProductMasterRow_(values, headers, col, product.product_key);

    if (!rowObj) {
      throw new Error('Product_Master row not found: ' + product.product_key);
    }

    var activeText = activationToText_(rowObj.active).trim().toLowerCase();
    var matchType = activationToText_(rowObj.match_type).trim().toLowerCase();
    var matchValue = activationToText_(rowObj.match_value).trim();

    if (!activationIsTrue_(activeText)) {
      throw new Error('Product_Master active is not TRUE. product_key=' + product.product_key + ' active=' + rowObj.active);
    }

    if (matchType !== 'variation_id') {
      throw new Error('Product_Master match_type is not variation_id. product_key=' + product.product_key + ' match_type=' + rowObj.match_type);
    }

    if (matchValue !== product.variation_id) {
      throw new Error('Product_Master match_value mismatch. product_key=' + product.product_key + ' expected=' + product.variation_id + ' actual=' + matchValue);
    }

    results.push({
      product_key: product.product_key,
      active: rowObj.active,
      match_type: rowObj.match_type,
      match_value: rowObj.match_value,
      expected_variation_id: product.variation_id,
      ok: true
    });
  }

  return {
    ok: true,
    sheet: PANIC_ACTIVATION_PRODUCT_MASTER_SHEET_NAME,
    checked_count: results.length,
    results: results
  };
}

function activationGetHeaderMap_(headers) {
  var map = {};
  for (var i = 0; i < headers.length; i++) {
    var raw = activationToText_(headers[i]).trim();
    if (raw) {
      map[raw] = i;
    }
  }
  return map;
}

function activationRequireHeader_(col, name) {
  if (typeof col[name] === 'undefined') {
    throw new Error('Missing Product_Master header: ' + name);
  }
}

function activationFindProductMasterRow_(values, headers, col, productKey) {
  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    var currentKey = activationToText_(row[col.product_key]).trim();
    if (currentKey === productKey) {
      return activationRowToObject_(headers, row);
    }
  }
  return null;
}

function activationRowToObject_(headers, row) {
  var obj = {};
  for (var i = 0; i < headers.length; i++) {
    var key = activationToText_(headers[i]).trim();
    if (key) {
      obj[key] = row[i];
    }
  }
  return obj;
}

function activationIsTrue_(value) {
  var text = activationToText_(value).trim().toLowerCase();
  return text === 'true' || text === '1' || text === 'yes' || text === 'y';
}

function activationCreateRunId_() {
  return 'run_' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd_HHmmss') + '_' + Utilities.getUuid().replace(/-/g, '').substring(0, 8);
}

function activationGetCurrentRunId_() {
  return activationToText_(PropertiesService.getScriptProperties().getProperty(PANIC_ACTIVATION_CURRENT_RUN_ID_KEY));
}

function activationSetMarker_(name, data) {
  var props = PropertiesService.getScriptProperties();
  var runId = activationGetCurrentRunId_();
  if (!runId) {
    runId = activationCreateRunId_();
    props.setProperty(PANIC_ACTIVATION_CURRENT_RUN_ID_KEY, runId);
  }

  var payload = {
    marker: name,
    ok: true,
    run_id: runId,
    timestamp_ms: new Date().getTime(),
    timestamp: new Date().toISOString(),
    data: data || {}
  };

  props.setProperty(PANIC_ACTIVATION_MARKER_PREFIX + name, JSON.stringify(payload));
}

function activationGetMarker_(name) {
  var props = PropertiesService.getScriptProperties();
  var raw = props.getProperty(PANIC_ACTIVATION_MARKER_PREFIX + name);
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch (err) {
    return null;
  }
}

function activationRequireAllRecentMarkers_() {
  var now = new Date().getTime();
  var checked = [];
  var currentRunId = activationGetCurrentRunId_();

  if (!currentRunId) {
    throw new Error('Current activation run_id is missing. Run activation_preflight_status first.');
  }

  for (var i = 0; i < PANIC_ACTIVATION_REQUIRED_MARKERS.length; i++) {
    var name = PANIC_ACTIVATION_REQUIRED_MARKERS[i];
    var marker = activationGetMarker_(name);

    if (!marker || marker.ok !== true) {
      throw new Error('Required activation test marker is missing: ' + name);
    }

    if (activationToText_(marker.run_id) !== currentRunId) {
      throw new Error('Required activation test marker belongs to a different run. marker=' + name + ' marker_run_id=' + marker.run_id + ' current_run_id=' + currentRunId);
    }

    var timestampMs = parseInt(marker.timestamp_ms || 0, 10);
    if (!timestampMs) {
      throw new Error('Required activation test marker has no timestamp: ' + name);
    }

    var age = now - timestampMs;
    if (age < 0 || age > PANIC_ACTIVATION_MARKER_MAX_AGE_MS) {
      throw new Error('Required activation test marker is too old. marker=' + name + ' age_ms=' + age);
    }

    checked.push({
      marker: name,
      timestamp: marker.timestamp,
      age_ms: age,
      run_id: marker.run_id
    });
  }

  return {
    ok: true,
    run_id: currentRunId,
    checked: checked
  };
}

/**
 * 組み込み String() の上書き事故を避けるため、String()を使わずに文字列化する。
 */
function activationToText_(value) {
  if (value === null || typeof value === 'undefined') {
    return '';
  }
  return value + '';
}

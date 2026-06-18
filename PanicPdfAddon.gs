/**
 * BRIDGE Panic PDF GAS Add-on
 *
 * Paste this entire file into a new Apps Script file, for example:
 *   PanicPdfAddon.gs
 *
 * Non-destructive integration points:
 *   1. Existing doGet(e):
 *      var panicGet = panicHandleDoGet_(e);
 *      if (panicGet) return panicGet;
 *
 *   2. Existing doPost(e), before the Square webhook handler mutates anything.
 *      This only handles browser form posts, not Square JSON:
 *      var panicPost = panicHandleDoPost_(e);
 *      if (panicPost) return panicPost;
 *
 *   3. Existing Square fulfillment worker, after JSON is parsed and any
 *      existing verification/Cloudflare checks have passed:
 *      var panicWebhook = panicHandleSquareWebhookIfTarget_(payload);
 *      if (panicWebhook && panicWebhook.handled) return panicJsonOutput_(panicWebhook);
 *      // If this is not doPost but an internal worker, return/use panicWebhook
 *      // according to the existing worker's return contract.
 *
 * This file does not update Product_Master, Square, Cloudflare, GitHub, LP,
 * or existing ProofPack product routes.
 */

var PANIC_PRODUCT_MAP = {
  "AQ5KGY3VPS42RXMIIVTHVIBA": {
    product_key: "panic_nav_1000",
    sku: "BRIDGE-PANIC-NAV-1000",
    price: 1000
  },
  "5WCLFAOXWKWF5LFYK2QMMRCE": {
    product_key: "panic_pack_9800",
    sku: "BRIDGE-PANIC-PACK-9800",
    price: 9800
  },
  "BSQTVUMUHNSDHXXIANPEE2ZJ": {
    product_key: "panic_sort_29800",
    sku: "BRIDGE-PANIC-SORT-29800",
    price: 29800
  },
  "E3B3YP4SFRKOIJLRSXDJINDK": {
    product_key: "panic_done_49800",
    sku: "BRIDGE-PANIC-DONE-49800",
    price: 49800
  },
  "N6B26JXPKVLKVUXDKD6IPVBM": {
    product_key: "biz_proof_148000",
    sku: "BRIDGE-BIZ-PROOF-148000",
    price: 148000
  }
};

var PANIC_CONFIG = {
  stateSheetName: "Panic_PDF_State",
  logSheetName: "Panic_PDF_Log",
  spreadsheetIdProperty: "PANIC_SPREADSHEET_ID",
  outputFolderIdProperty: "PANIC_OUTPUT_FOLDER_ID",
  webAppUrlProperty: "PANIC_WEBAPP_URL",
  gmailModeProperty: "PANIC_GMAIL_MODE",
  testRecipientProperty: "PANIC_TEST_RECIPIENT_EMAIL"
};

var PANIC_STATUS = {
  FORM_CREATED: "FORM_CREATED",
  FORM_SUBMITTED: "FORM_SUBMITTED",
  PDF_CREATED: "PDF_CREATED",
  DELIVERED: "DELIVERED",
  SAFETY_STOP: "SAFETY_STOP",
  SKIPPED_DUPLICATE: "SKIPPED_DUPLICATE",
  ERROR: "ERROR"
};

var PANIC_STATE_HEADERS = [
  "timestamp",
  "payment_id",
  "product_key",
  "variation_id",
  "sku",
  "price",
  "customer_email",
  "status",
  "safety_status",
  "doc_url",
  "pdf_url",
  "error_message",
  "source",
  "processed_at",
  "token",
  "form_url",
  "doc_file_id",
  "pdf_file_id",
  "draft_id",
  "updated_at"
];

var PANIC_LOG_HEADERS = [
  "timestamp",
  "payment_id",
  "product_key",
  "variation_id",
  "sku",
  "price",
  "customer_email",
  "status",
  "safety_status",
  "doc_url",
  "pdf_url",
  "error_message",
  "source",
  "processed_at",
  "token",
  "form_url",
  "doc_file_id",
  "pdf_file_id",
  "draft_id",
  "message"
];

var PANIC_SAFETY_KEYWORDS = [
  "自殺したい",
  "死にたい",
  "消えたい",
  "今から死ぬ",
  "殺されそう",
  "暴力を受けている",
  "監禁",
  "DV",
  "虐待",
  "薬を大量に飲んだ",
  "刃物",
  "今すぐ危ない",
  "身体の危険",
  "命の危険",
  "死ぬ",
  "殺される",
  "殴られている",
  "閉じ込められている"
];

function panicHandleDoGet_(e) {
  if (!e || !e.parameter || e.parameter.mode !== "panic_form") {
    return null;
  }

  return panicRenderForm_(e.parameter);
}

function panicHandleDoPost_(e) {
  if (panicIsPanicFormPost_(e)) {
    var result = panicProcessFormPostEvent_(e);
    return HtmlService.createHtmlOutput(panicBuildSubmitResultHtml_(result))
      .setTitle("BRIDGE 相談前整理フォーム");
  }

  return null;
}

function panicHandleSquareWebhookIfTarget_(payload) {
  var context = panicExtractPaymentContext_(payload);
  if (!context.variation_id || !PANIC_PRODUCT_MAP[context.variation_id]) {
    return {
      handled: false,
      reason: "not_panic_product"
    };
  }

  context.source = context.source || "SQUARE_WEBHOOK";
  return panicCreateFormForPayment_(context);
}

function panicCreateFormForPayment_(context) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    var variationId = String(context.variation_id || "");
    var product = PANIC_PRODUCT_MAP[variationId];
    if (!product) {
      throw new Error("Unknown panic variation_id: " + variationId);
    }

    var paymentId = String(context.payment_id || "");
    if (!paymentId) {
      throw new Error("payment_id is required.");
    }

    var existing = panicFindStateByPaymentId_(paymentId);
    if (existing) {
      panicAppendLog_({
        payment_id: paymentId,
        product_key: existing.product_key || product.product_key,
        variation_id: variationId,
        sku: existing.sku || product.sku,
        price: existing.price || product.price,
        customer_email: existing.customer_email || context.customer_email || "",
        status: PANIC_STATUS.SKIPPED_DUPLICATE,
        safety_status: existing.safety_status || "",
        doc_url: existing.doc_url || "",
        pdf_url: existing.pdf_url || "",
        source: context.source || "SQUARE_WEBHOOK",
        processed_at: panicNow_(),
        form_url: existing.form_url || "",
        message: "Duplicate payment_id. Existing form/delivery state was preserved."
      });

      return {
        handled: true,
        ok: true,
        status: PANIC_STATUS.SKIPPED_DUPLICATE,
        payment_id: paymentId,
        product_key: existing.product_key || product.product_key,
        form_url: existing.form_url || ""
      };
    }

    var token = panicCreateToken_();
    var formUrl = panicBuildFormUrl_(paymentId, variationId, product.product_key, token);
    var customerEmail = panicNormalizeEmail_(context.customer_email || "");
    var now = panicNow_();

    var state = {
      timestamp: now,
      payment_id: paymentId,
      product_key: product.product_key,
      variation_id: variationId,
      sku: product.sku,
      price: product.price,
      customer_email: customerEmail,
      status: PANIC_STATUS.FORM_CREATED,
      safety_status: "UNREVIEWED",
      doc_url: "",
      pdf_url: "",
      error_message: "",
      source: context.source || "SQUARE_WEBHOOK",
      processed_at: now,
      token: token,
      form_url: formUrl,
      doc_file_id: "",
      pdf_file_id: "",
      draft_id: "",
      updated_at: now
    };

    panicAppendState_(state);
    panicAppendLog_(state);

    if (customerEmail) {
      var draft = panicCreateFormLinkMessage_(customerEmail, formUrl, state);
      panicUpdateState_(paymentId, {
        draft_id: draft.draft_id || "",
        updated_at: panicNow_()
      });
      panicAppendLog_({
        payment_id: paymentId,
        product_key: product.product_key,
        variation_id: variationId,
        sku: product.sku,
        price: product.price,
        customer_email: customerEmail,
        status: PANIC_STATUS.FORM_CREATED,
        safety_status: "UNREVIEWED",
        source: "GMAIL_" + draft.mode,
        processed_at: panicNow_(),
        form_url: formUrl,
        draft_id: draft.draft_id || "",
        message: "Form link message prepared."
      });
    }

    return {
      handled: true,
      ok: true,
      status: PANIC_STATUS.FORM_CREATED,
      payment_id: paymentId,
      product_key: product.product_key,
      variation_id: variationId,
      form_url: formUrl,
      gmail_mode: panicGetGmailMode_()
    };
  } catch (err) {
    panicAppendLog_({
      payment_id: context && context.payment_id ? context.payment_id : "",
      variation_id: context && context.variation_id ? context.variation_id : "",
      customer_email: context && context.customer_email ? context.customer_email : "",
      status: PANIC_STATUS.ERROR,
      error_message: panicErrorMessage_(err),
      source: context && context.source ? context.source : "SQUARE_WEBHOOK",
      processed_at: panicNow_()
    });
    throw err;
  } finally {
    lock.releaseLock();
  }
}

function panicProcessFormPostEvent_(e) {
  try {
    return panicProcessFormSubmit_(panicBuildFormDataFromParameters_(e.parameter || {}));
  } catch (err) {
    return {
      ok: false,
      status: PANIC_STATUS.ERROR,
      error_message: panicErrorMessage_(err)
    };
  }
}

function panicProcessFormSubmit_(formData) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    return panicProcessFormSubmitLocked_(formData);
  } catch (err) {
    var paymentId = formData && formData.payment_id ? formData.payment_id : "";
    if (paymentId) {
      panicUpdateState_(paymentId, {
        status: PANIC_STATUS.ERROR,
        error_message: panicErrorMessage_(err),
        processed_at: panicNow_()
      });
    }
    panicAppendLog_({
      payment_id: paymentId,
      product_key: formData && formData.product_key ? formData.product_key : "",
      variation_id: formData && formData.variation_id ? formData.variation_id : "",
      customer_email: formData && formData.customer_email ? formData.customer_email : "",
      status: PANIC_STATUS.ERROR,
      error_message: panicErrorMessage_(err),
      source: "PANIC_FORM",
      processed_at: panicNow_()
    });
    throw err;
  } finally {
    lock.releaseLock();
  }
}

function panicProcessFormSubmitLocked_(formData) {
  var paymentId = String(formData.payment_id || "");
  var token = String(formData.token || "");
  if (!paymentId) {
    throw new Error("payment_id is required.");
  }
  if (!token) {
    throw new Error("token is required.");
  }

  var state = panicFindStateByPaymentId_(paymentId);
  if (!state) {
    throw new Error("No payment state found for payment_id: " + paymentId);
  }
  if (String(state.token || "") !== token) {
    throw new Error("Invalid token for payment_id: " + paymentId);
  }

  if (state.status === PANIC_STATUS.DELIVERED || state.status === PANIC_STATUS.SAFETY_STOP) {
    panicAppendLog_({
      payment_id: paymentId,
      product_key: state.product_key,
      variation_id: state.variation_id,
      sku: state.sku,
      price: state.price,
      customer_email: state.customer_email,
      status: PANIC_STATUS.SKIPPED_DUPLICATE,
      safety_status: state.safety_status,
      doc_url: state.doc_url,
      pdf_url: state.pdf_url,
      source: "PANIC_FORM",
      processed_at: panicNow_(),
      message: "Terminal status already exists. No new PDF or delivery was created."
    });
    return {
      ok: true,
      status: PANIC_STATUS.SKIPPED_DUPLICATE,
      payment_id: paymentId,
      pdf_url: state.pdf_url || ""
    };
  }

  var customerEmail = panicNormalizeEmail_(formData.customer_email || state.customer_email || "");
  panicAssertUsableEmail_(customerEmail);

  var product = PANIC_PRODUCT_MAP[state.variation_id];
  if (!product) {
    throw new Error("Unknown variation_id in state: " + state.variation_id);
  }

  var merged = panicMergeObjects_(formData, {
    product_key: product.product_key,
    variation_id: state.variation_id,
    sku: product.sku,
    price: product.price,
    customer_email: customerEmail
  });

  panicUpdateState_(paymentId, {
    customer_email: customerEmail,
    status: PANIC_STATUS.FORM_SUBMITTED,
    safety_status: "CHECKING",
    error_message: "",
    source: "PANIC_FORM",
    processed_at: panicNow_()
  });
  panicAppendLog_({
    payment_id: paymentId,
    product_key: product.product_key,
    variation_id: state.variation_id,
    sku: product.sku,
    price: product.price,
    customer_email: customerEmail,
    status: PANIC_STATUS.FORM_SUBMITTED,
    safety_status: "CHECKING",
    source: "PANIC_FORM",
    processed_at: panicNow_()
  });

  var safety = panicEvaluateSafety_(merged);
  if (safety.is_stop) {
    var safetyMail = panicCreateSafetyMessage_(customerEmail, merged, safety);
    panicUpdateState_(paymentId, {
      status: PANIC_STATUS.SAFETY_STOP,
      safety_status: "STOP",
      doc_url: "",
      pdf_url: "",
      doc_file_id: "",
      pdf_file_id: "",
      draft_id: safetyMail.draft_id || "",
      processed_at: panicNow_(),
      error_message: ""
    });
    panicAppendLog_({
      payment_id: paymentId,
      product_key: product.product_key,
      variation_id: state.variation_id,
      sku: product.sku,
      price: product.price,
      customer_email: customerEmail,
      status: PANIC_STATUS.SAFETY_STOP,
      safety_status: "STOP",
      source: "SAFETY_CHECK",
      processed_at: panicNow_(),
      draft_id: safetyMail.draft_id || "",
      message: "Safety keywords or danger flag matched: " + safety.matched_keywords.join(", ")
    });
    return {
      ok: true,
      status: PANIC_STATUS.SAFETY_STOP,
      payment_id: paymentId,
      gmail_mode: safetyMail.mode
    };
  }

  var deliveryState = panicFindStateByPaymentId_(paymentId);
  var docResult = null;
  if (deliveryState.pdf_file_id && deliveryState.pdf_url && deliveryState.status === PANIC_STATUS.PDF_CREATED) {
    docResult = {
      doc_url: deliveryState.doc_url || "",
      pdf_url: deliveryState.pdf_url || "",
      doc_file_id: deliveryState.doc_file_id || "",
      pdf_file_id: deliveryState.pdf_file_id || ""
    };
  } else {
    docResult = panicCreateDocumentAndPdf_(merged);
    panicUpdateState_(paymentId, {
      status: PANIC_STATUS.PDF_CREATED,
      safety_status: "CLEAR",
      doc_url: docResult.doc_url,
      pdf_url: docResult.pdf_url,
      doc_file_id: docResult.doc_file_id,
      pdf_file_id: docResult.pdf_file_id,
      processed_at: panicNow_()
    });
    panicAppendLog_({
      payment_id: paymentId,
      product_key: product.product_key,
      variation_id: state.variation_id,
      sku: product.sku,
      price: product.price,
      customer_email: customerEmail,
      status: PANIC_STATUS.PDF_CREATED,
      safety_status: "CLEAR",
      doc_url: docResult.doc_url,
      pdf_url: docResult.pdf_url,
      doc_file_id: docResult.doc_file_id,
      pdf_file_id: docResult.pdf_file_id,
      source: "DOC_PDF",
      processed_at: panicNow_()
    });
  }

  var deliveryMail = panicCreateDeliveryMessage_(customerEmail, merged, docResult);
  panicUpdateState_(paymentId, {
    status: PANIC_STATUS.DELIVERED,
    safety_status: "CLEAR",
    draft_id: deliveryMail.draft_id || "",
    processed_at: panicNow_(),
    error_message: ""
  });
  panicAppendLog_({
    payment_id: paymentId,
    product_key: product.product_key,
    variation_id: state.variation_id,
    sku: product.sku,
    price: product.price,
    customer_email: customerEmail,
    status: PANIC_STATUS.DELIVERED,
    safety_status: "CLEAR",
    doc_url: docResult.doc_url,
    pdf_url: docResult.pdf_url,
    doc_file_id: docResult.doc_file_id,
    pdf_file_id: docResult.pdf_file_id,
    draft_id: deliveryMail.draft_id || "",
    source: "GMAIL_" + deliveryMail.mode,
    processed_at: panicNow_()
  });

  return {
    ok: true,
    status: PANIC_STATUS.DELIVERED,
    payment_id: paymentId,
    doc_url: docResult.doc_url,
    pdf_url: docResult.pdf_url,
    gmail_mode: deliveryMail.mode
  };
}

function panicRenderForm_(params) {
  var paymentId = String(params.payment_id || "");
  var token = String(params.token || "");
  var state = paymentId ? panicFindStateByPaymentId_(paymentId) : null;

  if (!paymentId || !token || !state || String(state.token || "") !== token) {
    return HtmlService.createHtmlOutput(panicBuildMessageHtml_(
      "フォームを表示できません",
      "URLの情報を確認できませんでした。購入後に届いた最新のフォームURLから開いてください。"
    )).setTitle("BRIDGE 相談前整理フォーム");
  }

  if (state.status === PANIC_STATUS.DELIVERED || state.status === PANIC_STATUS.SAFETY_STOP) {
    return HtmlService.createHtmlOutput(panicBuildMessageHtml_(
      "受付済みです",
      "この payment_id はすでに受付済みです。重複したPDF作成や通常納品は行いません。"
    )).setTitle("BRIDGE 相談前整理フォーム");
  }

  var productKey = panicEscapeHtml_(state.product_key || params.product_key || "");
  var actionUrl = panicEscapeHtml_(panicGetWebAppUrl_());
  var html = "";
  html += "<!doctype html><html><head><meta charset=\"UTF-8\">";
  html += "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">";
  html += "<title>BRIDGE 相談前整理フォーム</title>";
  html += "<style>";
  html += "body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;margin:0;background:#f7f7f5;color:#222;}";
  html += "main{max-width:760px;margin:0 auto;padding:28px 18px 40px;}";
  html += "h1{font-size:24px;margin:0 0 8px;}p{line-height:1.7;}label{display:block;font-weight:700;margin:18px 0 6px;}";
  html += "input,textarea,select{box-sizing:border-box;width:100%;font:inherit;border:1px solid #cfcfc8;border-radius:6px;padding:10px;background:#fff;}";
  html += "textarea{min-height:92px;resize:vertical;}.hint{font-size:13px;color:#666;margin:3px 0 0;}";
  html += ".meta{font-size:13px;color:#555;background:#fff;border:1px solid #ddd;padding:10px;border-radius:6px;margin:16px 0;}";
  html += "button{margin-top:22px;border:0;border-radius:6px;background:#1f2937;color:#fff;padding:12px 18px;font-weight:700;cursor:pointer;}";
  html += "</style></head><body><main>";
  html += "<h1>相談前整理フォーム</h1>";
  html += "<p>次に相談するときに伝える情報を短く整理するためのフォームです。分からない項目は「不明」で大丈夫です。</p>";
  html += "<div class=\"meta\">product_key: " + productKey + "<br>payment_id: " + panicEscapeHtml_(paymentId) + "</div>";
  html += "<form method=\"post\" action=\"" + actionUrl + "\">";
  html += "<input type=\"hidden\" name=\"action\" value=\"panic_form_submit\">";
  html += "<input type=\"hidden\" name=\"payment_id\" value=\"" + panicEscapeHtml_(paymentId) + "\">";
  html += "<input type=\"hidden\" name=\"product_key\" value=\"" + productKey + "\">";
  html += "<input type=\"hidden\" name=\"variation_id\" value=\"" + panicEscapeHtml_(state.variation_id || "") + "\">";
  html += "<input type=\"hidden\" name=\"token\" value=\"" + panicEscapeHtml_(token) + "\">";
  html += panicInputHtml_("display_name", "氏名または呼び名", "text");
  html += panicInputHtml_("customer_email", "メールアドレス", "email", state.customer_email || "");
  html += panicTextareaHtml_("current_issue", "今困っている内容");
  html += panicInputHtml_("relationship", "相手との関係", "text");
  html += panicInputHtml_("started_when", "いつ頃からの問題か", "text");
  html += panicInputHtml_("amount_or_impact", "金額または影響", "text");
  html += panicTextareaHtml_("evidence", "すでにある証拠");
  html += panicTextareaHtml_("biggest_problem_today", "今日一番困っていること");
  html += "<label for=\"danger_flag\">命や身体の危険があるか</label>";
  html += "<select id=\"danger_flag\" name=\"danger_flag\">";
  html += "<option value=\"no\">今すぐの危険はない</option>";
  html += "<option value=\"unknown\">不明</option>";
  html += "<option value=\"yes\">危険がある</option>";
  html += "</select><p class=\"hint\">分からない場合は「不明」で大丈夫です。</p>";
  html += panicTextareaHtml_("free_note", "自由記入");
  html += "<button type=\"submit\">送信する</button>";
  html += "</form></main></body></html>";

  return HtmlService.createHtmlOutput(html).setTitle("BRIDGE 相談前整理フォーム");
}

function panicInputHtml_(name, label, type, value) {
  var html = "";
  html += "<label for=\"" + panicEscapeHtml_(name) + "\">" + panicEscapeHtml_(label) + "</label>";
  html += "<input id=\"" + panicEscapeHtml_(name) + "\" name=\"" + panicEscapeHtml_(name) + "\" type=\"" + panicEscapeHtml_(type || "text") + "\" value=\"" + panicEscapeHtml_(value || "") + "\">";
  html += "<p class=\"hint\">…1428 tokens truncated…ご入力ください。\n";
  body += formUrl + "\n\n";
  body += "分からない項目は「不明」で大丈夫です。\n";
  body += "命や身体の危険がある場合は、フォーム入力よりも安全確保を優先してください。\n\n";
  body += "product_key: " + state.product_key + "\n";
  body += "payment_id: " + state.payment_id + "\n";
  return panicCreateOrSendEmail_(to, subject, body, [], "FORM_LINK");
}

function panicCreateDeliveryMessage_(to, formData, docResult) {
  panicAssertUsableEmail_(to);
  var subject = "【BRIDGE】相談前整理PDFを作成しました";
  var body = "";
  body += "BRIDGEです。\n\n";
  body += "ご入力内容をもとに、相談前整理PDFを作成しました。\n";
  body += "次に相談するときに、状況を短く伝えるための整理資料としてご利用ください。\n\n";
  body += "PDF URL: " + docResult.pdf_url + "\n\n";
  body += "このPDFは入力内容の整理であり、法律相談、医療相談、代理交渉、請求代行、回収保証ではありません。\n";
  body += "命や身体の危険がある場合は、119/110、身近な人、地域の相談窓口などに連絡してください。\n\n";
  body += "payment_id: " + formData.payment_id + "\n";

  var attachments = [];
  if (docResult.pdf_file_id) {
    attachments.push(DriveApp.getFileById(docResult.pdf_file_id).getBlob());
  }
  return panicCreateOrSendEmail_(to, subject, body, attachments, "DELIVERY");
}

function panicCreateSafetyMessage_(to, formData, safety) {
  panicAssertUsableEmail_(to);
  var subject = "【BRIDGE】安全を優先したご案内";
  var body = "";
  body += "BRIDGEです。\n\n";
  body += "ご入力内容に、命や身体の危険が含まれる可能性があるため、通常の相談前整理PDF作成は停止しました。\n";
  body += "この商品では緊急対応、医療判断、法律判断はできません。\n\n";
  body += "今すぐ危険がある場合は、119/110、身近な人、地域の相談窓口などに連絡してください。\n";
  body += "安全な場所に移動できる場合は、まず安全確保を優先してください。\n\n";
  body += "payment_id: " + formData.payment_id + "\n";
  if (safety && safety.matched_keywords && safety.matched_keywords.length) {
    body += "safety_status: STOP\n";
  }
  return panicCreateOrSendEmail_(to, subject, body, [], "SAFETY_STOP");
}

function panicCreateOrSendEmail_(to, subject, body, attachments, label) {
  var mode = panicGetGmailMode_();
  var options = {
    name: "BRIDGE",
    attachments: attachments || []
  };

  if (mode === "SEND") {
    GmailApp.sendEmail(to, subject, body, options);
    return {
      mode: "SEND",
      draft_id: "",
      label: label || ""
    };
  }

  var draft = GmailApp.createDraft(to, subject, body, options);
  return {
    mode: "DRAFT",
    draft_id: draft.getId ? draft.getId() : "",
    label: label || ""
  };
}

function panicGetGmailMode_() {
  var value = PropertiesService.getScriptProperties().getProperty(PANIC_CONFIG.gmailModeProperty);
  value = String(value || "DRAFT").toUpperCase();
  return value === "SEND" ? "SEND" : "DRAFT";
}

function panicIsPanicFormPost_(e) {
  return !!(e && e.parameter && (
    e.parameter.action === "panic_form_submit" ||
    e.parameter.mode === "panic_form_submit"
  ));
}

function panicParseJsonPost_(e) {
  if (!e || !e.postData || !e.postData.contents) {
    return null;
  }
  var contents = String(e.postData.contents || "").trim();
  if (!contents || (contents.charAt(0) !== "{" && contents.charAt(0) !== "[")) {
    return null;
  }
  try {
    return JSON.parse(contents);
  } catch (err) {
    return null;
  }
}

function panicExtractPaymentContext_(payload) {
  var payment = panicGetFirstPath_(payload, [
    "payment",
    "data.object.payment",
    "data.object.payment_updated.payment",
    "event.data.object.payment"
  ]) || {};

  var paymentId = panicFirstNonEmpty_([
    payload.payment_id,
    payload.paymentId,
    payment.id,
    panicFindFirstValueByKeys_(payload, ["payment_id", "paymentId"])
  ]);

  var variationId = panicFindKnownVariationId_(payload);
  var customerEmail = panicFirstNonEmpty_([
    payload.customer_email,
    payload.buyer_email_address,
    payload.email,
    payment.buyer_email_address,
    payment.customer_email,
    panicFindFirstValueByKeys_(payload, ["customer_email", "buyer_email_address", "email_address", "email"])
  ]);

  var amount = panicFirstNonEmpty_([
    payload.amount,
    payload.total_money && payload.total_money.amount,
    payment.amount_money && payment.amount_money.amount,
    panicFindFirstValueByKeys_(payload, ["amount", "amount_money"])
  ]);

  return {
    payment_id: paymentId ? String(paymentId) : "",
    variation_id: variationId ? String(variationId) : "",
    customer_email: customerEmail ? String(customerEmail) : "",
    amount: amount || "",
    source: "SQUARE_WEBHOOK"
  };
}

function panicFindKnownVariationId_(value) {
  if (value === null || value === undefined) {
    return "";
  }

  if (typeof value === "string") {
    return PANIC_PRODUCT_MAP[value] ? value : "";
  }

  if (typeof value !== "object") {
    return "";
  }

  if (Array.isArray(value)) {
    for (var i = 0; i < value.length; i++) {
      var foundInArray = panicFindKnownVariationId_(value[i]);
      if (foundInArray) {
        return foundInArray;
      }
    }
    return "";
  }

  var keys = Object.keys(value);
  for (var j = 0; j < keys.length; j++) {
    var key = keys[j];
    var item = value[key];
    if (
      key === "variation_id" ||
      key === "variationId" ||
      key === "catalog_object_id" ||
      key === "catalogObjectId" ||
      key === "catalog_objectId"
    ) {
      if (PANIC_PRODUCT_MAP[String(item || "")]) {
        return String(item);
      }
    }
  }

  for (var k = 0; k < keys.length; k++) {
    var found = panicFindKnownVariationId_(value[keys[k]]);
    if (found) {
      return found;
    }
  }
  return "";
}

function panicFindFirstValueByKeys_(value, wantedKeys) {
  if (value === null || value === undefined || typeof value !== "object") {
    return "";
  }

  if (Array.isArray(value)) {
    for (var i = 0; i < value.length; i++) {
      var foundInArray = panicFindFirstValueByKeys_(value[i], wantedKeys);
      if (foundInArray) {
        return foundInArray;
      }
    }
    return "";
  }

  for (var j = 0; j < wantedKeys.length; j++) {
    if (value[wantedKeys[j]]) {
      return value[wantedKeys[j]];
    }
  }

  var keys = Object.keys(value);
  for (var k = 0; k < keys.length; k++) {
    var found = panicFindFirstValueByKeys_(value[keys[k]], wantedKeys);
    if (found) {
      return found;
    }
  }
  return "";
}

function panicGetFirstPath_(obj, paths) {
  for (var i = 0; i < paths.length; i++) {
    var value = panicGetPath_(obj, paths[i]);
    if (value) {
      return value;
    }
  }
  return null;
}

function panicGetPath_(obj, path) {
  var current = obj;
  var parts = String(path).split(".");
  for (var i = 0; i < parts.length; i++) {
    if (!current || current[parts[i]] === undefined || current[parts[i]] === null) {
      return null;
    }
    current = current[parts[i]];
  }
  return current;
}

function panicSetup_() {
  panicGetStateSheet_();
  panicGetLogSheet_();
  return {
    ok: true,
    state_sheet: PANIC_CONFIG.stateSheetName,
    log_sheet: PANIC_CONFIG.logSheetName,
    gmail_mode: panicGetGmailMode_(),
    web_app_url: panicGetWebAppUrl_()
  };
}

function panicGetStateSheet_() {
  return panicGetSheet_(PANIC_CONFIG.stateSheetName, PANIC_STATE_HEADERS);
}

function panicGetLogSheet_() {
  return panicGetSheet_(PANIC_CONFIG.logSheetName, PANIC_LOG_HEADERS);
}

function panicGetSheet_(name, headers) {
  var spreadsheet = panicGetSpreadsheet_();
  var sheet = spreadsheet.getSheetByName(name);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(name);
  }
  panicEnsureHeaders_(sheet, headers);
  return sheet;
}

function panicGetSpreadsheet_() {
  var props = PropertiesService.getScriptProperties();
  var spreadsheetId = props.getProperty(PANIC_CONFIG.spreadsheetIdProperty);
  if (spreadsheetId) {
    return SpreadsheetApp.openById(spreadsheetId);
  }

  var active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) {
    return active;
  }

  throw new Error("Set Script Property " + PANIC_CONFIG.spreadsheetIdProperty + " to the existing BRIDGE OS spreadsheet ID.");
}

function panicEnsureHeaders_(sheet, requiredHeaders) {
  if (sheet.getLastRow() === 0 || sheet.getLastColumn() === 0) {
    sheet.getRange(1, 1, 1, requiredHeaders.length).setValues([requiredHeaders]);
    return;
  }

  var lastCol = sheet.getLastColumn();
  var existing = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var missing = [];
  for (var i = 0; i < requiredHeaders.length; i++) {
    if (existing.indexOf(requiredHeaders[i]) === -1) {
      missing.push(requiredHeaders[i]);
    }
  }
  if (missing.length) {
    sheet.getRange(1, lastCol + 1, 1, missing.length).setValues([missing]);
  }
}

function panicAppendState_(entry) {
  var sheet = panicGetStateSheet_();
  panicAppendRowObject_(sheet, panicGetHeaders_(sheet), entry);
}

function panicAppendLog_(entry) {
  var sheet = panicGetLogSheet_();
  var enriched = panicMergeObjects_({
    timestamp: panicNow_(),
    processed_at: panicNow_()
  }, entry || {});
  panicAppendRowObject_(sheet, panicGetHeaders_(sheet), enriched);
}

function panicUpdateState_(paymentId, patch) {
  var sheet = panicGetStateSheet_();
  var headers = panicGetHeaders_(sheet);
  var found = panicFindStateRow_(paymentId);
  var update = panicMergeObjects_({}, patch || {});
  update.payment_id = paymentId;
  update.updated_at = panicNow_();

  if (!found) {
    if (!update.timestamp) {
      update.timestamp = panicNow_();
    }
    panicAppendRowObject_(sheet, headers, update);
    return panicFindStateByPaymentId_(paymentId);
  }

  var keys = Object.keys(update);
  for (var i = 0; i < keys.length; i++) {
    var col = headers.indexOf(keys[i]) + 1;
    if (col > 0) {
      sheet.getRange(found.row, col).setValue(update[keys[i]]);
    }
  }
  return panicFindStateByPaymentId_(paymentId);
}

function panicFindStateByPaymentId_(paymentId) {
  var found = panicFindStateRow_(paymentId);
  return found ? found.record : null;
}

function panicFindStateRow_(paymentId) {
  if (!paymentId) {
    return null;
  }
  var sheet = panicGetStateSheet_();
  var values = sheet.getDataRange().getValues();
  if (values.length < 2) {
    return null;
  }
  var headers = values[0];
  var paymentCol = headers.indexOf("payment_id");
  if (paymentCol === -1) {
    return null;
  }

  for (var i = values.length - 1; i >= 1; i--) {
    if (String(values[i][paymentCol]) === String(paymentId)) {
      return {
        row: i + 1,
        record: panicObjectFromRow_(headers, values[i])
      };
    }
  }
  return null;
}

function panicAppendRowObject_(sheet, headers, object) {
  var row = [];
  for (var i = 0; i < headers.length; i++) {
    var key = headers[i];
    row.push(object && object[key] !== undefined ? object[key] : "");
  }
  sheet.appendRow(row);
}

function panicGetHeaders_(sheet) {
  return sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
}

function panicObjectFromRow_(headers, row) {
  var object = {};
  for (var i = 0; i < headers.length; i++) {
    object[headers[i]] = row[i];
  }
  return object;
}

function panicGetOutputFolder_() {
  var props = PropertiesService.getScriptProperties();
  var folderId = props.getProperty(PANIC_CONFIG.outputFolderIdProperty);
  if (folderId) {
    return DriveApp.getFolderById(folderId);
  }

  var folders = DriveApp.getFoldersByName("BRIDGE_Panic_PDF_Delivery_TEST");
  if (folders.hasNext()) {
    return folders.next();
  }
  return DriveApp.createFolder("BRIDGE_Panic_PDF_Delivery_TEST");
}

function panicBuildFormUrl_(paymentId, variationId, productKey, token) {
  var baseUrl = panicGetWebAppUrl_();
  var params = {
    mode: "panic_form",
    payment_id: paymentId,
    variation_id: variationId,
    product_key: productKey,
    token: token
  };
  var query = [];
  var keys = Object.keys(params);
  for (var i = 0; i < keys.length; i++) {
    query.push(encodeURIComponent(keys[i]) + "=" + encodeURIComponent(params[keys[i]]));
  }
  return baseUrl + (baseUrl.indexOf("?") === -1 ? "?" : "&") + query.join("&");
}

function panicGetWebAppUrl_() {
  var props = PropertiesService.getScriptProperties();
  var configured = props.getProperty(PANIC_CONFIG.webAppUrlProperty);
  if (configured) {
    return configured;
  }
  var deployedUrl = ScriptApp.getService().getUrl();
  if (deployedUrl) {
    return deployedUrl;
  }
  throw new Error("Deploy the GAS as a web app or set Script Property " + PANIC_CONFIG.webAppUrlProperty + ".");
}

function panicBuildFileBaseName_(productKey, paymentId) {
  return [
    "consultation_prep_pdf",
    panicSanitizeFilePart_(productKey),
    panicSanitizeFilePart_(paymentId),
    Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyyMMdd_HHmmss")
  ].join("_");
}

function panicSanitizeFilePart_(value) {
  return String(value || "unknown").replace(/[\\\/:*?"<>|#%{}~&]/g, "_").substring(0, 80);
}

function panicCreateToken_() {
  return Utilities.getUuid().replace(/-/g, "");
}

function panicNow_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd HH:mm:ss");
}

function panicNormalizeEmail_(value) {
  return String(value || "").trim();
}

function panicAssertUsableEmail_(email) {
  var normalized = panicNormalizeEmail_(email);
  if (!normalized) {
    throw new Error("customer_email is required.");
  }
  if (normalized.toLowerCase() === "test@example.com") {
    throw new Error("test@example.com is not allowed.");
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized)) {
    throw new Error("Invalid customer_email: " + normalized);
  }
}

function panicValueOrUnknown_(value) {
  var text = String(value || "").trim();
  return text ? text : "不明";
}

function panicFirstNonEmpty_(values) {
  for (var i = 0; i < values.length; i++) {
    if (values[i] !== undefined && values[i] !== null && String(values[i]).trim() !== "") {
      return values[i];
    }
  }
  return "";
}

function panicMergeObjects_(base, overlay) {
  var result = {};
  var key;
  for (key in base) {
    if (Object.prototype.hasOwnProperty.call(base, key)) {
      result[key] = base[key];
    }
  }
  for (key in overlay) {
    if (Object.prototype.hasOwnProperty.call(overlay, key)) {
      result[key] = overlay[key];
    }
  }
  return result;
}

function panicErrorMessage_(err) {
  return err && err.message ? err.message : String(err);
}

function panicEscapeHtml_(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function panicJsonOutput_(object) {
  return ContentService
    .createTextOutput(JSON.stringify(object))
    .setMimeType(ContentService.MimeType.JSON);
}

function panicBuildSubmitResultHtml_(result) {
  if (result && result.ok) {
    var title = result.status === PANIC_STATUS.SAFETY_STOP ? "受付しました" : "送信を受け付けました";
    var message = result.status === PANIC_STATUS.SAFETY_STOP
      ? "安全を優先するため、通常の相談前整理PDF作成は停止しました。案内メールをご確認ください。"
      : "内容を受け付けました。相談前整理PDFの作成状況は記録されています。";
    return panicBuildMessageHtml_(title, message);
  }
  return panicBuildMessageHtml_(
    "送信を受け付けられませんでした",
    result && result.error_message ? result.error_message : "時間をおいて再度お試しください。"
  );
}

function panicBuildMessageHtml_(title, message) {
  var html = "";
  html += "<!doctype html><html><head><meta charset=\"UTF-8\">";
  html += "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">";
  html += "<title>" + panicEscapeHtml_(title) + "</title>";
  html += "<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;margin:0;background:#f7f7f5;color:#222;}";
  html += "main{max-width:680px;margin:0 auto;padding:36px 18px;}h1{font-size:24px;}p{line-height:1.7;}</style>";
  html += "</head><body><main>";
  html += "<h1>" + panicEscapeHtml_(title) + "</h1>";
  html += "<p>" + panicEscapeHtml_(message) + "</p>";
  html += "</main></body></html>";
  return html;
}

function panicResolveTestRecipient_() {
  var props = PropertiesService.getScriptProperties();
  var configured = panicNormalizeEmail_(props.getProperty(PANIC_CONFIG.testRecipientProperty));
  if (configured) {
    panicAssertUsableEmail_(configured);
    return configured;
  }

  var userEmail = "";
  try {
    userEmail = panicNormalizeEmail_(Session.getEffectiveUser().getEmail());
  } catch (err) {
    userEmail = "";
  }
  if (!userEmail) {
    throw new Error("Set Script Property " + PANIC_CONFIG.testRecipientProperty + " before running tests.");
  }
  panicAssertUsableEmail_(userEmail);
  return userEmail;
}

function panicTestPaymentId_(prefix) {
  return prefix + "_" + Utilities.getUuid().replace(/-/g, "").substring(0, 12);
}

function panicBuildNormalTestForm_(paymentId, token) {
  return {
    action: "panic_form_submit",
    payment_id: paymentId,
    product_key: "panic_nav_1000",
    variation_id: "AQ5KGY3VPS42RXMIIVTHVIBA",
    token: token,
    display_name: "テスト利用者",
    customer_email: panicResolveTestRecipient_(),
    current_issue: "取引の経緯を整理したい。判断はまだ不要で、時系列をまとめたい。",
    relationship: "取引相手",
    started_when: "2026年6月頃から",
    amount_or_impact: "1,000円商品のテスト",
    evidence: "メール、見積書、チャット履歴",
    biggest_problem_today: "次に相談するときに何を伝えるか整理したい",
    danger_flag: "no",
    free_note: "これは実決済なしのテストです。"
  };
}

function test_panic_nav_1000_form_create_() {
  panicSetup_();
  var paymentId = panicTestPaymentId_("test_panic_nav_1000");
  return panicCreateFormForPayment_({
    payment_id: paymentId,
    variation_id: "AQ5KGY3VPS42RXMIIVTHVIBA",
    customer_email: panicResolveTestRecipient_(),
    source: "TEST_FORM_CREATE"
  });
}

function test_panic_nav_1000_form_submit_normal_() {
  panicSetup_();
  var created = test_panic_nav_1000_form_create_();
  var state = panicFindStateByPaymentId_(created.payment_id);
  var formData = panicBuildNormalTestForm_(created.payment_id, state.token);
  return panicProcessFormSubmit_(formData);
}

function test_panic_nav_1000_safety_stop_() {
  panicSetup_();
  var paymentId = panicTestPaymentId_("test_panic_safety");
  var created = panicCreateFormForPayment_({
    payment_id: paymentId,
    variation_id: "AQ5KGY3VPS42RXMIIVTHVIBA",
    customer_email: panicResolveTestRecipient_(),
    source: "TEST_SAFETY_CREATE"
  });
  var state = panicFindStateByPaymentId_(created.payment_id);
  var formData = panicBuildNormalTestForm_(created.payment_id, state.token);
  formData.danger_flag = "yes";
  formData.current_issue = "今すぐ危ない。身体の危険がある。";
  return panicProcessFormSubmit_(formData);
}

function test_panic_duplicate_payment_() {
  panicSetup_();
  var paymentId = panicTestPaymentId_("test_panic_duplicate");
  var first = panicCreateFormForPayment_({
    payment_id: paymentId,
    variation_id: "AQ5KGY3VPS42RXMIIVTHVIBA",
    customer_email: panicResolveTestRecipient_(),
    source: "TEST_DUPLICATE_FIRST"
  });
  var second = panicCreateFormForPayment_({
    payment_id: paymentId,
    variation_id: "AQ5KGY3VPS42RXMIIVTHVIBA",
    customer_email: panicResolveTestRecipient_(),
    source: "TEST_DUPLICATE_SECOND"
  });
  return {
    first: first,
    second: second
  };
}

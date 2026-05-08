/**
 * Webフォーム送信用エンドポイント。
 * TEST_MODE=trueではメール送信せず、Leads / Mail_Log / Reminder_Logへ記録する。
 */

function doPost(e) {
  var payload = {};
  try {
    efValidateWebhookToken_(e);
    payload = efParsePayload_(e);
    var lead = efNormalizeLead_(payload);
    efSaveLead_(lead);
    var reply = efBuildAutoReply_(lead);
    efRecordMail_(reply);
    var adminNotice = efBuildAdminNotice_(lead);
    efRecordMail_(adminNotice);
    efScheduleReminder_(lead);
    return efJsonResponse_({ ok: true, test_mode: efIsTestMode_(), lead_id: lead.lead_id });
  } catch (error) {
    efLogSystem_('ERROR', 'doPost', error.message, { stack: error.stack });
    efAddDlq_('doPost', error, payload || {});
    return efJsonResponse_({ ok: false, error: error.message }, 500);
  }
}

function efValidateWebhookToken_(e) {
  var expected = efGetProperty_('ESTIMATE_FRONT_WEBHOOK_TOKEN', '');
  if (!expected) {
    return;
  }
  var token = e && e.parameter ? e.parameter.token : '';
  if (token !== expected) {
    throw new Error('invalid webhook token');
  }
}

function efParsePayload_(e) {
  if (!e || !e.postData || !e.postData.contents) {
    return {};
  }
  var contents = e.postData.contents;
  var type = e.postData.type || '';
  if (type.indexOf('application/json') !== -1) {
    return JSON.parse(contents);
  }
  return e.parameter || {};
}

function efNormalizeLead_(payload) {
  var customerId = efText_(payload.customer_id) || efGetProperty_('ESTIMATE_FRONT_DEFAULT_CUSTOMER_ID', ESTIMATE_FRONT.DEFAULTS.DEFAULT_CUSTOMER_ID);
  return {
    received_at: efNow_(),
    lead_id: efText_(payload.lead_id) || efUuid_('lead'),
    customer_id: customerId,
    name: efText_(payload.name || payload.customer_name),
    email: efText_(payload.email),
    phone: efText_(payload.phone || payload.tel),
    area: efText_(payload.area || payload.address_area),
    request_type: efText_(payload.request_type || payload.work_type),
    request_detail: efText_(payload.request_detail || payload.message),
    desired_timing: efText_(payload.desired_timing),
    budget_range: efText_(payload.budget_range),
    has_photos: efText_(payload.has_photos || payload.photos),
    reply_status: 'logged_only',
    deposit_status: 'not_required_checked_later',
    notes: efText_(payload.notes)
  };
}

function efJsonResponse_(body, status) {
  return ContentService
    .createTextOutput(JSON.stringify(body))
    .setMimeType(ContentService.MimeType.JSON);
}

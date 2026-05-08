/**
 * BRIDGE 見積前受付フロント - 00_config.gs
 * 販売検証用MVP。初期値はTEST_MODE=trueで、本番メールを送信しない。
 */

var ESTIMATE_FRONT = {
  SHEETS: {
    SETTINGS: 'Settings',
    CUSTOMERS: 'Customers',
    LEADS: 'Leads',
    MAIL_LOG: 'Mail_Log',
    REMINDER_LOG: 'Reminder_Log',
    SYSTEM_LOG: 'System_Log',
    SYSTEM_DLQ: 'System_DLQ'
  },
  HEADERS: {
    Settings: ['key', 'value', 'notes'],
    Customers: ['customer_id', 'business_name', 'owner_email', 'industry', 'area', 'line_url', 'square_payment_link', 'deposit_label', 'deposit_amount', 'status', 'created_at', 'notes'],
    Leads: ['received_at', 'lead_id', 'customer_id', 'name', 'email', 'phone', 'area', 'request_type', 'request_detail', 'desired_timing', 'budget_range', 'has_photos', 'reply_status', 'deposit 안내_status', 'notes'],
    Mail_Log: ['ts', 'lead_id', 'customer_id', 'mail_type', 'to', 'subject', 'body', 'status', 'notes'],
    Reminder_Log: ['ts', 'lead_id', 'customer_id', 'reminder_type', 'scheduled_at', 'status', 'notes'],
    System_Log: ['ts', 'level', 'function_name', 'message', 'detail_json'],
    System_DLQ: ['ts', 'function_name', 'error_message', 'payload_json', 'status', 'notes']
  },
  DEFAULTS: {
    TEST_MODE: true,
    REMINDER_HOURS: 24,
    DEFAULT_CUSTOMER_ID: 'demo_customer',
    SUPPORT_EMAIL: 'support@example.com',
    ADMIN_EMAIL: 'admin@example.com'
  }
};

function efGetScriptProperties_() {
  return PropertiesService.getScriptProperties();
}

function efGetProperty_(key, fallback) {
  var value = efGetScriptProperties_().getProperty(key);
  return value === null || value === '' ? fallback : value;
}

function efIsTestMode_() {
  var raw = efGetProperty_('ESTIMATE_FRONT_TEST_MODE', String(ESTIMATE_FRONT.DEFAULTS.TEST_MODE));
  return String(raw).toLowerCase() !== 'false';
}

function efGetControlSpreadsheet_() {
  var ssid = efGetProperty_('ESTIMATE_FRONT_CONTROL_SSID', '');
  if (!ssid) {
    return SpreadsheetApp.getActiveSpreadsheet();
  }
  return SpreadsheetApp.openById(ssid);
}

function efNow_() {
  return new Date();
}

function efUuid_(prefix) {
  return prefix + '_' + Utilities.getUuid().replace(/-/g, '').slice(0, 16);
}

function efJson_(value) {
  try {
    return JSON.stringify(value || {});
  } catch (error) {
    return JSON.stringify({ stringify_error: String(error) });
  }
}

function efText_(value) {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value).trim();
}

function efGetSheet_(sheetName) {
  var ss = efGetControlSpreadsheet_();
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
  }
  return sheet;
}

function efAppendRow_(sheetName, row) {
  var sheet = efGetSheet_(sheetName);
  sheet.appendRow(row);
}

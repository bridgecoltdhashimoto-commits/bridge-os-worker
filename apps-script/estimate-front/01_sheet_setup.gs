/**
 * 必要シートを作成し、ヘッダーと初期Settingsを配置する。
 */

function setupEstimateFrontSheets() {
  var ss = efGetControlSpreadsheet_();
  Object.keys(ESTIMATE_FRONT.HEADERS).forEach(function (sheetName) {
    var sheet = ss.getSheetByName(sheetName) || ss.insertSheet(sheetName);
    var headers = ESTIMATE_FRONT.HEADERS[sheetName];
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
    sheet.autoResizeColumns(1, headers.length);
  });
  efSeedSettings_();
  efEnsureDemoCustomer_();
  efLogSystem_('INFO', 'setupEstimateFrontSheets', 'setup completed', {});
}

function efSeedSettings_() {
  var sheet = efGetSheet_(ESTIMATE_FRONT.SHEETS.SETTINGS);
  var existing = efReadSettings_();
  var rows = [
    ['business_name', 'BRIDGEデモ外構', '自動返信に表示する事業者名'],
    ['owner_email', efGetProperty_('ESTIMATE_FRONT_ADMIN_EMAIL', ESTIMATE_FRONT.DEFAULTS.ADMIN_EMAIL), '事業者向け通知先メール'],
    ['industry', '外構', '業種'],
    ['area', '対応エリア未設定', '対応可能エリア'],
    ['line_url', '', '公式LINE URL'],
    ['square_payment_link', '', '事業者が作成したSquare決済リンク。GASでは作成しない'],
    ['deposit_label', '予約金', '予約金 / 着手金 / 現地調査費など'],
    ['deposit_amount', '', '必要な場合のみ金額を入力'],
    ['deposit_enabled', 'false', 'trueの場合のみ予約金/着手金案内を文面に追加'],
    ['reply_eta', '2営業日以内', '返信目安'],
    ['business_hours', '平日9:00-18:00', '営業時間'],
    ['site_visit_policy', '内容により現地調査を行います', '現地調査の有無'],
    ['unsupported_work', '対応できない工事は個別に案内します', '対応できない工事'],
    ['cancel_notice', '日程変更やキャンセルは早めにご連絡ください', 'キャンセル注意事項'],
    ['support_email', efGetProperty_('ESTIMATE_FRONT_SUPPORT_EMAIL', ESTIMATE_FRONT.DEFAULTS.SUPPORT_EMAIL), '問い合わせ先']
  ];

  rows.forEach(function (row) {
    if (!Object.prototype.hasOwnProperty.call(existing, row[0])) {
      sheet.appendRow(row);
    }
  });
}

function efEnsureDemoCustomer_() {
  var customerId = efGetProperty_('ESTIMATE_FRONT_DEFAULT_CUSTOMER_ID', ESTIMATE_FRONT.DEFAULTS.DEFAULT_CUSTOMER_ID);
  var sheet = efGetSheet_(ESTIMATE_FRONT.SHEETS.CUSTOMERS);
  var values = sheet.getDataRange().getValues();
  var exists = values.some(function (row, index) {
    return index > 0 && row[0] === customerId;
  });
  if (!exists) {
    var settings = efReadSettings_();
    sheet.appendRow([
      customerId,
      settings.business_name || 'BRIDGEデモ外構',
      settings.owner_email || efGetProperty_('ESTIMATE_FRONT_ADMIN_EMAIL', ESTIMATE_FRONT.DEFAULTS.ADMIN_EMAIL),
      settings.industry || '外構',
      settings.area || '',
      settings.line_url || '',
      settings.square_payment_link || '',
      settings.deposit_label || '予約金',
      settings.deposit_amount || '',
      'test',
      efNow_(),
      '販売検証用のデモ顧客'
    ]);
  }
}

function efReadSettings_() {
  var sheet = efGetSheet_(ESTIMATE_FRONT.SHEETS.SETTINGS);
  var values = sheet.getDataRange().getValues();
  var settings = {};
  values.slice(1).forEach(function (row) {
    if (row[0]) {
      settings[String(row[0])] = row[1];
    }
  });
  return settings;
}

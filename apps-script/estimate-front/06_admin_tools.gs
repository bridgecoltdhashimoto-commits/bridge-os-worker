/**
 * 管理・テスト用ツール。
 */

function efLogSystem_(level, functionName, message, detail) {
  try {
    efAppendRow_(ESTIMATE_FRONT.SHEETS.SYSTEM_LOG, [
      efNow_(),
      level,
      functionName,
      message,
      efJson_(detail || {})
    ]);
  } catch (error) {
    console.error('efLogSystem_ failed: ' + error.message);
  }
}

function efAddDlq_(functionName, error, payload) {
  try {
    efAppendRow_(ESTIMATE_FRONT.SHEETS.SYSTEM_DLQ, [
      efNow_(),
      functionName,
      error.message || String(error),
      efJson_(payload || {}),
      'open',
      '手動確認してください'
    ]);
  } catch (loggingError) {
    console.error('efAddDlq_ failed: ' + loggingError.message);
  }
}

function testEstimateFrontDoPost() {
  var event = {
    parameter: {},
    postData: {
      type: 'application/json',
      contents: JSON.stringify({
        name: '山田太郎',
        email: 'test@example.com',
        phone: '090-0000-0000',
        area: '大阪市',
        request_type: '外構',
        request_detail: 'カーポートとフェンスの相談です。',
        desired_timing: '1か月以内',
        budget_range: '未定',
        has_photos: 'あり'
      })
    }
  };
  return doPost(event);
}

function showEstimateFrontMode() {
  var message = 'ESTIMATE_FRONT_TEST_MODE=' + efIsTestMode_();
  Logger.log(message);
  return message;
}

function clearEstimateFrontTestLogs() {
  [
    ESTIMATE_FRONT.SHEETS.LEADS,
    ESTIMATE_FRONT.SHEETS.MAIL_LOG,
    ESTIMATE_FRONT.SHEETS.REMINDER_LOG,
    ESTIMATE_FRONT.SHEETS.SYSTEM_LOG,
    ESTIMATE_FRONT.SHEETS.SYSTEM_DLQ
  ].forEach(function (sheetName) {
    var sheet = efGetSheet_(sheetName);
    var lastRow = sheet.getLastRow();
    if (lastRow > 1) {
      sheet.deleteRows(2, lastRow - 1);
    }
  });
}

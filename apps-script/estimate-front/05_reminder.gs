/**
 * 未返信リマインド予定をReminder_Logへ残す。
 * TEST_MODE=trueでは送信しない。
 */

function efScheduleReminder_(lead) {
  var hours = Number(efGetProperty_('ESTIMATE_FRONT_REMINDER_HOURS', ESTIMATE_FRONT.DEFAULTS.REMINDER_HOURS));
  var scheduledAt = new Date(efNow_().getTime() + hours * 60 * 60 * 1000);
  efAppendRow_(ESTIMATE_FRONT.SHEETS.REMINDER_LOG, [
    efNow_(),
    lead.lead_id,
    lead.customer_id,
    'unreplied_lead_check',
    scheduledAt,
    efIsTestMode_() ? 'test_scheduled_not_sent' : 'scheduled_review_required',
    efIsTestMode_() ? 'TEST_MODE=trueのため予定のみ記録' : '送信前に未返信状況を確認'
  ]);
}

function runReminderDryRun() {
  efLogSystem_('INFO', 'runReminderDryRun', 'Reminder dry run executed. No email sent.', { test_mode: efIsTestMode_() });
}

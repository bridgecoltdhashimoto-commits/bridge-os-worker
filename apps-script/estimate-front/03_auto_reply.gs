/**
 * 顧客向け自動返信・事業者向け通知の文面を作成する。
 */

function efBuildAutoReply_(lead) {
  var settings = efReadSettings_();
  var businessName = settings.business_name || '受付担当';
  var subject = 'お問い合わせを受け付けました｜' + businessName;
  var body = [
    (lead.name || 'お客様') + ' 様',
    '',
    businessName + 'へのお問い合わせありがとうございます。',
    '以下の内容で見積前受付を確認しました。',
    '',
    '【ご依頼内容】',
    '工事種別：' + (lead.request_type || '未入力'),
    '対応エリア：' + (lead.area || '未入力'),
    '希望時期：' + (lead.desired_timing || '未入力'),
    '写真の有無：' + (lead.has_photos || '未入力'),
    '',
    '【返信目安】',
    settings.reply_eta || '2営業日以内',
    '',
    '【営業時間】',
    settings.business_hours || '平日9:00-18:00',
    '',
    '【現地調査について】',
    settings.site_visit_policy || '内容により現地調査を行います',
    '',
    '【対応できない工事】',
    settings.unsupported_work || '個別に案内します',
    '',
    '【キャンセル・日程変更について】',
    settings.cancel_notice || '日程変更やキャンセルは早めにご連絡ください'
  ];

  var depositText = efBuildDepositText_(settings);
  if (depositText) {
    body.push('', '【予約金/着手金のご案内】', depositText);
  }

  if (settings.line_url) {
    body.push('', '【公式LINE】', settings.line_url);
  }

  body.push('', '※このメールは見積前受付の確認です。工事可否、見積金額、契約条件は別途確認後にご案内します。');

  return {
    lead_id: lead.lead_id,
    customer_id: lead.customer_id,
    mail_type: 'customer_auto_reply',
    to: lead.email || '(email未入力)',
    subject: subject,
    body: body.join('\n'),
    status: efIsTestMode_() ? 'test_logged_not_sent' : 'ready_to_send',
    notes: efIsTestMode_() ? 'TEST_MODE=trueのため送信しない' : '本番送信前に文面確認が必要'
  };
}

function efBuildAdminNotice_(lead) {
  var settings = efReadSettings_();
  var to = settings.owner_email || efGetProperty_('ESTIMATE_FRONT_ADMIN_EMAIL', ESTIMATE_FRONT.DEFAULTS.ADMIN_EMAIL);
  var subject = '【見積前受付】新規問い合わせ ' + (lead.name || '氏名未入力');
  var body = [
    '新規問い合わせを受け付けました。',
    '',
    'lead_id: ' + lead.lead_id,
    'customer_id: ' + lead.customer_id,
    '氏名: ' + (lead.name || '未入力'),
    'メール: ' + (lead.email || '未入力'),
    '電話: ' + (lead.phone || '未入力'),
    'エリア: ' + (lead.area || '未入力'),
    '工事種別: ' + (lead.request_type || '未入力'),
    '希望時期: ' + (lead.desired_timing || '未入力'),
    '予算感: ' + (lead.budget_range || '未入力'),
    '写真: ' + (lead.has_photos || '未入力'),
    '',
    '詳細:',
    lead.request_detail || '未入力',
    '',
    '次の対応: Leadsシートを確認し、必要に応じて手動返信してください。'
  ].join('\n');

  return {
    lead_id: lead.lead_id,
    customer_id: lead.customer_id,
    mail_type: 'admin_notice',
    to: to,
    subject: subject,
    body: body,
    status: efIsTestMode_() ? 'test_logged_not_sent' : 'ready_to_send',
    notes: efIsTestMode_() ? 'TEST_MODE=trueのため送信しない' : '本番送信前に送信先確認が必要'
  };
}

function efBuildDepositText_(settings) {
  if (String(settings.deposit_enabled).toLowerCase() !== 'true') {
    return '';
  }
  var label = settings.deposit_label || '予約金';
  var amount = settings.deposit_amount || '';
  var link = settings.square_payment_link || '';
  if (!amount && !link) {
    return '';
  }
  var lines = [label + (amount ? '（' + amount + '）' : '') + 'が必要な場合は、内容確認後にご案内します。'];
  if (link) {
    lines.push('決済リンク: ' + link);
  }
  lines.push('Square決済リンクは事業者が作成したものを使用します。');
  return lines.join('\n');
}

function efRecordMail_(mail) {
  efAppendRow_(ESTIMATE_FRONT.SHEETS.MAIL_LOG, [
    efNow_(),
    mail.lead_id,
    mail.customer_id,
    mail.mail_type,
    mail.to,
    mail.subject,
    mail.body,
    mail.status,
    mail.notes
  ]);
}

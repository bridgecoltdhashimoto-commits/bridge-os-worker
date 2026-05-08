/**
 * Leadsシートへの問い合わせ台帳記録。
 */

function efSaveLead_(lead) {
  try {
    efAppendRow_(ESTIMATE_FRONT.SHEETS.LEADS, [
      lead.received_at,
      lead.lead_id,
      lead.customer_id,
      lead.name,
      lead.email,
      lead.phone,
      lead.area,
      lead.request_type,
      lead.request_detail,
      lead.desired_timing,
      lead.budget_range,
      lead.has_photos,
      lead.reply_status,
      lead.deposit_status,
      lead.notes
    ]);
  } catch (error) {
    efLogSystem_('ERROR', 'efSaveLead_', error.message, { lead: lead, stack: error.stack });
    efAddDlq_('efSaveLead_', error, lead);
    throw error;
  }
}

function findLeadById(leadId) {
  var sheet = efGetSheet_(ESTIMATE_FRONT.SHEETS.LEADS);
  var values = sheet.getDataRange().getValues();
  var headers = values[0] || [];
  for (var i = 1; i < values.length; i += 1) {
    if (values[i][1] === leadId) {
      return efRowToObject_(headers, values[i]);
    }
  }
  return null;
}

function efRowToObject_(headers, row) {
  var object = {};
  headers.forEach(function (header, index) {
    object[header] = row[index];
  });
  return object;
}

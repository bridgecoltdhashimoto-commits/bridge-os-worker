/**
 * BRIDGE OS: Autonomous Core
 */
function INITIALIZE_BRIDGE_OS() {
  const ss = SpreadsheetApp.create("BRIDGE_OS_CONTROL");
  PropertiesService.getScriptProperties().setProperty('SS_ID', ss.getId());
  const vault = ss.insertSheet("Interaction_Vault");
  vault.appendRow(["Timestamp", "Status", "Content"]);
  return "生成成功: " + ss.getUrl();
}

function getSystemSpreadsheet() {
  const id = PropertiesService.getScriptProperties().getProperty('SS_ID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
}

function doPost(e) {
  const ss = getSystemSpreadsheet();
  const vault = ss.getSheetByName("Interaction_Vault") || ss.insertSheet("Interaction_Vault");
  try {
    const rawData = e.postData.contents;
    const geminiDraft = callGemini(`Squareデータ解析: ${rawData}`);
    const finalProduct = callOpenAI(`BRIDGE OS基準で最終化せよ: ${geminiDraft}`);
    vault.appendRow([new Date(), "SUCCESS", finalProduct]);
    return ContentService.createTextOutput(JSON.stringify({status: "COMPLETED"}));
  } catch (err) {
    if (vault) vault.appendRow([new Date(), "ERROR", err.message]);
    return ContentService.createTextOutput("ERROR: " + err.message);
  }
}

function callGemini(prompt) {
  const key = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${key}`;
  const res = UrlFetchApp.fetch(url, {
    method: "post", contentType: "application/json",
    payload: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
  });
  return JSON.parse(res.getContentText()).candidates[0].content.parts[0].text;
}

function callOpenAI(prompt) {
  const key = PropertiesService.getScriptProperties().getProperty('OPENAI_API_KEY');
  const res = UrlFetchApp.fetch("https://api.openai.com/v1/chat/completions", {
    method: "post", headers: { Authorization: `Bearer ${key}` }, contentType: "application/json",
    payload: JSON.stringify({ model: "gpt-4-turbo", messages: [{ role: "user", content: prompt }] })
  });
  return JSON.parse(res.getContentText()).choices[0].message.content;
}

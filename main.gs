/**
 * BRIDGE OS: AI Orchestrator
 * Gemini (Drafting) -> OpenAI (Optimization)
 */
function doPost(e) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const vault = ss.getSheetByName("System_Interaction_Vault") || ss.insertSheet("System_Interaction_Vault");
  
  try {
    const rawData = e.postData.contents;
    
    // 1. Geminiによる戦略立案（ドラフト）
    const geminiDraft = callGemini(`Squareからの決済データ: ${rawData} を解析し、納品物のドラフトを作成せよ。`);
    
    // 2. OpenAIによる数学的整合性の検閲と最終化
    const finalProduct = callOpenAI(`以下のドラフトをBRIDGE OSの基準で最適化せよ: ${geminiDraft}`);
    
    // 3. 結果の記録（Vault）
    vault.appendRow([new Date(), "SUCCESS", finalProduct]);
    
    return ContentService.createTextOutput(JSON.stringify({status: "COMPLETED", data: finalProduct}));
    
  } catch (err) {
    vault.appendRow([new Date(), "ERROR", err.message]);
    return ContentService.createTextOutput("SYSTEM_ERROR");
  }
}

function callGemini(prompt) {
  const key = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${key}`;
  const res = UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
  });
  return JSON.parse(res.getContentText()).candidates[0].content.parts[0].text;
}

function callOpenAI(prompt) {
  const key = PropertiesService.getScriptProperties().getProperty('OPENAI_API_KEY');
  const res = UrlFetchApp.fetch("https://api.openai.com/v1/chat/completions", {
    method: "post",
    headers: { Authorization: `Bearer ${key}` },
    contentType: "application/json",
    payload: JSON.stringify({
      model: "gpt-4-turbo",
      messages: [{ role: "user", content: prompt }]
    })
  });
  return JSON.parse(res.getContentText()).choices[0].message.content;
}

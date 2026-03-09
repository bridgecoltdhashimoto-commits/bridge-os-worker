/**
 * BRIDGE OS: Autonomous Core
 * Gemini (Draft) -> OpenAI (Review) -> Auto-Provisioning
 */

// 【重要】最初にこの関数を「実行」してください
function INITIALIZE_BRIDGE_OS() {
  // 1. 新しいスプレッドシートを生成
  const ss = SpreadsheetApp.create("BRIDGE_OS_CONTROL");
  const ssId = ss.getId();
  
  // 2. 作成したIDをシステム（スクリプトプロパティ）に永久保存
  PropertiesService.getScriptProperties().setProperty('SS_ID', ssId);
  
  // 3. 必要な管理シートを自動作成
  const vault = ss.insertSheet("System_Interaction_Vault");
  vault.appendRow(["Timestamp", "Status", "Content"]);
  vault.setFrozenRows(1);
  
  const queue = ss.insertSheet("System_Fulfillment_Queue");
  
  // 初期シート（シート1）を削除してクリーンアップ
  const defaultSheet = ss.getSheetByName("シート1");
  if (defaultSheet) ss.deleteSheet(defaultSheet);
  
  const url = ss.getUrl();
  console.log("スプレッドシートを生成・紐付け完了: " + url);
  return "成功！以下のURLを開いてください: " + url;
}

// システムが常に正しいスプレッドシートを捕捉するための関数
function getSystemSpreadsheet() {
  const id = PropertiesService.getScriptProperties().getProperty('SS_ID');
  if (id) return SpreadsheetApp.openById(id);
  return SpreadsheetApp.getActiveSpreadsheet();
}

function doPost(e) {
  const ss = getSystemSpreadsheet();
  if (!ss) return ContentService.createTextOutput("ERROR: Spreadsheet not linked.");
  
  const vault = ss.getSheetByName("System_Interaction_Vault");
  
  try {
    const rawData = e.postData.contents;
    
    // 1. Gemini Draft
    const geminiDraft = callGemini(`Squareデータ解析ドラフト: ${rawData}`);
    
    // 2. OpenAI Finalize
    const finalProduct = callOpenAI(`BRIDGE OS基準で最終化せよ: ${geminiDraft}`);
    
    vault.appendRow([new Date(), "SUCCESS", finalProduct]);
    return ContentService.createTextOutput(JSON.stringify({status: "COMPLETED"}));
    
  } catch (err) {
    if (vault) vault.appendRow([new Date(), "ERROR", err.message]);
    return ContentService.createTextOutput("ERROR: " + err.message);
  }
}

// AI連携用関数群
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

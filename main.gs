/**
 * BRIDGE OS: Autonomous Core
 * Gemini (Drafting) -> OpenAI (Optimization)
 */

// 【重要】スプレッドシートがない状態で、まず一度だけこの関数を「実行」してください
function INITIALIZE_BRIDGE_OS() {
  // 1. 新しいスプレッドシートを作成
  const ss = SpreadsheetApp.create("BRIDGE_OS_CONTROL");
  const ssId = ss.getId();
  
  // 2. 作成したIDをスクリプトプロパティに保存（これでシステムが迷子になりません）
  PropertiesService.getScriptProperties().setProperty('SS_ID', ssId);
  
  // 3. 必要な管理シート（Vault）を自動作成
  const vault = ss.insertSheet("System_Interaction_Vault");
  vault.appendRow(["Timestamp", "Status", "Content"]);
  vault.setFrozenRows(1);
  
  // 初期シート（シート1）を削除
  const defaultSheet = ss.getSheetByName("シート1");
  if (defaultSheet) ss.deleteSheet(defaultSheet);
  
  const url = ss.getUrl();
  console.log("BRIDGE OS スプレッドシート生成完了: " + url);
  return "生成成功: " + url;
}

// 常に紐付けられたスプレッドシートを取得する内部関数
function getSystemSpreadsheet() {
  const id = PropertiesService.getScriptProperties().getProperty('SS_ID');
  if (id) {
    try {
      return SpreadsheetApp.openById(id);
    } catch (e) {
      console.error("IDによるシート取得失敗: " + e.message);
    }
  }
  return SpreadsheetApp.getActiveSpreadsheet();
}

function doPost(e) {
  const ss = getSystemSpreadsheet();
  const vault = ss.getSheetByName("System_Interaction_Vault") || ss.insertSheet("System_Interaction_Vault");
  
  try {
    const rawData = e.postData.contents;
    
    // 1. Geminiによる戦略立案（ドラフト）
    const geminiDraft = callGemini(`Squareデータ解析: ${rawData}`);
    
    // 2. OpenAIによる論理検閲と最適化
    const finalProduct = callOpenAI(`BRIDGE OS基準で最適化せよ: ${geminiDraft}`);
    
    // 3. 結果の記録
    vault.appendRow([new Date(), "SUCCESS", finalProduct]);
    
    return ContentService.createTextOutput(JSON.stringify({status: "COMPLETED", data: finalProduct}));
    
  } catch (err) {
    if (vault) vault.appendRow([new Date(), "ERROR", err.message]); //
    return ContentService.createTextOutput("SYSTEM_ERROR: " + err.message);
  }
}

// AI連携用関数（既存のロジックを継承）
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

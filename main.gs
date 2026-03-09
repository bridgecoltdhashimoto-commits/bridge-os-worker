function doPost(e) {
  const ss = getSystemSpreadsheet();
  const vault = ss.getSheetByName("System_Interaction_Vault") || ss.insertSheet("System_Interaction_Vault");
  
  try {
    // ⚠️ 防御策：データが空、または null の場合のチェックを追加
    if (!e || !e.postData || !e.postData.contents) {
      throw new Error("POSTデータが受信できていません。Cloudflare経由の通信を確認してください。");
    }

    const rawData = e.postData.contents;
    
    // 1. Gemini Draft
    const geminiDraft = callGemini(`Squareデータ解析: ${rawData}`);
    // 2. OpenAI Finalize
    const finalProduct = callOpenAI(`BRIDGE OS基準で最適化せよ: ${geminiDraft}`);
    
    vault.appendRow([new Date(), "SUCCESS", finalProduct]);
    return ContentService.createTextOutput(JSON.stringify({status: "COMPLETED"}));
    
  } catch (err) {
    if (vault) vault.appendRow([new Date(), "ERROR", err.message]);
    return ContentService.createTextOutput("SYSTEM_ERROR: " + err.message);
  }
}

function doPost(e) {
  const task = JSON.parse(e.postData.contents);
  return ContentService.createTextOutput(callAICollaboration(task));
}

function callAICollaboration(inputTask) {
  // 1. Gemini Draft
  const draft = callGemini(`Task: ${inputTask}`);
  // 2. OpenAI Optimization (BRIDGE OS Criteria)
  const final = callOpenAI(`Evaluate and optimize this draft for BRIDGE OS: ${draft}`);
  return final;
}

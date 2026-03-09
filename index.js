export default {
  async fetch(request, env) {
    // ⚠️ 修正：変数の定義を追加しました
    const gasUrl = "https://script.google.com/macros/s/AKfycbwiKvhSJ4RhTf6yKA7kiiUVeraEHou0i1Tbt-rcm-EGtLEoahGGGTRnK7Dih4grgWo8Pw/exec";
    
    // データを確実に渡すため、新しい Request オブジェクトを作成して転送
    const newRequest = new Request(gasUrl, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect: "follow"
    });

    return await fetch(newRequest);
  }
};

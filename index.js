export default {
  async fetch(request, env, ctx) {
    // あなたのGASデプロイURL
    const gasUrl = "https://script.google.com/macros/s/AKfycbwYJmTS3nJtAZsTki9_Tu0wzTaQcPNBzlse_PT3uxM_wrXtfUibPeo9EHCaqg_HdVW_/exec";

    // POST通信（SquareからのWebhook）が来た場合の処理
    if (request.method === "POST") {
      const body = await request.text();

      // GASへ転送するリクエストを作成
      // ※Squareのヘッダーをそのまま送るとGoogleのセキュリティに弾かれるため、きれいに整形します
      const gasRequest = fetch(gasUrl, {
        method: "POST",
        body: body,
        headers: {
          "Content-Type": "application/json"
        },
        redirect: "follow" // GAS特有の仕様（リダイレクト必須）に対応
      });

      // 【最重要】GASのAI処理完了を待たずに、裏側で非同期に実行させる
      ctx.waitUntil(gasRequest);

      // Squareには即座に「受け付け完了（200 OK）」を返す
      return new Response("ACCEPTED", { status: 200 });
    }

    // ブラウザ等でアクセスした際の死活監視用
    return new Response("BRIDGE OS ACTIVE", { status: 200 });
  }
};

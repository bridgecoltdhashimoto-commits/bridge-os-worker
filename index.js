export default {
  async fetch(request, env, ctx) {
    const gasUrl = "https://script.google.com/macros/s/AKfycbwYJmTS3nJtAZsTki9_Tu0wzTaQcPNBzlse_PT3uxM_wrXtfUIbPeo9EHCaqg_HdVW_/exec";

    if (request.method === "POST") {
      const body = await request.text();
      
      try {
        // 【調査用】裏側での処理をやめ、GASの返事を直接待ちます
        const gasResponse = await fetch(gasUrl, {
          method: "POST",
          body: body,
          headers: { "Content-Type": "application/json" },
          redirect: "follow"
        });
        
        const gasText = await gasResponse.text();
        
        // GASからの生の返答（またはエラー画面）をSquareにそのまま表示させる
        return new Response("GAS_RESPONSE: " + gasText, { status: 200 });
        
      } catch (e) {
        return new Response("CLOUDFLARE_ERROR: " + e.message, { status: 500 });
      }
    }
    return new Response("BRIDGE OS ACTIVE", { status: 200 });
  }
};

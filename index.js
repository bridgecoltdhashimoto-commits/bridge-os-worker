export default {
  async fetch(request, env, ctx) {
    const gasUrl = "https://script.google.com/macros/s/AKfycbwYJmTS3nJtAZsTki9_Tu0wzTaQcPNBzlse_PT3uxM_wrXtfUIbPeo9EHCaqg_HdVW_/exec"; 
    if (request.method === "POST") {
      const body = await request.text();
      // ctx.waitUntilを使用して、Squareには即座に応答を返しつつ、GASへの転送を裏側で完結させます
      ctx.waitUntil(fetch(gasUrl, { method: "POST", body: body, headers: request.headers }));
      return new Response("ACCEPTED", { status: 200 });
    }
    return new Response("BRIDGE OS ACTIVE");
  }
}

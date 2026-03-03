
export default {
  async fetch(request, env) {
    if (request.method === "GET") return new Response("OK", { status: 200 });
    const rid = crypto.randomUUID();
    const body = await request.text();
    const json = JSON.parse(body);
    
    // 決済データを正確に抽出
    const payload = {
      bridge_token: env.BRIDGEOS_WEBHOOK_TOKEN,
      event_id: json.event_id || json.id,
      payment_id: json.data?.object?.payment?.id || "",
      hint_email: json.data?.object?.payment?.buyer_email_address || "",
      rid: rid
    };

    // SQUARE_QUEUE（画像 image_7ce425.png の設定名）へ確実に転送
    await env.SQUARE_QUEUE.send(payload);
    return new Response("SUCCESS", { status: 200 });
  },

  async queue(batch, env) {
    for (const msg of batch.messages) {
      await fetch(env.GAS_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(msg.body)
      });
      msg.ack();
    }
  }
};
export default {
  async fetch(request, env) {
    if (request.method === "GET") return new Response("ACTIVE", { status: 200 });
    var body = await request.text();
    var json = JSON.parse(body);
    var payload = { status: "ENQUEUED", payment_id: json.data?.object?.payment?.id || "N/A", buyer_email: json.data?.object?.payment?.buyer_email_address || "N/A", amount: json.data?.object?.payment?.amount_money?.amount || 0, raw_json: body };
    await env.SQUARE_QUEUE.send(payload);
    return new Response("SUCCESS", { status: 200 });
  },
  async queue(batch, env) {
    for (var msg of batch.messages) {
      await fetch(env.GAS_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(msg.body) });
      msg.ack();
    }
  }
};
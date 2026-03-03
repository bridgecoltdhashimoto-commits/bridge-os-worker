export class DedupeObject {
  constructor(state) { this.state = state; }
  async fetch(request) {
    var url = new URL(request.url);
    if (url.pathname === "/seen") {
      var seen = await this.state.storage.get("seen");
      return new Response(JSON.stringify({ seen: !!seen }));
    }
    if (url.pathname === "/mark") {
      await this.state.storage.put("seen", true);
      await this.state.storage.setAlarm(Date.now() + 86400000);
      return new Response("OK");
    }
    return new Response("Not Found", { status: 404 });
  }
  async alarm() { await this.state.storage.deleteAll(); }
}

export default {
  async fetch(request, env) {
    if (request.method === "GET") return new Response("BRIDGE OS: ACTIVE", { status: 200 });
    var signature = request.headers.get("x-square-hmacsha256-signature");
    var body = await request.text();
    var isAuthorized = await verifySquareSignature(env.SQUARE_SIGNATURE_KEY, env.WEBHOOK_URL, body, signature);
    if (!isAuthorized) return new Response("UNAUTHORIZED", { status: 401 });

    var json = JSON.parse(body);
    var eventId = json.event_id || json.id;
    var id = env.DEDUPE_OBJ.idFromName(eventId);
    var stub = env.DEDUPE_OBJ.get(id);
    var seenResp = await stub.fetch("http://dedupe/seen");
    var seenData = await seenResp.json();
    if (seenData.seen) return new Response("DUPLICATE", { status: 200 });
    await stub.fetch("http://dedupe/mark", { method: "POST" });

    // 【重要】GASがそのままシートに書けるように、データを1つずつ整理して「パッキング」する
    var payload = {
      received_at: new Date().toISOString(),
      status: "PENDING",
      payment_id: (json.data && json.data.object && json.data.object.payment) ? json.data.object.payment.id : "N/A",
      event_id: eventId,
      buyer_email: (json.data && json.data.object && json.data.object.payment) ? json.data.object.payment.buyer_email_address : "N/A",
      amount: (json.data && json.data.object && json.data.object.payment && json.data.object.payment.amount_money) ? json.data.object.payment.amount_money.amount : 0,
      currency: (json.data && json.data.object && json.data.object.payment && json.data.object.payment.amount_money) ? json.data.object.payment.amount_money.currency : "JPY"
    };

    await env.SQUARE_QUEUE.send(payload);
    return new Response("SUCCESS", { status: 200 });
  },
  async queue(batch, env) {
    for (var msg of batch.messages) {
      await fetch(env.GAS_URL, { 
        method: "POST", 
        headers: { "Content-Type": "application/json" }, 
        body: JSON.stringify(msg.body) 
      });
      msg.ack();
    }
  }
};

async function verifySquareSignature(key, url, body, signature) {
  if (!signature || !key || !url) return false;
  var encoder = new TextEncoder();
  var hmacKey = await crypto.subtle.importKey("raw", encoder.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  var signatureBin = await crypto.subtle.sign("HMAC", hmacKey, encoder.encode(url + body));
  var expected = btoa(String.fromCharCode.apply(null, new Uint8Array(signatureBin)));
  return expected === signature;
}
/**
 * BRIDGE OS: Stable Gateway (v1.1.2)
 * - Square HMAC-SHA256 署名検証の厳格化
 * - 401エラーの解消と詳細ログ
 */

export default {
  async fetch(request, env) {
    if (request.method === "GET") return new Response("OK", { status: 200 });

    const signature = request.headers.get("x-square-hmacsha256-signature");
    const body = await request.text();
    const rid = crypto.randomUUID();

    // 署名検証ロジック
    const isAuthorized = await verifySquareSignature(
      env.SQUARE_WEBHOOK_SIGNATURE_KEY,
      env.SQUARE_WEBHOOK_URL,
      body,
      signature
    );

    if (!isAuthorized) {
      console.error(`[${rid}] AUTH_FAIL: Signature mismatch`);
      return new Response("UNAUTHORIZED", { status: 401 });
    }

    const json = JSON.parse(body);
    const payload = {
      bridge_token: env.BRIDGEOS_WEBHOOK_TOKEN,
      event_id: json.event_id || json.id,
      payment_id: json.data?.object?.payment?.id || "",
      hint_email: json.data?.object?.payment?.buyer_email_address || "",
      rid: rid
    };

    // Queueへ送信
    await env.BRIDGE_QUEUE.send(payload);
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

async function verifySquareSignature(key, url, body, signature) {
  if (!signature) return false;
  const encoder = new TextEncoder();
  const hmacKey = await crypto.subtle.importKey(
    "raw", encoder.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false, ["sign"]
  );
  const signatureBin = await crypto.subtle.sign("HMAC", hmacKey, encoder.encode(url + body));
  const expected = btoa(String.fromCharCode(...new Uint8Array(signatureBin)));
  return expected === signature;
}

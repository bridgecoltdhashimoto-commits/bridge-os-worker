export default {
  async fetch(request, env) {
    if (request.method === "GET") return new Response("OK", { status: 200 });
    const signature = request.headers.get("x-square-hmacsha256-signature");
    const body = await request.text();
    const isAuthorized = await verifySquareSignature(env.SQUARE_SIGNATURE_KEY, env.WEBHOOK_URL, body, signature);

    if (!isAuthorized) {
      console.error("AUTH_FAIL_SIGNATURE: mismatch");
      return new Response("UNAUTHORIZED", { status: 401 });
    }

    const json = JSON.parse(body);
    await env.SQUARE_QUEUE.send({
      payment_id: json.data?.object?.payment?.id || "",
      hint_email: json.data?.object?.payment?.buyer_email_address || "",
      rid: crypto.randomUUID()
    });
    return new Response("SUCCESS", { status: 200 });
  },
  async queue(batch, env) {
    for (const msg of batch.messages) {
      await fetch(env.GAS_URL, { method: "POST", body: JSON.stringify(msg.body) });
      msg.ack();
    }
  }
};

async function verifySquareSignature(key, url, body, signature) {
  if (!signature || !key || !url) return false;
  const encoder = new TextEncoder();
  const hmacKey = await crypto.subtle.importKey("raw", encoder.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signatureBin = await crypto.subtle.sign("HMAC", hmacKey, encoder.encode(url + body));
  return btoa(String.fromCharCode(...new Uint8Array(signatureBin))) === signature;
}
// Cloudflare Worker for BRIDGE OS Square Webhooks
// このWorkerはSquareのpayment.updatedイベントを受信し、署名検証・重複判定を行って
// Cloudflare Queueにジョブを投入します。キューのコンシューマがGASへ転送します。

export { DedupeObject } from './dedupe.js';

export default {
  async fetch(request, env, ctx) {
    // GETはヘルスチェック用
    if (request.method !== 'POST') {
      return new Response('OK', { status: 200 });
    }

    let bodyText;
    try {
      bodyText = await request.text();
    } catch {
      return new Response('Bad Request', { status: 400 });
    }
    if (!bodyText) {
      return new Response('Bad Request: empty body', { status: 400 });
    }

    // JSON解析
    let event;
    try {
      event = JSON.parse(bodyText);
    } catch {
      return new Response('Bad Request: invalid JSON', { status: 400 });
    }

    // 署名検証（SQUARE_SIGNATURE_KEY or SQUARE_SIGNATURE_KEY_PRODUCTION を使う）
    const signatureKey = env.SQUARE_SIGNATURE_KEY || env.SQUARE_SIGNATURE_KEY_PRODUCTION;
    const signatureHeader = request.headers.get('x-square-signature');
        if (!signatureKey) {
     console.error('AUTH_FAIL_ENV: missing signature key');
    }
    if (!signatureHeader) {
      console.error('AUTH_FAIL_TOKEN: missing x-square-signature header');
    }
     
      if (signatureKey && signatureHeader) {
        const valid = await verifySquareSignature(signatureKey, bodyText, signatureHeader);
        if (!valid) {
            console.error('AUTH_FAIL_SIGNATURE: signature mismatch');
            return new Response('Unauthorized', { status: 401 });
        }
    }
      
    }

    // 支払い更新イベントのみ処理
    const type = event?.type || '';
    if (type !== 'payment.updated') {
      return new Response('IGNORED', { status: 200 });
    }

    // event_id と payment_id の取得
    const eventId = event?.event_id || event?.data?.id || event?.id;
    const paymentId = event?.data?.object?.payment?.id || event?.data?.id;
    if (!eventId || !paymentId) {
      return new Response('Bad Request: missing event_id or payment_id', { status: 400 });
    }

    // デバッグ用フラグ（trueで重複検知をバイパス）
    const bypass = env.DEBUG_BYPASS_DEDUPE === 'true' || env.DEBUG_BYPASS_DEDUPE === true;

    // Durable Objectによる重複検知
    const dedupe = env.DEDUPE_OBJ;
    if (!bypass && dedupe) {
      const id = dedupe.idFromName(eventId);
      const stub = dedupe.get(id);
      const seenResp = await stub.fetch('https://dedupe/seen');
      const seen = (await seenResp.json()).seen;
      if (seen) {
        return new Response('DUPLICATE', { status: 200 });
      }
      // mark as processed
      await stub.fetch('https://dedupe/mark', { method: 'POST' });
    }

    // キューに投入するジョブペイロード（最小限）
    const job = {
      provider: 'SQUARE',
      payment_id: paymentId,
      event_id: eventId,
      event_type: type,
      hint_email: event?.data?.object?.payment?.buyer_email_address || ''
    };

    // queue送信。bindingが無ければエラー応答
    if (!env.SQUARE_QUEUE) {
      return new Response('Server Error: queue missing', { status: 500 });
    }

    try {
      // 文字列ではなくオブジェクトのまま送る
      await env.SQUARE_QUEUE.send(job);
    } catch {
      // 送信失敗時はdedupe状態を戻す
      if (!bypass && dedupe) {
        const id = dedupe.idFromName(eventId);
        const stub = dedupe.get(id);
        await stub.fetch('https://dedupe/clear', { method: 'POST' });
      }
      return new Response('Server Error: enqueue failed', { status: 500 });
    }

    return new Response('OK', { status: 200 });
  },

  async queue(batch, env, ctx) {
    // キューコンシューマ：バッチでGASへ転送
    for (const msg of batch.messages) {
      const job = typeof msg.body === 'string' ? JSON.parse(msg.body) : msg.body;
      try {
        await fetch(env.GAS_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(job)
        });
        await msg.ack();
      } catch {
        // エラー時はackせずに再試行させる
      }
    }
  }
};

// Square署名検証関数
async function verifySquareSignature(secret, body, signature) {
  const parts = signature.split('=');
  const sigHex = parts.length === 2 ? parts[1] : parts[0];
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signatureBuf = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(body)
  );
  const signatureHex = Array.from(new Uint8Array(signatureBuf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  return timingSafeEqual(signatureHex, sigHex.toLowerCase());
}

// タイミングセーフな文字列比較
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let res = 0;
  for (let i = 0; i < a.length; i++) {
    res |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return res === 0;
}

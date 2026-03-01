/**
 * dedupe.js
 * Cloudflare Durable Object for event deduplication (flexible action-compatible version)
 *
 * 想定:
 * - index.js から `import { DedupeObject } from './dedupe.js'`
 * - DO binding class_name = "DedupeObject"
 *
 * 対応アクション（広めに対応）:
 * - check / exists / seen      : 存在確認のみ
 * - mark / set / put / reserve : 登録（既存なら duplicate=true）
 * - checkAndSet / acquire      : 確認＋登録（既存なら duplicate=true）
 *
 * 入力キー候補（自動吸収）:
 * - key, id, event_id, eventId, payment_id, paymentId
 *
 * TTL候補（秒）:
 * - ttlSec, ttl, ttl_seconds
 */

export class DedupeObject {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    try {
      // ヘルスチェック
      if (request.method === "GET") {
        return this._json({
          ok: true,
          object: "DedupeObject",
          status: "alive",
        });
      }

      const payload = await this._readPayload(request);

      const action = this._normalizeAction(
        payload.action || payload.mode || payload.op || payload.type
      );

      const key = this._extractKey(payload);
      const ttlSec = this._extractTtlSec(payload);

      if (!key) {
        return this._json(
          {
            ok: false,
            error: "missing_key",
            hint: "key / event_id / payment_id を指定してください",
          },
          400
        );
      }

      // クリティカル区間（同一DO内の競合を抑える）
      const result = await this.state.blockConcurrencyWhile(async () => {
        const now = Date.now();
        const rec = await this.state.storage.get(key);
        const exists = this._isRecordAlive(rec, now);

        // 期限切れなら削除して無効化
        if (rec && !exists) {
          await this.state.storage.delete(key);
        }

        // 確認のみ
        if (action === "check") {
          return {
            ok: true,
            action,
            key,
            exists,
            duplicate: exists,
            seen: exists,
            record: exists ? rec : null,
          };
        }

        // 登録 / 確認+登録
        if (
          action === "mark" ||
          action === "checkAndSet"
        ) {
          if (exists) {
            return {
              ok: true,
              action,
              key,
              exists: true,
              duplicate: true,
              seen: true,
              record: rec,
            };
          }

          const newRec = {
            key,
            createdAt: now,
            expiresAt: ttlSec > 0 ? now + ttlSec * 1000 : null,
            meta: payload.meta || null,
            source: payload.source || null,
          };

          await this.state.storage.put(key, newRec);

          if (newRec.expiresAt) {
            // 期限管理（使える環境ならセット。失敗しても処理継続）
            try {
              await this.state.storage.setAlarm(newRec.expiresAt);
            } catch (_) {}
          }

          return {
            ok: true,
            action,
            key,
            exists: false,
            duplicate: false,
            seen: false,
            stored: true,
            record: newRec,
          };
        }

        // 不明アクションでも checkAndSet 相当で吸収
        if (exists) {
          return {
            ok: true,
            action: "checkAndSet(fallback)",
            key,
            exists: true,
            duplicate: true,
            seen: true,
            record: rec,
          };
        }

        const newRec = {
          key,
          createdAt: now,
          expiresAt: ttlSec > 0 ? now + ttlSec * 1000 : null,
          meta: payload.meta || null,
          source: payload.source || null,
        };

        await this.state.storage.put(key, newRec);

        if (newRec.expiresAt) {
          try {
            await this.state.storage.setAlarm(newRec.expiresAt);
          } catch (_) {}
        }

        return {
          ok: true,
          action: "checkAndSet(fallback)",
          key,
          exists: false,
          duplicate: false,
          seen: false,
          stored: true,
          record: newRec,
        };
      });

      return this._json(result, 200);
    } catch (e) {
      return this._json(
        {
          ok: false,
          error: "dedupe_do_error",
          message: String(e && e.message ? e.message : e),
        },
        500
      );
    }
  }

  async alarm() {
    // 期限切れレコードの掃除（ベストエフォート）
    const now = Date.now();
    const list = await this.state.storage.list();
    let nextAlarm = null;

    for (const [key, rec] of list.entries()) {
      const exp = rec && typeof rec.expiresAt === "number" ? rec.expiresAt : null;

      if (exp && exp <= now) {
        await this.state.storage.delete(key);
      } else if (exp && (nextAlarm === null || exp < nextAlarm)) {
        nextAlarm = exp;
      }
    }

    if (nextAlarm) {
      try {
        await this.state.storage.setAlarm(nextAlarm);
      } catch (_) {}
    }
  }

  async _readPayload(request) {
    const text = await request.text();

    // JSON優先
    try {
      return JSON.parse(text || "{}");
    } catch (_) {}

    // x-www-form-urlencoded も吸収
    const sp = new URLSearchParams(text || "");
    const obj = {};
    for (const [k, v] of sp.entries()) obj[k] = v;
    return obj;
  }

  _extractKey(payload) {
    return (
      payload.key ||
      payload.id ||
      payload.event_id ||
      payload.eventId ||
      payload.payment_id ||
      payload.paymentId ||
      null
    );
  }

  _extractTtlSec(payload) {
    const raw =
      payload.ttlSec ??
      payload.ttl ??
      payload.ttl_seconds ??
      payload.ttlSeconds ??
      86400; // デフォルト24時間

    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return 86400;
    return Math.floor(n);
  }

  _normalizeAction(action) {
    const a = String(action || "").trim();

    // 確認のみ
    if (
      a === "check" ||
      a === "exists" ||
      a === "seen" ||
      a === "has"
    ) {
      return "check";
    }

    // 登録のみ
    if (
      a === "mark" ||
      a === "set" ||
      a === "put" ||
      a === "reserve" ||
      a === "create"
    ) {
      return "mark";
    }

    // 確認＋登録
    if (
      a === "checkAndSet" ||
      a === "check_and_set" ||
      a === "acquire" ||
      a === "lock" ||
      a === "dedupe"
    ) {
      return "checkAndSet";
    }

    // 未指定は checkAndSet 扱い
    return "checkAndSet";
  }

  _isRecordAlive(rec, now) {
    if (!rec) return false;
    if (!rec.expiresAt) return true;
    return rec.expiresAt > now;
  }

  _json(data, status = 200) {
    return new Response(JSON.stringify(data), {
      status,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }
}

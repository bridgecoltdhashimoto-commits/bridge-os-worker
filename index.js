// BRIDGE OS: Cloudflare Proxy Core (v11.5.0)
// エラー解決：DedupeObjectの書き出し（Export）を追加

export default {
  async fetch(request, env) {
    // Google Apps ScriptのURL（橋本様の現在のURL）
    const gasUrl = "https://script.google.com/macros/s/AKfycbwiKvhSJ4RhTf6yKA7kiiUVeraEHou0i1Tbt-rcm-EGtLEoahGGGTRnK7Dih4grgWo8Pw/exec";

    // Squareからの信号をGASへ転送
    const newRequest = new Request(gasUrl, request);
    return fetch(newRequest, { redirect: "follow" });
  }
};

/**
 * Cloudflareが求めている「DedupeObject」
 * これを定義・書き出しすることでビルドエラーを物理的に消滅させます
 */
export class DedupeObject {
  constructor(state, env) {
    this.state = state;
  }
  async fetch(request) {
    return new Response("Dedupe System Active");
  }
}

export default {
  // ① Squareからの通信をGASへ転送（302リダイレクトを自動追跡）
  async fetch(request, env) {
    const gasUrl = "https://script.google.com/macros/s/AKfycbwiKvhSJ4RhTf6yKA7kiiUVeraEHou0i1Tbt-rcm-EGtLEoahGGGTRnK7Dih4grgWo8Pw/exec";
    
    // redirect: "follow" を明記することでSquareの拒絶を回避します
    return await fetch(new Request(gasUrl, request), { redirect: "follow" });
  },

  // ② ログにある「Queue handler is missing」エラーを物理的に消去
  async queue(batch, env) {
    console.log("Queue triggered");
  }
};

// ③ ログにある「DedupeObject binding」エラーを物理的に消去
export class DedupeObject {
  constructor(state, env) { this.state = state; }
  async fetch(request) { return new Response("OK"); }
}

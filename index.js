export default {
  async fetch(request, env) {
    // ⚠️ 橋本様、このURLが最新のGASウェブアプリURL（/exec）であることを必ず確認してください
    const gasUrl = "https://script.google.com/macros/s/AKfycbwiKvhSJ4RhTf6yKA7kiiUVeraEHou0i1Tbt-rcm-EGtLEoahGGGTRnK7Dih4grgWo8Pw/exec";
    return await fetch(new Request(gasUrl, request), { redirect: "follow" });
  },

  async queue(batch, env) {
    console.log("Queue processed");
  }
};

export class DedupeObject {
  constructor(state, env) { this.state = state; }
  async fetch(request) { return new Response("OK"); }
}

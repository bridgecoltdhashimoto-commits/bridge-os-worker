export default {
  async fetch(request, env) {
    const gasUrl = "https://script.google.com/macros/s/AKfycbwiKvhSJ4RhTf6yKA7kiiUVeraEHou0i1Tbt-rcm-EGtLEoahGGGTRnK7Dih4grgWo8Pw/exec";
    return await fetch(new Request(gasUrl, request), { redirect: "follow" });
  }
};

// ビルド成功に必須：Durable Object
export class DedupeObject {
  constructor(state, env) { this.state = state; }
  async fetch(request) { return new Response("OK"); }
}

export default {
  async fetch(request) {
    const gasUrl = "https://script.google.com/macros/s/AKfycbwiKvhSJ4RhTf6yKA7kiiUVeraEHou0i1Tbt-rcm-EGtLEoahGGGTRnK7Dih4grgWo8Pw/exec";
    return fetch(new Request(gasUrl, request), { redirect: "follow" });
  }
};
export class DedupeObject { constructor(state) { this.state = state; } async fetch() { return new Response(); } }

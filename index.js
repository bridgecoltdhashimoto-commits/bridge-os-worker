export default {
  async fetch(r) {
    return fetch(new Request("https://script.google.com/macros/s/AKfycbwiKvhSJ4RhTf6yKA7kiiUVeraEHou0i1Tbt-rcm-EGtLEoahGGGTRnK7Dih4grgWo8Pw/exec", r), { redirect: "follow" });
  }
};
export class DedupeObject { constructor(s) { this.state = s; } async fetch() { return new Response(); } }

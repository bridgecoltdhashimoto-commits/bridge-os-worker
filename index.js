export default {
  async fetch(request, env) {
    const gasUrl = "https://script.google.com/macros/s/AKfycbwiKvhSJ4RhTf6yKA7kiiUVeraEHou0i1Tbt-rcm-EGtLEoahGGGTRnK7Dih4grgWo8Pw/exec";
    // OpenAI Optimization: Ensure complete header/method passthrough with redirect following
    return await fetch(new Request(gasUrl, request), { redirect: "follow" });
  }
};

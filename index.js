export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("BRIDGE OS ACTIVE", { status: 200 });
    }

    if (!env.GAS_WEBHOOK_URL) {
      return new Response("CONFIG_ERROR: GAS_WEBHOOK_URL is not set", { status: 500 });
    }

    const body = await request.text();

    try {
      const forwardUrl = new URL(env.GAS_WEBHOOK_URL);
      if (env.GAS_WEBHOOK_TOKEN) {
        forwardUrl.searchParams.set("token", env.GAS_WEBHOOK_TOKEN);
      }

      const gasResponse = await fetch(forwardUrl.toString(), {
        method: "POST",
        body,
        headers: { "Content-Type": "application/json" },
        redirect: "follow",
      });

      const gasText = await gasResponse.text();
      return new Response(gasText, {
        status: gasResponse.ok ? 200 : 502,
        headers: { "Content-Type": "application/json" },
      });
    } catch (e) {
      return new Response(`CLOUDFLARE_ERROR: ${e.message}`, { status: 500 });
    }
  },
};

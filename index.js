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

      const intakeSource = extractProofPackIntakeSource(request.url);
      const forwardBody = intakeSource
        ? buildProofPackIntakeForwardBody(body, intakeSource)
        : body;

      const gasResponse = await fetch(forwardUrl.toString(), {
        method: "POST",
        body: forwardBody,
        headers: { "Content-Type": "application/json" },
        redirect: "follow",
      });

      const gasText = await gasResponse.text();
      const responseHeaders = {};
      const gasContentType = gasResponse.headers.get("content-type");
      if (gasContentType) {
        responseHeaders["Content-Type"] = gasContentType;
      }

      return new Response(gasText, {
        status: gasResponse.ok ? 200 : 502,
        headers: responseHeaders,
      });
    } catch (e) {
      return new Response(`CLOUDFLARE_ERROR: ${e.message}`, { status: 500 });
    }
  },
};

function extractProofPackIntakeSource(urlText) {
  const url = new URL(urlText);
  const fromQuery = url.searchParams.get("source") || url.searchParams.get("intake_source");
  const querySource = normalizeProofPackIntakeSource(fromQuery);
  if (querySource) {
    return querySource;
  }

  const pathParts = url.pathname.split("/").filter(Boolean);
  const lastPart = pathParts[pathParts.length - 1] || "";
  return normalizeProofPackIntakeSource(lastPart);
}

function normalizeProofPackIntakeSource(source) {
  const normalized = String(source || "").toLowerCase();
  return ["line", "gmail", "lp"].includes(normalized) ? normalized : "";
}

function buildProofPackIntakeForwardBody(body, source) {
  let payload;
  try {
    payload = JSON.parse(body || "{}");
  } catch (_) {
    payload = { message: body || "" };
  }

  if (!payload || Array.isArray(payload) || typeof payload !== "object") {
    payload = { message: String(body || "") };
  }

  return JSON.stringify({
    ...payload,
    type: payload.type || "proofpack.ai_intake",
    source,
  });
}

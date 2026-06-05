import estimateFrontHtml from "./products/estimate-front/index.html";
import estimateFrontCss from "./products/estimate-front/style.css";
import bridgeLogoJpg from "./products/estimate-front/assets/bridge-logo.jpg";

const ESTIMATE_FRONT_BASE_PATH = "/products/estimate-front";
const estimateFrontCssWithLogoImageFit = `${estimateFrontCss}

.ef-brand__mark,
.ef-footer__mark {
  overflow: hidden;
  border-radius: 999px;
}

.ef-brand__mark img,
.ef-footer__mark img {
  border-radius: inherit;
  object-fit: cover;
  object-position: center;
  filter: contrast(1.12) saturate(1.08) drop-shadow(0 8px 18px rgba(218, 187, 119, 0.24));
}
`;

export default {
  async fetch(request, env) {
    const estimateFrontResponse = handleEstimateFrontRequest(request);
    if (estimateFrontResponse) {
      return estimateFrontResponse;
    }

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

function handleEstimateFrontRequest(request) {
  if (!["GET", "HEAD"].includes(request.method)) {
    return null;
  }

  const url = new URL(request.url);
  const pathname = url.pathname;

  if (pathname === ESTIMATE_FRONT_BASE_PATH) {
    url.pathname = `${ESTIMATE_FRONT_BASE_PATH}/`;
    return Response.redirect(url.toString(), 308);
  }

  if (pathname === `${ESTIMATE_FRONT_BASE_PATH}/` || pathname === `${ESTIMATE_FRONT_BASE_PATH}/index.html`) {
    return buildStaticResponse(request, estimateFrontHtml, "text/html; charset=utf-8");
  }

  if (pathname === `${ESTIMATE_FRONT_BASE_PATH}/style.css`) {
    return buildStaticResponse(request, estimateFrontCssWithLogoImageFit, "text/css; charset=utf-8");
  }

  if (
    pathname === `${ESTIMATE_FRONT_BASE_PATH}/assets/bridge-logo.jpg` ||
    pathname === `${ESTIMATE_FRONT_BASE_PATH}/assets/bridge-logo.png`
  ) {
    return buildStaticResponse(request, bridgeLogoJpg, "image/jpeg");
  }

  return null;
}

function buildStaticResponse(request, body, contentType) {
  return new Response(request.method === "HEAD" ? null : body, {
    status: 200,
    headers: {
      "Cache-Control": "public, max-age=300",
      "Content-Type": contentType,
    },
  });
}

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

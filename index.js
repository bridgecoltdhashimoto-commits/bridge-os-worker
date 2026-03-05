
    export default {
      async fetch(request, env) {
        const body = await request.text();
        const payload = { ...JSON.parse(body), status: "ENQUEUED" };
        // GAS??????????????????????????
        await fetch("https://script.google.com/macros/s/AKfycbyvrvT1wHGYi7E7snBNsxEcSX5MHmQO31ZYugKDNe4TSo2M178m1zIztkbvMOL8NO48/exec", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        return new Response("OK", { status: 200 });
      }
    };
  
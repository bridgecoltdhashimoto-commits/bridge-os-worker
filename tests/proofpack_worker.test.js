const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

function loadWorker() {
  const script = fs.readFileSync('index.js', 'utf8').replace('export default {', 'var worker = {');
  const context = { URL, Request, Response, JSON, String, console };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(`${script}\nworker;`, context, { filename: 'index.js' });
  return context;
}

(async () => {
  const context = loadWorker();
  const calls = [];
  context.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  {
    calls.length = 0;
    const response = await context.worker.fetch(
      new Request('https://worker.example.com/webhook', {
        method: 'POST',
        body: JSON.stringify({ type: 'payment.updated', data: { object: { payment: { id: 'p1' } } } }),
      }),
      { GAS_WEBHOOK_URL: 'https://script.google.com/macros/s/abc/exec', GAS_WEBHOOK_TOKEN: 'secret' },
    );
    assert.strictEqual(response.status, 200);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].url, 'https://script.google.com/macros/s/abc/exec?token=secret');
    assert.deepStrictEqual(JSON.parse(calls[0].init.body), { type: 'payment.updated', data: { object: { payment: { id: 'p1' } } } });
  }

  {
    calls.length = 0;
    const response = await context.worker.fetch(
      new Request('https://worker.example.com/intake?source=line', {
        method: 'POST',
        body: JSON.stringify({ message: '納品URLを確認したいです', event_id: 'line-1' }),
      }),
      { GAS_WEBHOOK_URL: 'https://script.google.com/macros/s/abc/exec', GAS_WEBHOOK_TOKEN: 'secret' },
    );
    assert.strictEqual(response.status, 200);
    const forwarded = JSON.parse(calls[0].init.body);
    assert.strictEqual(forwarded.type, 'proofpack.ai_intake');
    assert.strictEqual(forwarded.source, 'line');
    assert.strictEqual(forwarded.message, '納品URLを確認したいです');
    assert.strictEqual(forwarded.event_id, 'line-1');
  }

  {
    calls.length = 0;
    const response = await context.worker.fetch(
      new Request('https://worker.example.com/lp', {
        method: 'POST',
        body: 'LPからの問い合わせです',
      }),
      { GAS_WEBHOOK_URL: 'https://script.google.com/macros/s/abc/exec' },
    );
    assert.strictEqual(response.status, 200);
    const forwarded = JSON.parse(calls[0].init.body);
    assert.strictEqual(forwarded.type, 'proofpack.ai_intake');
    assert.strictEqual(forwarded.source, 'lp');
    assert.strictEqual(forwarded.message, 'LPからの問い合わせです');
  }

  console.log('proofpack_worker tests passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

// 真实 WebSocket 测试: /azure-api.codex/responses WS upgrade + response.create 流式
const fs = require('fs');
const KEY = fs.readFileSync('/tmp/codex_key.txt', 'utf8').trim();
const URL = 'wss://copilot-staging.oc-pegasus.workers.dev/azure-api.codex/responses';

const ws = new WebSocket(URL, {
  headers: { Authorization: `Bearer ${KEY}` },
});

const events = [];
let gotDelta = false, gotCompleted = false, gotDone = false, gotError = null;
const t0 = Date.now();

const timer = setTimeout(() => {
  console.log('TIMEOUT after 60s');
  finish(1);
}, 60000);

function finish(code) {
  clearTimeout(timer);
  console.log('\n=== SUMMARY ===');
  console.log('total events:', events.length);
  console.log('event types:', JSON.stringify([...new Set(events.map(e => e.type))]));
  console.log('gotDelta:', gotDelta, '| gotCompleted:', gotCompleted, '| gotDone:', gotDone);
  if (gotError) console.log('ERROR EVENT:', JSON.stringify(gotError).slice(0, 500));
  const verdict = gotCompleted && gotDone && !gotError;
  console.log('VERDICT:', verdict ? 'WS WORKS ✅' : 'WS FAILED ❌');
  try { ws.close(); } catch {}
  process.exit(code ?? (verdict ? 0 : 2));
}

ws.addEventListener('open', () => {
  console.log(`[${Date.now()-t0}ms] WS OPEN (101 handshake ok)`);
  const msg = {
    type: 'response.create',
    event_id: 'test-1',
    response: {
      model: 'gpt-4o-mini',
      input: 'Reply with exactly: hello',
      max_output_tokens: 20,
    },
  };
  ws.send(JSON.stringify(msg));
  console.log(`[${Date.now()-t0}ms] sent response.create`);
});

ws.addEventListener('message', (ev) => {
  let data;
  try { data = JSON.parse(ev.data.toString()); } catch { console.log('non-json frame:', ev.data.toString().slice(0,200)); return; }
  events.push(data);
  const t = data.type;
  if (t && t.includes('delta')) { if (!gotDelta) console.log(`[${Date.now()-t0}ms] first delta`); gotDelta = true; }
  else console.log(`[${Date.now()-t0}ms] event: ${t}`);
  if (t === 'response.completed') gotCompleted = true;
  if (t === 'response.done') { gotDone = true; finish(); }
  if (t === 'error') { gotError = data.error || data; }
});

ws.addEventListener('error', (e) => {
  console.log(`[${Date.now()-t0}ms] WS ERROR:`, e.message || e.error?.message || JSON.stringify(e).slice(0,300));
  finish(3);
});

ws.addEventListener('close', (e) => {
  console.log(`[${Date.now()-t0}ms] WS CLOSE code=${e.code} reason=${e.reason}`);
  if (!gotDone) finish(4);
});

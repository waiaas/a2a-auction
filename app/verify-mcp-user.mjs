/**
 * MCP 사용자 경로 검증.
 *
 * MCP 클라이언트 없이 서버를 stdio로 직접 띄우고 JSON-RPC를 주고받아, **토큰을 준 도구가
 * 그 사용자의 에이전트 지갑으로 도는지**를 확인한다. 콘티 컷 2(작업 의뢰)의 무대가 MCP라
 * 이 경로가 실제로 서는지는 화면과 별개로 검증돼야 한다.
 *
 * 실행: node verify-mcp-user.mjs   (verify-user-flow.mjs로 만든 테스트 오너를 재사용)
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Keypair, signEd25519 } from './lib/solana.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.A2A_BASE || 'http://127.0.0.1:4000';
const KEY_FILE = path.join(DIR, '.verify-owner.json');

let failures = 0;
const log = (...a) => console.log(...a);
function expect(label, ok, detail = '') {
  if (!ok) failures++;
  log(`${ok ? '  ✓' : '  ✗'} ${label}${detail ? ` — ${detail}` : ''}`);
}

// ---- 1. 웹이 하는 일(연결)을 그대로 해서 토큰을 얻는다 ----
if (!fs.existsSync(KEY_FILE)) {
  console.error('테스트 오너 키가 없다. 먼저 node verify-user-flow.mjs 를 실행하라.');
  process.exit(1);
}
const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(KEY_FILE, 'utf8'))));
const OWNER = kp.publicKey.toBase58();

async function api(method, p, body, token) {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await res.text();
  const j = t ? JSON.parse(t) : {};
  if (res.status >= 300) throw new Error(`${p} ${res.status}: ${JSON.stringify(j).slice(0, 200)}`);
  return j;
}

log(`owner = ${OWNER}\n[1] 토큰 발급`);
const { message } = await api('POST', '/api/u/nonce', { ownerAddress: OWNER });
const { authToken, agentAddress } = await api('POST', '/api/u/connect', {
  ownerAddress: OWNER,
  message,
  signature: signEd25519(kp.secretKey, message).toString('base64'),
});
expect('연결 + 토큰 발급', Boolean(authToken), `agent=${agentAddress}`);

// ---- 2. MCP 서버를 stdio로 띄우고 도구를 호출한다 ----
log('[2] MCP 서버 기동 (A2A_TOKEN 주입)');
const child = spawn('node', [path.join(DIR, 'mcp-server.js')], {
  env: { ...process.env, A2A_TOKEN: authToken, ORCHESTRATOR_URL: BASE },
  stdio: ['pipe', 'pipe', 'pipe'],
});
child.stderr.on('data', (d) => process.stderr.write(`  [mcp] ${d}`));

let buffer = '';
const pending = new Map();
child.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    } catch { /* 프로토콜 외 출력 무시 */ }
  }
});

let nextId = 1;
function rpc(method, params, timeoutMs = 180000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} 응답 없음`)), timeoutMs);
    pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}
function notify(method, params) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
}

const init = await rpc('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'verify-mcp-user', version: '0.1.0' },
});
expect('initialize', Boolean(init.result), init.result?.serverInfo?.name);
notify('notifications/initialized', {});

const tools = await rpc('tools/list', {});
const names = (tools.result?.tools ?? []).map((t) => t.name);
expect('도구 목록', names.includes('request_work') && names.includes('purchase_skill'), names.join(', '));

// ---- 3. 자연어 작업 의뢰 (컷 2) ----
log('[3] request_work — 자연어로 일 맡기기');
const work = await rpc('tools/call', {
  name: 'request_work',
  arguments: { prompt: '경쟁사 동향을 짧게 정리한 자료가 필요하다' },
});
const text = work.result?.content?.[0]?.text ?? '';
let payload = null;
try { payload = JSON.parse(text); } catch { /* 오류 문자열 */ }
if (!payload) {
  expect('작업 의뢰', false, text.slice(0, 200));
} else {
  expect('정책 판정이 도구 응답으로 반환', Boolean(payload.verdict), `${payload.amountUsdc} USDC → ${payload.verdict}`);
  expect('무엇을 왜 골랐는지 포함', Boolean(payload.reason), `${payload.listingId} (${payload.chosenBy})`);
  log(`  판정 설명: ${payload.meaning}`);
  log(`  다음 단계: ${payload.nextStep}`);
}

// ---- 4. 상태 조회가 내 지갑을 본다 ----
log('[4] get_status — 내 지갑인지 확인');
const status = await rpc('tools/call', { name: 'get_status', arguments: {} });
const st = JSON.parse(status.result?.content?.[0]?.text ?? '{}');
expect('내 에이전트 지갑 경로', st.wallet === 'mine', `wallet=${st.wallet}, 건수=${st.count}`);
if (st.actionRequired) log(`  사람이 할 일: ${st.actionRequired}`);

// ---- 5. 토큰 없이 띄우면 자연어 의뢰가 막히는지 ----
log('[5] 토큰 없는 서버는 내 지갑 경로를 열지 않는다');
child.kill();
const bare = spawn('node', [path.join(DIR, 'mcp-server.js')], {
  env: { ...process.env, A2A_TOKEN: '', ORCHESTRATOR_URL: BASE },
  stdio: ['pipe', 'pipe', 'ignore'],
});
let bareBuf = '';
const bareWait = new Promise((resolve) => {
  bare.stdout.on('data', (c) => {
    bareBuf += c.toString();
    for (const line of bareBuf.split('\n')) {
      if (!line.trim()) continue;
      try {
        const m = JSON.parse(line);
        if (m.id === 2) resolve(m);
      } catch { /* skip */ }
    }
  });
});
bare.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'x', version: '1' } } })}\n`);
bare.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
bare.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'request_work', arguments: { prompt: 'x' } } })}\n`);
const bareRes = await bareWait;
bare.kill();
expect(
  '토큰 없으면 안내와 함께 거절',
  bareRes.result?.isError === true && /A2A_TOKEN/.test(bareRes.result?.content?.[0]?.text ?? ''),
  (bareRes.result?.content?.[0]?.text ?? '').slice(0, 80),
);

log(`\n=== 결과: 실패 ${failures}건 ===`);
process.exit(failures ? 1 : 0);

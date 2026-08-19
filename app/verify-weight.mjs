/**
 * 가중치 선택 경로 회귀 검증 (8/19 퀵싱크 신설분).
 *
 * **화면이 보여준 1위와 실제로 산 것이 같아야 한다.** 이 데모에서 슬라이더를 움직여 순위가
 * 바뀌는 장면이 핵심인데, 서버가 다른 것을 사면 그 장면이 통째로 거짓이 된다. 그래서 브라우저가
 * 하는 계산(`lib/ranking.js`)과 서버의 구매 결과를 같은 스크립트에서 대조한다.
 *
 * 실행: node verify-weight.mjs
 * `.verify-owner.json`의 키를 재사용한다(verify-user-flow.mjs와 같은 사용자).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Transaction } from '@solana/web3.js';
import { Keypair, signEd25519 } from './lib/solana.js';
import { rankCandidates } from './lib/ranking.js';

const BASE = process.env.A2A_BASE || 'http://127.0.0.1:4000/api/u';
const KEY_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '.verify-owner.json');

let TOKEN = '';
let failures = 0;

function ok(msg) { console.log(`  ✓ ${msg}`); }
function bad(msg) { console.log(`  ✗ ${msg}`); failures += 1; }

async function call(method, apiPath, body) {
  const res = await fetch(`${BASE}${apiPath}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (res.status >= 300) throw new Error(`${method} ${apiPath} → ${res.status} ${json.message || text.slice(0, 120)}`);
  return json;
}

function loadOwner() {
  const raw = JSON.parse(fs.readFileSync(KEY_FILE, 'utf8'));
  return Keypair.fromSecretKey(Uint8Array.from(raw.secretKey ?? raw));
}

/** 라운드가 멈출 때까지 기다린다. 온체인 단계가 끝나야 판정을 읽을 수 있다. */
async function waitIdle(timeoutMs = 120000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const s = await call('GET', '/purchase/state');
    if (!s.running) return s;
    await new Promise((r) => setTimeout(r, 1500));
    process.stdout.write('.');
  }
  throw new Error('라운드가 끝나지 않았다');
}

const owner = loadOwner();
console.log(`owner = ${owner.publicKey.toBase58()}\n`);

// ---- 연결 ----
const { message } = await call('POST', '/nonce', { ownerAddress: owner.publicKey.toBase58() });
const connected = await call('POST', '/connect', {
  ownerAddress: owner.publicKey.toBase58(),
  message,
  signature: signEd25519(owner.secretKey, message).toString('base64'),
});
TOKEN = connected.authToken;

// ---- 자금 확보 ----
const me0 = await call('GET', '/me');
if (me0.agent.usdc < 26) {
  const need = Math.ceil(26 - me0.agent.usdc);
  if (me0.owner.usdc < need) await call('POST', '/faucet');
  const { txBase64 } = await call('POST', '/deposit/prepare', { amountUsdc: need });
  const tx = Transaction.from(Buffer.from(txBase64, 'base64'));
  tx.partialSign(owner);
  await call('POST', '/deposit/submit', {
    signedTx: tx.serialize().toString('base64'),
    amountUsdc: need,
  });
  console.log(`입금 ${need} USDC`);
}

// 두 구매 모두 통과시켜야 선택 결과를 비교할 수 있다. 한도는 넉넉히 연다.
await call('PUT', '/policy', { notifyMaxUsdc: 25, delayMaxUsdc: 25 });

const { listings } = await call('GET', '/catalog');

console.log('[1] 브라우저 계산과 서버 구매가 같은 것을 고르는가');
for (const weight of [1.0, 0.0]) {
  const expected = rankCandidates(listings, weight)[0];
  console.log(`\n  가격비중 ${Math.round(weight * 100)}% → 화면 1위: ${expected.id} (${expected.priceUsdc} USDC, 종합 ${expected.scores.total})`);

  const { requestId } = await call('POST', '/purchase', {
    prompt: 'Solana 연말 가격 예측 리서치',
    priceWeight: weight,
  });
  const state = await waitIdle();
  console.log('');

  const bought = state.purchases.find((p) => p.requestId === requestId);
  if (!bought) { bad('구매 건을 찾지 못했다'); continue; }

  if (bought.listing.id === expected.id) {
    ok(`서버도 같은 것을 샀다 — ${bought.listing.id} ${bought.amountUsdc} USDC · ${bought.ui}`);
  } else {
    bad(`화면 1위(${expected.id})와 서버 구매(${bought.listing.id})가 다르다`);
  }

  if (bought.decision?.priceWeight === weight) ok(`가중치가 판단 기록에 남았다 — ${bought.decision.priceWeight}`);
  else bad(`가중치가 기록되지 않았다 — ${JSON.stringify(bought.decision?.priceWeight)}`);

  console.log(`  근거(${bought.decision.source}): ${bought.decision.reason}`);
  if (bought.decision.rejected) console.log(`  기각: ${bought.decision.rejected}`);
}

console.log('\n[2] 가중치가 실제로 선택을 바꿨는가');
const state = await call('GET', '/purchase/state');
const last2 = state.purchases.slice(-2);
if (last2.length === 2 && last2[0].listing.id !== last2[1].listing.id) {
  ok(`같은 요청이 가중치에 따라 다른 공급자로 갔다 — ${last2[0].listing.id}(${last2[0].amountUsdc}) vs ${last2[1].listing.id}(${last2[1].amountUsdc})`);
} else {
  bad(`두 구매가 같은 공급자다 — 슬라이더가 결과를 바꾸지 못한다`);
}

console.log('\n[3] 정산 → 채점 → 평점');
await call('POST', '/purchase/settle');
const settled = await waitIdle(180000);
console.log('');
for (const p of settled.purchases.slice(-2)) {
  if (!p.steps?.settle) { console.log(`  (미정산) ${p.listing.id}`); continue; }
  if (p.grade) {
    ok(`채점 ${p.listing.id}: ${p.grade.score}점 (${p.grade.source}) · 평점 ${p.grade.ratingBefore} → ${p.grade.ratingAfter}`);
  } else {
    bad(`채점이 붙지 않았다 — ${p.listing.id} ${p.gradeError ?? ''}`);
  }

  const result = await call('GET', `/purchase/result/${p.requestId}`);
  if (result.markdown?.length > 100) ok(`결과물 본문 ${result.markdown.length}자 · 기준 ${result.criteria.length}항목`);
  else bad(`결과물 본문이 비었다`);
}

console.log(`\n=== 결과: 실패 ${failures}건 ===`);
process.exit(failures ? 1 : 0);

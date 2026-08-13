/**
 * 사용자 흐름 회귀 검증.
 *
 * 브라우저 지갑이 하는 일(nonce 서명·입금 트랜잭션 서명·승인 서명)을 로컬 키페어로 그대로
 * 재현해, 화면 없이도 서버 경로 전체를 실행으로 확인한다. **화면이 뜨는 것과 경로가 도는 것은
 * 다른 문제**라 둘을 따로 검증한다.
 *
 * 실행: node verify-user-flow.mjs [입금액] ["요청 문장"]
 * 키는 .verify-owner.json에 남겨 재실행 시 같은 사용자로 이어 붙는다(gitignore).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Transaction } from '@solana/web3.js';
import { Keypair, signEd25519 } from './lib/solana.js';

const BASE = process.env.A2A_BASE || 'http://127.0.0.1:4000/api/u';
const KEY_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '.verify-owner.json');

let TOKEN = '';
let failures = 0;

async function call(method, apiPath, body, opts = {}) {
  const res = await fetch(`${BASE}${apiPath}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!opts.allowFail && res.status >= 300) {
    throw new Error(`${method} ${apiPath} → ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
  }
  return { status: res.status, json };
}

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 가드 검증. 막혀야 하는 것이 실제로 막히는지 본다 — 통과하면 그게 보안 결함이다. */
function expect(label, ok, detail = '') {
  if (!ok) failures++;
  log(`${ok ? '  ✓' : '  ✗'} ${label}${detail ? ` — ${detail}` : ''}`);
}

// ---- 오너 키 (브라우저 지갑 대역) ----
let kp;
if (fs.existsSync(KEY_FILE)) {
  kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(KEY_FILE, 'utf8'))));
  log('테스트 오너 재사용');
} else {
  kp = Keypair.generate();
  fs.writeFileSync(KEY_FILE, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
  log('테스트 오너 신규 생성');
}
const OWNER = kp.publicKey.toBase58();
log(`owner = ${OWNER}\n`);

// ---- 1. 인증 가드 ----
log('[1] 인증 가드');
{
  const r = await call('GET', '/me', null, { allowFail: true });
  expect('토큰 없이 /me는 401', r.status === 401);
}

// ---- 2. 연결 (nonce 챌린지) ----
log('[2] 지갑 연결');
const { json: nonce } = await call('POST', '/nonce', { ownerAddress: OWNER });
{
  const other = Keypair.generate();
  const badSig = signEd25519(other.secretKey, nonce.message).toString('base64');
  const r = await call('POST', '/connect', { ownerAddress: OWNER, message: nonce.message, signature: badSig }, { allowFail: true });
  expect('남의 키로 만든 서명은 거부', r.status === 400, r.json.message);
}
const goodSig = signEd25519(kp.secretKey, nonce.message).toString('base64');
const { json: conn } = await call('POST', '/connect', { ownerAddress: OWNER, message: nonce.message, signature: goodSig });
TOKEN = conn.authToken;
expect('연결 성공 + 에이전트 지갑 발급', Boolean(conn.authToken && conn.agentAddress), `agent=${conn.agentAddress}`);
{
  const r = await call('POST', '/connect', { ownerAddress: OWNER, message: nonce.message, signature: goodSig }, { allowFail: true });
  expect('같은 nonce 재사용은 거부', r.status === 400);
}

// ---- 2-b. 지난 실행이 남긴 대기 건 정리 ----
// 대기 큐가 남아 있으면 이후 판정이 전부 APPROVAL로 밀려 티어 대조가 무너진다(실측된 함정).
{
  const { json: prev } = await call('GET', '/purchase/state');
  const queued = prev.purchases.filter((p) => ['DELAY', 'APPROVAL'].includes(p.ui));
  for (const p of queued) {
    const { json: m } = await call('GET', `/purchase/approve-message/${p.requestId}?action=reject`);
    await call('POST', `/purchase/cancel/${p.requestId}`, {
      message: m.message,
      signature: signEd25519(kp.secretKey, m.message).toString('base64'),
    });
  }
  if (queued.length) log(`  지난 대기 ${queued.length}건 정리`);
  await call('POST', '/purchase/reset', { purgeHistory: true });
}

// ---- 3. 체험 자산 ----
log('[3] 체험 자산');
const { json: me0 } = await call('GET', '/me');
log(`  현재: owner ${me0.owner.sol.toFixed(3)} SOL / ${me0.owner.usdc} USDC · agent ${me0.agent.sol.toFixed(3)} SOL / ${me0.agent.usdc} USDC`);
if (me0.owner.usdc < 50) {
  const { json: f } = await call('POST', '/faucet');
  expect('오너 지갑에 지급', f.granted === true, `sol=${f.solBalance} usdc=${f.usdcBalance}`);
}

// ---- 4. 입금 = 위임 ----
log('[4] 에이전트 지갑 입금 (오너 서명)');
const DEPOSIT = Number(process.argv[2] || 40);
const { json: me1 } = await call('GET', '/me');
if (me1.agent.usdc < DEPOSIT) {
  const { json: prep } = await call('POST', '/deposit/prepare', { amountUsdc: DEPOSIT });
  const tx = Transaction.from(Buffer.from(prep.txBase64, 'base64'));
  tx.partialSign(kp); // ← 브라우저 지갑이 하는 일
  const { json: sub } = await call('POST', '/deposit/submit', {
    signedTx: tx.serialize().toString('base64'),
    amountUsdc: DEPOSIT,
  });
  expect(`${DEPOSIT} USDC 입금 확정`, sub.agent.usdc >= DEPOSIT, `sig=${sub.signature.slice(0, 12)}… agent=${sub.agent.usdc} USDC`);
} else {
  log(`  입금 생략 (에이전트가 이미 ${me1.agent.usdc} USDC 보유)`);
}

// ---- 5. 정책 ----
log('[5] 정책');
{
  const r = await call('PUT', '/policy', { notifyMaxUsdc: 1, delayMaxUsdc: 999999 }, { allowFail: true });
  expect('맡긴 금액을 넘는 한도는 거부', r.status === 400, r.json.message);
}
{
  const r = await call('PUT', '/policy', { notifyMaxUsdc: 12, delayMaxUsdc: 5 }, { allowFail: true });
  expect('알림 한도 > 유예 한도는 거부', r.status === 400, r.json.message);
}
const { json: pol } = await call('PUT', '/policy', { notifyMaxUsdc: 5, delayMaxUsdc: 10 });
expect('한도 5/10 적용', pol.notifyMaxUsdc === 5 && pol.delayMaxUsdc === 10);

// ---- 6. 자유 요청 구매 ----
log('[6] 자유 요청 구매');
const PROMPT = process.argv[3] || '다음 주 팀 회의 전에 훑어볼 스테이블코인 결제 시장 요약이 필요하다';
await call('POST', '/purchase', { prompt: PROMPT });
log(`  요청: "${PROMPT}"`);

let st;
for (let i = 0; i < 90; i++) {
  await sleep(2000);
  ({ json: st } = await call('GET', '/purchase/state'));
  if (!st.running) break;
  process.stdout.write('.');
}
log('');
if (st.error) log(`  오류: ${st.error}`);
const last = st.purchases[st.purchases.length - 1];
expect('구매 1건 생성', Boolean(last), last ? `${last.listing.id} ${last.amountUsdc} USDC → ${last.ui}` : '');
if (last) {
  log(`  선택 근거(${last.decision.source}): ${last.decision.reason?.slice(0, 120)}`);
  log(`  판정: tier=${last.tier} verdict=${last.ui} auction=#${last.auctionId}`);
}

// ---- 7. 정책을 바꾸면 같은 요청의 판정이 달라진다 (이 데모의 결론) ----
log('[7] 한도 변경 → 판정 변화');
await call('PUT', '/policy', { notifyMaxUsdc: 0, delayMaxUsdc: 0 });
log('  한도를 0/0으로 낮춤 — 같은 요청을 다시 보낸다');
await call('POST', '/purchase', { prompt: PROMPT });
for (let i = 0; i < 90; i++) {
  await sleep(2000);
  ({ json: st } = await call('GET', '/purchase/state'));
  if (!st.running) break;
  process.stdout.write('.');
}
log('');
const second = st.purchases[st.purchases.length - 1];
expect(
  '같은 금액이 다른 티어로 판정',
  second && second.ui !== last?.ui,
  `${last?.amountUsdc} USDC: ${last?.ui} → ${second?.amountUsdc} USDC: ${second?.ui}`,
);

// ---- 8. 승인은 지갑 서명으로만 (컷 5) ----
if (second?.ui === 'APPROVAL') {
  log('[8] 지갑 서명 승인·거부');
  const { json: msg } = await call('GET', `/purchase/approve-message/${second.requestId}`);
  {
    const other = Keypair.generate();
    const badSig = signEd25519(other.secretKey, msg.message).toString('base64');
    const r = await call('POST', `/purchase/approve/${second.requestId}`, { message: msg.message, signature: badSig }, { allowFail: true });
    expect('남의 서명으로는 승인 불가', r.status === 400, r.json.message);
  }
  {
    // 거부 문구로 만든 서명을 승인에 재사용할 수 없어야 한다.
    const { json: rej } = await call('GET', `/purchase/approve-message/${second.requestId}?action=reject`);
    const sigR = signEd25519(kp.secretKey, rej.message).toString('base64');
    const r = await call('POST', `/purchase/approve/${second.requestId}`, { message: rej.message, signature: sigR }, { allowFail: true });
    expect('거부 서명을 승인에 재사용 불가', r.status === 400, r.json.message);
  }
  const approveSig = signEd25519(kp.secretKey, msg.message).toString('base64');
  const { json: ap } = await call('POST', `/purchase/approve/${second.requestId}`, {
    message: msg.message,
    signature: approveSig,
  });
  expect('오너 서명으로 승인 통과', ap.verdict === 'APPROVED', `verdict=${ap.verdict}`);

  // 거부 경로: 한 건 더 사서 이번엔 거둔다. 승인만 있고 거부가 없으면 대기 큐가 쌓인다.
  log('[8-b] 거부 경로');
  await call('POST', '/purchase', { prompt: PROMPT });
  for (let i = 0; i < 90; i++) {
    await sleep(2000);
    ({ json: st } = await call('GET', '/purchase/state'));
    if (!st.running) break;
    process.stdout.write('.');
  }
  log('');
  const third = st.purchases[st.purchases.length - 1];
  if (third?.ui === 'APPROVAL') {
    const { json: rm } = await call('GET', `/purchase/approve-message/${third.requestId}?action=reject`);
    const { json: cx } = await call('POST', `/purchase/cancel/${third.requestId}`, {
      message: rm.message,
      signature: signEd25519(kp.secretKey, rm.message).toString('base64'),
    });
    expect('오너 서명으로 거부', cx.verdict === 'REJECTED', `verdict=${cx.verdict}`);
  } else {
    log(`  거부 검증 생략 — ${third?.ui}`);
  }
} else {
  log(`[8] 승인 검증 생략 — 두 번째 건이 ${second?.ui}라 승인 대기가 아니다`);
}

// ---- 9. 정산 + 결과물 ----
log('[9] 정산');
await call('POST', '/purchase/settle');
for (let i = 0; i < 120; i++) {
  await sleep(2000);
  ({ json: st } = await call('GET', '/purchase/state'));
  if (!st.running) break;
  process.stdout.write('.');
}
log('');
for (const p of st.purchases) {
  const paid = p.x402 ? `x402 ${p.x402.amountUsdc} USDC` : (p.unlockError ? `x402 실패: ${p.unlockError}` : 'x402 없음');
  log(`  ${p.listing.id} ${p.amountUsdc} USDC · ${p.ui} · ${p.steps?.settle ? '정산완료' : (p.settleError || '미정산')} · ${paid}`);
}
// 거부·대기 건은 정산 대상이 아니다. 이걸 합계에 넣으면 영수증이 거짓을 말한다.
const settleTargets = st.purchases.filter((p) => ['NOTIFY', 'INSTANT', 'APPROVED', 'RELEASED'].includes(p.ui));
expect(
  '실행된 건 전부 정산',
  settleTargets.length > 0 && settleTargets.every((p) => p.steps?.settle),
  `${settleTargets.filter((p) => p.steps?.settle).length}/${settleTargets.length}`,
);

const { json: receipt } = await call('GET', '/purchase/receipt');
expect('영수증 조립', Boolean(receipt.totals), `지출 ${receipt.totals?.spentUsdc} USDC · x402 ${receipt.totals?.x402Usdc} USDC`);
log(`  영수증 정책: ${receipt.policy?.note}`);

log(`\n=== 결과: 실패 ${failures}건 · phase=${st?.phase} · 누적 구매 ${st?.purchases.length}건 ===`);
const { json: me2 } = await call('GET', '/me');
log(`잔고: owner ${me2.owner.usdc} USDC · agent ${me2.agent.usdc} USDC · 한도 ${me2.policy.notifyMaxUsdc}/${me2.policy.delayMaxUsdc}`);
process.exit(failures ? 1 : 0);

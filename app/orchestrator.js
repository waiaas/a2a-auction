/**
 * 경매 오케스트레이터 (스펙 5.1). 데모 상태 머신을 HTTP로 노출한다.
 *
 *   POST /api/auction/open    경매 개설만(판매자 콘솔) — 이후 phase='open'에서 입찰을 기다린다
 *   POST /api/auction/start   입찰 시작(비동기 실행, 즉시 202). 아직 개설 전이면 개설부터 이어서 돈다
 *   GET  /api/auction/state   현재 상태(UI 1초 폴링)
 *   GET  /api/receipt         정산 완료 시 SettlementReceipt
 *   POST /api/auction/reset   상태 초기화(다음 라운드는 새 auction 계정)
 *   GET  /api/owner/pending   B(Growth) 승인 대기 큐 + 위임 한도 (owner 콘솔 폴링)
 *   POST /api/owner/reject/:txId  대기 tx 거부 — 데몬 어드민 API로 relay(마스터 인증)
 *
 * 실행: node orchestrator.js   ← 데몬/localnet 호출이 있어 Bash는 dangerouslyDisableSandbox 필요
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { ORCHESTRATOR_PORT, SELLER_PORT, PATHS, USDC_DECIMALS, NETWORK_LABEL, MAIN_BUYER } from './config.js';
import { initState, buildDeps, openAuction, runBidding, runAuction, assembleReceipt } from './auction-flow.js';
import {
  initPurchaseState,
  runPurchaseRound,
  refreshPurchases,
  settlePurchases,
  approvePurchase,
  assemblePurchaseReceipt,
} from './purchase-flow.js';
import { loadListings } from './lib/decision.js';

const actors = JSON.parse(fs.readFileSync(path.join(PATHS.fixtures, 'actors.json'), 'utf8'));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIST = path.join(__dirname, 'web/dist'); // Vite 빌드 산출 (없으면 dev는 Vite proxy 사용)

let state = initState();
let running = false;
let roundCtx = null; // openAuction 산출물(auctionPda·vault·bidPda) — 입찰 시작이 이어받는다

const app = express();
app.use(express.json());

/** 라운드 실행 공통 래퍼: 실패를 phase='error'로 표면화하고 running을 되돌린다. */
function runInBackground(promise, label) {
  running = true;
  promise
    .catch((e) => {
      state.phase = 'error';
      state.error = e.message;
      console.error(`[orchestrator] ${label} 실패:`, e.message);
    })
    .finally(() => {
      running = false;
    });
}

/** 매 요청마다 config를 새로 읽는다(시드 재실행으로 정책 ID·nextAuctionId가 바뀌어도 안전). */
function depsOrError(res) {
  try {
    return buildDeps();
  } catch (e) {
    res.status(400).json({ error: 'not_seeded', message: e.message });
    return null;
  }
}

app.get('/health', (_req, res) => res.json({ status: 'ok', phase: state.phase }));

app.post('/api/auction/open', (_req, res) => {
  if (running) return res.status(409).json({ error: 'already_running', phase: state.phase });
  if (state.phase !== 'idle') return res.status(409).json({ error: 'already_open', phase: state.phase });
  const d = depsOrError(res);
  if (!d) return;
  state = initState();
  roundCtx = null;
  runInBackground(
    openAuction(state, d).then((ctx) => {
      roundCtx = ctx;
    }),
    'openAuction',
  );
  return res.status(202).json({ opening: true });
});

app.post('/api/auction/start', (_req, res) => {
  if (running) {
    return res.status(409).json({ error: 'already_running', phase: state.phase });
  }
  const d = depsOrError(res);
  if (!d) return;
  // 판매자 콘솔이 먼저 개설했으면 입찰만 이어서 실행한다. 개설 전이면 개설부터 한 번에 돈다
  // (기존 단일 버튼 경로 · verify-e2e.sh가 이쪽을 쓴다).
  if (roundCtx && state.phase === 'open') {
    runInBackground(runBidding(state, d, roundCtx), 'runBidding');
  } else {
    state = initState();
    roundCtx = null;
    runInBackground(runAuction(state, d), 'runAuction');
  }
  return res.status(202).json({ started: true, phase: state.phase });
});

// network는 상태 머신의 값이 아니라 서버 환경(RPC_URL)에서 오는 표시용 상수라 응답에서 병합한다.
app.get('/api/auction/state', (_req, res) => res.json({ ...state, network: NETWORK_LABEL }));

app.get('/api/receipt', (_req, res) => {
  const receipt = assembleReceipt(state);
  if (!receipt) return res.status(404).json({ error: 'not_settled', phase: state.phase });
  res.json(receipt);
});

app.post('/api/auction/reset', (req, res) => {
  if (running) return res.status(409).json({ error: 'running', phase: state.phase });
  const scenario = req.body?.scenario || 'default';
  state = initState();
  roundCtx = null;
  res.json({ reset: true, scenario });
});

// ---- 구매 라운드 (콘티 v3) ----
// 기존 경매 라우트는 그대로 둔다 — 새 흐름이 완성될 때까지 폴백이 필요하다.
//
//   GET  /api/purchase/catalog            카탈로그 리스팅 3종 (컷 1)
//   POST /api/purchase/start              요청 3건 → 선택 → 구매 → 실행된 건 정산 (컷 3·4·6)
//   GET  /api/purchase/state              현재 상태. 대기 건이 있으면 데몬에서 갱신해 준다
//   POST /api/purchase/approve/:requestId 승인 대기 건 승인 (컷 5)
//   POST /api/purchase/settle             유예·승인이 풀린 건 정산
//   POST /api/purchase/reset              상태 초기화

let purchaseState = initPurchaseState();
let purchaseRunning = false;

function runPurchaseInBackground(promise, label) {
  purchaseRunning = true;
  promise
    .catch((e) => {
      purchaseState.phase = 'error';
      purchaseState.error = e.message;
      console.error(`[orchestrator] ${label} 실패:`, e.message);
    })
    .finally(() => {
      purchaseRunning = false;
    });
}

app.get('/api/purchase/catalog', (_req, res) => res.json({ listings: loadListings() }));

app.post('/api/purchase/start', (_req, res) => {
  if (purchaseRunning) return res.status(409).json({ error: 'already_running', phase: purchaseState.phase });
  const d = depsOrError(res);
  if (!d) return;
  purchaseState = initPurchaseState();
  // 구매 직후 실행된 건(NOTIFY)은 바로 정산한다. 유예·승인 건은 대기로 남아 컷 5로 이어진다.
  runPurchaseInBackground(
    runPurchaseRound(purchaseState, d).then(() => settlePurchases(purchaseState, d)),
    'runPurchaseRound',
  );
  return res.status(202).json({ started: true });
});

app.get('/api/purchase/state', async (_req, res) => {
  // 유예는 시간이 지나면 스스로 풀린다. 폴링 때마다 대기 건만 확인해 화면이 그 변화를 잡게 한다.
  if (!purchaseRunning && purchaseState.purchases.length) {
    try {
      const d = buildDeps();
      await refreshPurchases(purchaseState, d);
    } catch (e) {
      console.error('[orchestrator] purchase 상태 갱신 실패:', e.message);
    }
  }
  res.json({ ...purchaseState, network: NETWORK_LABEL, running: purchaseRunning });
});

app.post('/api/purchase/settle', (_req, res) => {
  if (purchaseRunning) return res.status(409).json({ error: 'already_running', phase: purchaseState.phase });
  const d = depsOrError(res);
  if (!d) return;
  runPurchaseInBackground(settlePurchases(purchaseState, d), 'settlePurchases');
  return res.status(202).json({ settling: true });
});

/**
 * 승인 relay. **데몬에 승인 라우트가 없으면 502로 떨어진다** — 현재 이미지가 그 상태다
 * (`transactions.ts`의 등록 조건 중 ownerLifecycle이 주입되지 않아 라우트 자체가 미등록).
 * 우리 쪽 배선은 끝나 있으므로 데몬이 고쳐지면 그대로 동작한다.
 */
app.post('/api/purchase/approve/:requestId', ownerGuard, async (req, res) => {
  if (purchaseRunning) return res.status(409).json({ error: 'already_running', phase: purchaseState.phase });
  const d = depsOrError(res);
  if (!d) return;
  try {
    const purchase = await approvePurchase(purchaseState, d, req.params.requestId);
    res.json({ requestId: purchase.requestId, ui: purchase.ui, status: purchase.steps.deposit?.status });
  } catch (e) {
    console.error('[orchestrator] purchase 승인 실패:', e.message);
    res.status(502).json({ error: 'approve_failed', message: e.message });
  }
});

// 컷 8. 정산 전에도 그 시점까지의 기록을 낸다 — 발표 중 아무 때나 열 수 있어야 한다.
app.get('/api/purchase/receipt', (_req, res) => {
  const receipt = assemblePurchaseReceipt(purchaseState);
  if (!receipt) return res.status(404).json({ error: 'no_round', phase: purchaseState.phase });
  res.json({ ...receipt, network: NETWORK_LABEL });
});

app.post('/api/purchase/reset', (_req, res) => {
  if (purchaseRunning) return res.status(409).json({ error: 'running', phase: purchaseState.phase });
  purchaseState = initPurchaseState();
  res.json({ reset: true });
});

// ---- Owner 콘솔 relay (B = Growth Agent의 owner 시점) ----
// 데몬의 승인 큐·거부는 원래 어드민 UI(:3101/admin)의 기능이다. 영상에서 오리진을 오가며
// 재로그인하는 문제를 없애려고 같은 SPA에서 쓸 수 있게 relay한다. 마스터 패스워드는
// 오케스트레이터가 이미 보유한 것(정책 갱신에 사용)을 그대로 쓴다 — 새 권한이 아니다.
// 주인공 바이어를 그대로 따라간다. 여기에 'buyer-b'를 박아 두면 새 시나리오의 승인 대기 건이
// Owner 콘솔에 **하나도 뜨지 않고**(다른 지갑의 큐를 보므로) 위임 한도도 남의 값을 표시한다.
const OWNER_ROLE = MAIN_BUYER;

/**
 * 바인딩 주소. 루프백이 아니면 owner relay가 인터넷에 열린다는 뜻이다.
 * (아래 listen에서 그대로 쓴다. 라우트 등록 판단에 필요해 여기서 정한다.)
 */
const HOST = process.env.HOST || '127.0.0.1';
const IS_LOOPBACK_BIND = HOST === '127.0.0.1' || HOST === 'localhost' || HOST === '::1';

/**
 * owner relay 인증 토큰. **로컬은 루프백 바인딩이 방어막이었지만 클라우드에는 그게 없다**
 * (독립 감사 F2의 미결분 — 공개 배포 시 누구나 승인 대기 건을 거부할 수 있다).
 * 토큰이 있으면 요구하고, 없으면 통과시킨다 — 기존 로컬 실행 절차를 바꾸지 않기 위해서다.
 * 대신 공개 바인딩 + 토큰 없음 조합은 아래에서 라우트 자체를 등록하지 않는다(fail-safe).
 */
const OWNER_TOKEN = process.env.OWNER_TOKEN || '';

function ownerGuard(req, res, next) {
  // 공개 바인딩 + 토큰 없음 = 무인증 노출. 이 조합에서는 owner 기능 자체를 닫는다.
  if (!IS_LOOPBACK_BIND && !OWNER_TOKEN) {
    return res.status(404).json({ error: 'owner_routes_disabled' });
  }
  if (!OWNER_TOKEN) return next();
  const got = Buffer.from(String(req.get('x-owner-token') || req.query.t || ''));
  const want = Buffer.from(OWNER_TOKEN);
  // timingSafeEqual은 길이가 다르면 예외를 던지므로 길이를 먼저 본다(길이 노출은 감수).
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) {
    return res.status(401).json({ error: 'owner_unauthorized' });
  }
  return next();
}

/**
 * B의 SPENDING_LIMIT 위임 한도를 데몬에서 실제로 읽는다. 화면이 "데몬에 등록됨"이라고
 * 말하므로 config 상수를 돌려주면 거짓이 된다(감사 F1 — 데몬 정책을 바꿔도 화면이 5를
 * 유지하는 것으로 적발). 정책이 없으면 null → 화면은 '—'.
 */
async function fetchOwnerLimitUsdc(d) {
  const policies = await d.clients[OWNER_ROLE].listPolicies();
  const sl = policies.find((p) => p.type === 'SPENDING_LIMIT');
  const limits = sl?.rules?.token_limits?.[d.config.assetId];
  return limits?.delay_max != null ? Number(limits.delay_max) : null;
}

app.get('/api/owner/pending', ownerGuard, async (_req, res) => {
  const d = depsOrError(res);
  if (!d) return;
  try {
    const [items, limitUsdc] = await Promise.all([
      d.clients[OWNER_ROLE].pendingTxs(),
      fetchOwnerLimitUsdc(d),
    ]);
    res.json({
      role: OWNER_ROLE,
      name: actors[OWNER_ROLE].name,
      mandateChip: actors[OWNER_ROLE].mandateChip,
      limitUsdc,
      pending: items.map((t) => ({
        id: t.id,
        amountUsdc: t.amount != null ? Number(t.amount) / 10 ** USDC_DECIMALS : null,
        toAddress: t.toAddress,
        tier: t.tier,
        status: t.status,
        createdAt: t.createdAt,
      })),
    });
  } catch (e) {
    console.error('[orchestrator] owner pending 조회 실패:', e.message);
    res.status(502).json({ error: 'daemon_unreachable' });
  }
});

app.post('/api/owner/reject/:txId', ownerGuard, async (req, res) => {
  const d = depsOrError(res);
  if (!d) return;
  try {
    const out = await d.clients[OWNER_ROLE].adminRejectTx(req.params.txId);
    res.json(out); // { id, status: 'CANCELLED', rejectedAt }
  } catch (e) {
    console.error('[orchestrator] owner reject 실패:', e.message);
    res.status(502).json({ error: 'reject_failed', message: e.message });
  }
});

// seller 결과 unlock(:4100)을 같은 오리진으로 relay. 정적 서빙(prod)에서 프론트가 /slot을 그대로 쓰게 한다.
// dev는 Vite proxy가 /slot을 직접 4100으로 보내므로 이 라우트를 타지 않는다. 스펙 3.2 단일 오리진 원칙 유지.
app.get('/slot/:auctionId/result', async (req, res) => {
  try {
    const r = await fetch(`http://127.0.0.1:${SELLER_PORT}/slot/${req.params.auctionId}/result`);
    const body = await r.text();
    res.status(r.status).type('application/json').send(body);
  } catch (e) {
    console.error('[orchestrator] seller relay 실패:', e.message);
    res.status(502).json({ error: 'seller_unreachable' });
  }
});

// 웹 UI 정적 서빙(같은 오리진 → CORS 불필요). /api/*·/slot은 위에서 이미 처리되므로 나머지만 여기로 온다.
// dev는 Vite(5173)가 /api·/slot을 프록시하므로 dist가 없어도 무방하다.
app.use(express.static(WEB_DIST));

// 기본 루프백 바인딩(HOST는 위 owner relay 절에서 정의). LAN·인터넷에 열면 같은 망의 누구든
// B의 승인 대기를 거부하거나 라운드를 조작할 수 있다(감사 F2). 클라우드 배포처럼 외부
// 바인딩이 필요할 때만 HOST=0.0.0.0을 명시하고, 그때는 OWNER_TOKEN을 함께 준다.
app.listen(ORCHESTRATOR_PORT, HOST, () => {
  const ownerMode = !IS_LOOPBACK_BIND && !OWNER_TOKEN
    ? 'owner=disabled (공개 바인딩인데 OWNER_TOKEN 없음)'
    : OWNER_TOKEN
      ? 'owner=token'
      : 'owner=open (루프백 전용)';
  console.log(`orchestrator listening on http://${HOST}:${ORCHESTRATOR_PORT}  [${ownerMode}]`);
});

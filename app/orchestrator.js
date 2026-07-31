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
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { ORCHESTRATOR_PORT, SELLER_PORT, TOKEN_LIMITS, PATHS, USDC_DECIMALS } from './config.js';
import { initState, buildDeps, openAuction, runBidding, runAuction, assembleReceipt } from './auction-flow.js';

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

app.get('/api/auction/state', (_req, res) => res.json(state));

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

// ---- Owner 콘솔 relay (B = Growth Agent의 owner 시점) ----
// 데몬의 승인 큐·거부는 원래 어드민 UI(:3101/admin)의 기능이다. 영상에서 오리진을 오가며
// 재로그인하는 문제를 없애려고 같은 SPA에서 쓸 수 있게 relay한다. 마스터 패스워드는
// 오케스트레이터가 이미 보유한 것(정책 갱신에 사용)을 그대로 쓴다 — 새 권한이 아니다.
const OWNER_ROLE = 'buyer-b';

app.get('/api/owner/pending', async (_req, res) => {
  const d = depsOrError(res);
  if (!d) return;
  try {
    const items = await d.clients[OWNER_ROLE].pendingTxs();
    res.json({
      role: OWNER_ROLE,
      name: actors[OWNER_ROLE].name,
      mandateChip: actors[OWNER_ROLE].mandateChip,
      limitUsdc: Number(TOKEN_LIMITS[OWNER_ROLE]?.delay_max ?? 0),
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

app.post('/api/owner/reject/:txId', async (req, res) => {
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

app.listen(ORCHESTRATOR_PORT, () => {
  console.log(`orchestrator listening on http://127.0.0.1:${ORCHESTRATOR_PORT}`);
});

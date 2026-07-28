/**
 * 경매 오케스트레이터 (스펙 5.1). 데모 상태 머신을 HTTP로 노출한다.
 *
 *   POST /api/auction/start   라운드 시작(비동기 실행, 즉시 202) — 발표자 버튼 1개
 *   GET  /api/auction/state   현재 상태(UI 1초 폴링)
 *   GET  /api/receipt         정산 완료 시 SettlementReceipt
 *   POST /api/auction/reset   상태 초기화(다음 라운드는 새 auction 계정)
 *
 * 실행: node orchestrator.js   ← 데몬/localnet 호출이 있어 Bash는 dangerouslyDisableSandbox 필요
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { ORCHESTRATOR_PORT, SELLER_PORT } from './config.js';
import { initState, buildDeps, runAuction, assembleReceipt } from './auction-flow.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIST = path.join(__dirname, 'web/dist'); // Vite 빌드 산출 (없으면 dev는 Vite proxy 사용)

let state = initState();
let running = false;

const app = express();
app.use(express.json());

app.get('/health', (_req, res) => res.json({ status: 'ok', phase: state.phase }));

app.post('/api/auction/start', (_req, res) => {
  if (running) {
    return res.status(409).json({ error: 'already_running', phase: state.phase });
  }
  // 매 라운드 config를 새로 읽는다(시드 재실행으로 정책 ID·nextAuctionId가 바뀌어도 안전).
  let d;
  try {
    d = buildDeps();
  } catch (e) {
    return res.status(400).json({ error: 'not_seeded', message: e.message });
  }
  // 새 라운드 상태로 초기화 후 비동기 실행
  state = initState();
  state.phase = 'committing';
  running = true;
  runAuction(state, d)
    .catch((e) => {
      state.phase = 'error';
      state.error = e.message;
      console.error('[orchestrator] runAuction 실패:', e.message);
    })
    .finally(() => {
      running = false;
    });
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
  res.json({ reset: true, scenario });
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

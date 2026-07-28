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
import express from 'express';
import { ORCHESTRATOR_PORT } from './config.js';
import { initState, buildDeps, runAuction, assembleReceipt } from './auction-flow.js';

let state = initState();
let running = false;
let deps = null;

function ensureDeps() {
  if (!deps) deps = buildDeps(); // config 없으면 여기서 throw
  return deps;
}

const app = express();
app.use(express.json());

app.get('/health', (_req, res) => res.json({ status: 'ok', phase: state.phase }));

app.post('/api/auction/start', (_req, res) => {
  if (running) {
    return res.status(409).json({ error: 'already_running', phase: state.phase });
  }
  let d;
  try {
    d = ensureDeps();
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

app.listen(ORCHESTRATOR_PORT, () => {
  console.log(`orchestrator listening on http://127.0.0.1:${ORCHESTRATOR_PORT}`);
});

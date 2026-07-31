/**
 * 경매 데모 경로 상태 머신 (스펙 3.3, 5.1). 한 라운드를 끝까지 실행하며 state를 in-place로 갱신한다.
 * 오케스트레이터는 이 state 참조를 그대로 /state로 노출한다(1초 폴링).
 *
 * 흐름: (WHITELIST 갱신) → create_auction → commit×3 → deposit×3 → reveal A → settle → seller unlock
 *
 * load-bearing 반영(D-6 스파이크):
 *  ① 예치 to=auction_pda(vault ATA 아님) → 데몬이 vault ATA 유도
 *  ② commit_bid도 WHITELIST 평가 → C는 [programId]만, A·B는 [programId, auction_pda]
 *  ③ deposit TOKEN_TRANSFER에 token.assetId(CAIP-19) 필수
 *  ④ A는 tier NOTIFY(자동 실행) → UI는 ALLOW
 *  ⑤ B owner는 Ed25519 verify로 LOCKED → APPROVAL 유지(시드가 보장)
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  AMOUNTS,
  AUCTION_ITEM,
  PROGRAM_ID,
  PATHS,
  TOKEN_LIMITS,
  X402_UNLOCK,
  SELLER_PUBLIC_URL,
} from './config.js';
import {
  connection,
  deriveAuctionPda,
  deriveVault,
  deriveBidPda,
  commitHash,
  saltFor,
  fetchAuction,
  tokenUiBalance,
  confirmSig,
} from './lib/solana.js';
import {
  buildCreateAuction,
  buildCommitBid,
  buildDeposit,
  buildRevealBid,
  buildSettle,
} from './lib/instructions.js';
import { getQuoteAndRationale, getResult } from './lib/gemini.js';
import { loadConfig, saveConfig, loadStateByRole, loadEnv, masterPasswordFor } from './lib/state.js';
import { daemonClient } from './lib/daemon.js';

const BUYERS = ['buyer-a', 'buyer-b', 'buyer-c'];
const TX_OK = ['CONFIRMED', 'SUBMITTED'];
const actors = JSON.parse(fs.readFileSync(path.join(PATHS.fixtures, 'actors.json'), 'utf8'));

/** 오케스트레이터가 보관하는 초기 상태. */
export function initState() {
  return {
    phase: 'idle', // idle|committing|depositing|revealing|settling|settled|error
    auctionId: null,
    startedAt: null,
    settledAt: null,
    error: null,
    item: AUCTION_ITEM,
    addresses: {},
    buyers: {},
    steps: { createAuction: null, reveal: null, settle: null },
    auctionState: null,
    result: null,
    resultMeta: null, // { hash, source } — seller가 unlock하는 결과물 메타
    log: [],
  };
}

/** 데모 실행에 필요한 의존성 묶음(오케스트레이터가 1회 구성). */
export function buildDeps() {
  const config = loadConfig();
  if (!config) throw new Error('demo-config.json 없음 — 먼저 `node seed.js` 실행');
  const byRole = loadStateByRole();
  const env = loadEnv();
  const clients = {};
  for (const role of [...BUYERS, 'marketplace']) {
    clients[role] = daemonClient(byRole[role], masterPasswordFor(env, role));
  }
  return { conn: connection(), config, byRole, clients };
}

function pushLog(state, msg) {
  state.log.push(msg);
  console.log(`  [flow] ${msg}`);
}

/** 온체인에서 비어 있는 auction_id 슬롯을 앞으로 스캔(스파이크·이전 라운드와 충돌 방지). */
async function pickFreeAuctionId(conn, marketplace, start) {
  let id = start;
  // 안전 상한: 무한 루프 방지
  for (let i = 0; i < 10000; i++) {
    const pda = deriveAuctionPda(marketplace, id);
    if (!(await fetchAuction(conn, pda))) return id;
    id++;
  }
  throw new Error('빈 auction_id 슬롯을 찾지 못함');
}

/**
 * 한 라운드 전체 실행. state를 단계마다 갱신한다.
 * 실패해도 되는 단계(B QUEUED, C DENIED)는 오류로 보지 않는다.
 */
export async function runAuction(state, deps) {
  const { conn, config, clients } = deps;
  const marketplace = config.marketplace;
  const seller = config.seller;
  const mint = config.mint;
  const assetId = config.assetId;
  const sellerTokenAccount = config.sellerTokenAccount;

  state.startedAt = new Date().toISOString();

  // ---- 셋업: auction_id 확정 + 주소 유도 ----
  const auctionId = await pickFreeAuctionId(conn, marketplace, config.nextAuctionId);
  state.auctionId = auctionId;
  const auctionPda = deriveAuctionPda(marketplace, auctionId);
  const vault = deriveVault(mint, auctionPda);
  const bidPda = Object.fromEntries(
    BUYERS.map((r) => [r, deriveBidPda(auctionPda, config.addresses[r])]),
  );
  state.addresses = {
    programId: PROGRAM_ID,
    auctionPda: auctionPda.toBase58(),
    vault: vault.toBase58(),
    marketplace,
    seller,
    sellerTokenAccount,
    mint,
    assetId,
    bidA: bidPda['buyer-a'].toBase58(),
    bidB: bidPda['buyer-b'].toBase58(),
    bidC: bidPda['buyer-c'].toBase58(),
  };

  // buyer 상태 초기화 + Gemini 견적·rationale
  for (const role of BUYERS) {
    const meta = actors[role];
    const { quote, rationale, source } = await getQuoteAndRationale(role, AUCTION_ITEM);
    state.buyers[role] = {
      role,
      name: meta.name,
      emoji: meta.emoji,
      mandateChip: meta.mandateChip,
      address: config.addresses[role],
      bidUsdc: Number(AMOUNTS[role]) / 1e6,
      quote,
      rationale,
      quoteSource: source,
      commit: null,
      deposit: null,
      ui: null, // ALLOW | APPROVAL_REQUIRED | DENY
    };
  }
  pushLog(state, `auction_id=${auctionId} auctionPda=${auctionPda.toBase58()}`);

  // ---- Step 1: A·B WHITELIST에 이번 라운드 auction_pda 추가 (C는 그대로) ----
  state.phase = 'committing';
  for (const role of ['buyer-a', 'buyer-b']) {
    const wlId = config.policies[role].whitelist;
    // A만 seller 주소를 추가한다: 정산 후 결과물 unlock의 x402 결제가 payTo=seller 지갑인
    // TRANSFER로 평가되므로 WHITELIST에 없으면 POLICY_DENIED로 막힌다. 이 PUT이 라운드마다
    // 전체를 덮어쓰므로 시드에만 넣어두면 유지되지 않는다.
    const allowed = [PROGRAM_ID, auctionPda.toBase58()];
    if (role === 'buyer-a') allowed.push(config.seller);
    await clients[role].updatePolicy(wlId, { allowed_addresses: allowed });
  }
  pushLog(state, 'WHITELIST 갱신: A = [programId, auctionPda, seller], B = [programId, auctionPda], C = [programId]');

  // ---- Step 2: create_auction (marketplace) ----
  {
    const body = buildCreateAuction({ marketplace, seller, mint, auctionPda, vault, auctionId });
    const id = await clients['marketplace'].sendTx(body);
    const fin = await clients['marketplace'].pollTx(id, ['CONFIRMED', 'SUBMITTED', 'FAILED', 'CANCELLED']);
    const onchain = await confirmSig(conn, fin.txHash);
    state.steps.createAuction = { status: fin.status, txHash: fin.txHash || null, onchain };
    if (!TX_OK.includes(fin.status)) throw new Error(`create_auction 실패: ${JSON.stringify(fin)}`);
    pushLog(state, `create_auction ${fin.status} onchain=${onchain}`);
  }

  // ---- Step 3: commit × 3 (정책 무관, 3자 모두 성공) ----
  for (const role of BUYERS) {
    const body = buildCommitBid({
      bidder: config.addresses[role],
      auctionPda,
      bidPda: bidPda[role],
      commitHash: commitHash(AMOUNTS[role], role, auctionId),
    });
    const id = await clients[role].sendTx(body);
    const fin = await clients[role].pollTx(id, ['CONFIRMED', 'SUBMITTED', 'FAILED', 'CANCELLED']);
    const onchain = await confirmSig(conn, fin.txHash);
    state.buyers[role].commit = { status: fin.status, tier: fin.tier || null, txHash: fin.txHash || null, onchain };
    if (!TX_OK.includes(fin.status)) throw new Error(`${role} commit 실패: ${JSON.stringify(fin)}`);
    pushLog(state, `${role} commit ${fin.status} onchain=${onchain}`);
  }

  // ---- Step 4: deposit × 3 (단독 TOKEN_TRANSFER, to=auction_pda) ----
  state.phase = 'depositing';
  const depositStop = ['CONFIRMED', 'SUBMITTED', 'QUEUED', 'DELAYED', 'CANCELLED', 'FAILED'];
  for (const role of BUYERS) {
    const body = buildDeposit({ auctionPda, amount: AMOUNTS[role], mint, assetId });
    const id = await clients[role].sendTx(body);
    const fin = await clients[role].pollTx(id, depositStop, role === 'buyer-a' ? 45000 : 20000);
    const onchain = await confirmSig(conn, fin.txHash);
    const decision = classifyDeposit(fin);
    state.buyers[role].deposit = {
      txId: id,
      status: fin.status,
      tier: fin.tier || null,
      txHash: fin.txHash || null,
      onchain,
      decision,
      error: fin.error || fin.errorMessage || null,
    };
    state.buyers[role].ui = decision; // ALLOW(A) / APPROVAL_REQUIRED(B) / DENY(C)
    pushLog(state, `${role} deposit ${fin.status} tier=${fin.tier || '-'} → ${decision}`);
  }
  // B가 승인 대기 큐에 실제로 있는지 확인
  {
    const ids = await clients['buyer-b'].pendingTxIds();
    state.buyers['buyer-b'].deposit.inPending = ids.includes(state.buyers['buyer-b'].deposit.txId);
  }

  // A의 예치가 온체인에 실제로 반영될 때까지 대기한 뒤 reveal로 넘어간다.
  // 데몬은 tx를 제출하면 SUBMITTED를 반환하는데, reveal_bid는 vault 잔고가 reveal 금액
  // 이상일 것을 요구한다(DepositNotFound). 이 간극을 흡수하지 않으면 라운드 전체가 죽는다.
  const depA = state.buyers['buyer-a'].deposit;
  if (depA.decision === 'ALLOW' || depA.decision === 'TIMEOUT') {
    const wait = await waitForVaultDeposit(conn, vault, depA.txHash, state.buyers['buyer-a'].bidUsdc);
    depA.onchainConfirmed = wait.confirmed;
    state.vaultAfterDeposit = wait.balance;
    pushLog(
      state,
      wait.confirmed
        ? `A 예치 확정: vault=${wait.balance} USDC (${wait.waitedMs}ms 대기, sig=${wait.status})`
        : `A 예치 확정 대기 초과(${wait.waitedMs}ms): sig=${wait.status} vault=${wait.balance} — reveal은 그대로 시도`,
    );
  } else {
    state.vaultAfterDeposit = await tokenUiBalance(conn, vault);
    pushLog(state, `vault after deposits = ${state.vaultAfterDeposit} USDC (A 예치 판정=${depA.decision})`);
  }

  // ---- Step 5: reveal A ----
  state.phase = 'revealing';
  {
    const role = 'buyer-a';
    const body = buildRevealBid({
      bidder: config.addresses[role],
      auctionPda,
      bidPda: bidPda[role],
      vault,
      amount: AMOUNTS[role],
      salt: saltFor(role, auctionId),
    });
    const id = await clients[role].sendTx(body);
    const fin = await clients[role].pollTx(id, ['CONFIRMED', 'SUBMITTED', 'FAILED', 'CANCELLED']);
    const onchain = await confirmSig(conn, fin.txHash);
    state.steps.reveal = { status: fin.status, txHash: fin.txHash || null, onchain };
    if (!TX_OK.includes(fin.status)) throw new Error(`reveal A 실패: ${JSON.stringify(fin)}`);
    pushLog(state, `reveal A ${fin.status} onchain=${onchain}`);
  }

  // ---- Step 6: settle (marketplace → winner A, vault→seller) ----
  state.phase = 'settling';
  {
    const body = buildSettle({ marketplace, auctionPda, vault, sellerTokenAccount });
    const id = await clients['marketplace'].sendTx(body);
    const fin = await clients['marketplace'].pollTx(id, ['CONFIRMED', 'SUBMITTED', 'FAILED', 'CANCELLED']);
    const onchain = await confirmSig(conn, fin.txHash);
    state.steps.settle = { status: fin.status, txHash: fin.txHash || null, onchain };
    if (!TX_OK.includes(fin.status)) throw new Error(`settle 실패: ${JSON.stringify(fin)}`);
    pushLog(state, `settle ${fin.status} onchain=${onchain}`);
  }

  // ---- 마감: 온체인 확인 + 결과 생성 ----
  const sellerUsdc = await tokenUiBalance(conn, sellerTokenAccount);
  const vaultUsdc = await tokenUiBalance(conn, vault);
  state.result = { sellerUsdc, vaultUsdc };

  const onchainAuction = await fetchAuction(conn, auctionPda);
  state.auctionState = onchainAuction
    ? {
        status: onchainAuction.status,
        highest: onchainAuction.highest,
        winner: onchainAuction.winner,
        winnerIsA: onchainAuction.winner === config.addresses['buyer-a'],
      }
    : null;

  // 정산 후 seller가 여는 결과물 메타(내용은 seller 서비스가 게이트).
  // auctionId를 넘겨 이 라운드의 확정본을 캐시 → seller가 동일 hash를 재현(M2).
  const result = await getResult(AUCTION_ITEM, auctionId);
  state.resultMeta = { hash: result.hash, source: result.source, unlockedFor: 'buyer-a' };

  // ---- x402 결과물 unlock (X402_UNLOCK) ----
  // phase='settled' 이전에 끝내야 UI가 Receipt를 열 때 seller의 결제 마커가 준비돼 있다.
  if (X402_UNLOCK) {
    state.x402 = await unlockViaX402(clients['buyer-a'], auctionId, state);
    pushLog(state, `x402 unlock: ${state.x402.amountUsdc} USDC sig=${state.x402.onchainSignature}`);
  }

  // nextAuctionId 영속화(다음 라운드는 +1부터 스캔)
  const cfg = loadConfig();
  cfg.nextAuctionId = auctionId + 1;
  saveConfig(cfg);

  state.settledAt = new Date().toISOString();
  state.phase = 'settled';
  pushLog(state, `settled: seller=${sellerUsdc} vault=${vaultUsdc} winner=${state.auctionState?.winner}`);
  return state;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A의 데몬으로 seller 결과물을 x402 결제해 unlock한다.
 *
 * 데몬 응답의 `payment` 존재가 "402를 거쳐 실제로 결제했다"는 증거다 — 무료로 열렸다면
 * passthrough 200이라 payment가 없다. 실패 시 무료 unlock으로 조용히 넘어가지 않는다
 * (그러면 "x402 실사용" 주장이 거짓이 된다). 재시도 1회 후 라운드를 error로 표면화한다.
 */
async function unlockViaX402(clientA, auctionId, state) {
  if (!SELLER_PUBLIC_URL) {
    throw new Error('X402_UNLOCK=1인데 SELLER_PUBLIC_URL이 없다 (cloudflared 터널 URL 필요)');
  }
  const url = `${SELLER_PUBLIC_URL}/slot/${auctionId}/result`;
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const r = await clientA.x402Fetch(url);
      if (!r.payment) throw new Error('데몬 응답에 payment 없음 — 402를 거치지 않았다');
      const body = JSON.parse(r.body);
      if (body.locked !== false) throw new Error(`결제 후에도 잠김: ${JSON.stringify(body)}`);
      return {
        amountBase: r.payment.amount,
        amountUsdc: Number(r.payment.amount) / 1e6,
        daemonTxId: r.payment.txId,
        payTo: r.payment.payTo,
        // 온체인 signature는 제출자(seller의 facilitator)만 안다. 데몬 txHash는 빈 값이다.
        onchainSignature: body.payment?.signature ?? null,
        resultHash: body.result?.hash ?? null,
        attempts: attempt,
      };
    } catch (e) {
      lastError = e;
      pushLog(state, `x402 unlock 시도 ${attempt} 실패: ${e.message}`);
    }
  }
  throw new Error(`x402 unlock 실패(2회): ${lastError.message}`);
}

/**
 * A의 예치가 온체인에 반영될 때까지 짧게 재시도한다.
 * reveal_bid의 온체인 요구사항(vault 잔고 >= reveal 금액)을 그대로 게이트로 쓴다.
 *
 * 확정되지 않아도 throw하지 않는다 — 조회가 늦었을 뿐 실제로는 반영됐을 수 있고,
 * 여기서 라운드를 죽이면 기존 동작보다 더 나빠진다. 판단은 reveal의 온체인 검증에 맡긴다.
 */
async function waitForVaultDeposit(conn, vault, txHash, minUiAmount, intervalMs = 500, tries = 10) {
  let status = 'unknown';
  let balance = null;
  for (let i = 0; i < tries; i++) {
    status = await confirmSig(conn, txHash);
    balance = await tokenUiBalance(conn, vault);
    const sigOk = status === 'confirmed' || status === 'finalized';
    if (sigOk && balance != null && balance >= minUiAmount) {
      return { confirmed: true, status, balance, waitedMs: i * intervalMs };
    }
    await sleep(intervalMs);
  }
  return { confirmed: false, status, balance, waitedMs: tries * intervalMs };
}

/**
 * 예치 결과를 데모 판정(UI)으로 매핑. A=NOTIFY지만 실행됨 → ALLOW.
 * 타임아웃은 DENY로 접지 않는다 — 정책이 거부한 것(C)과 관측하지 못한 것은 다른 사건이다.
 */
function classifyDeposit(fin) {
  if (TX_OK.includes(fin.status)) return 'ALLOW'; // A: NOTIFY 자동 실행
  if (fin.status === 'QUEUED' || fin.status === 'DELAYED' || fin.tier === 'APPROVAL') return 'APPROVAL_REQUIRED'; // B
  if (fin.timedOut) return 'TIMEOUT'; // 정지 상태에 도달하지 못함 = 정책 거부가 아니라 관측 실패
  return 'DENY'; // C: CANCELLED/POLICY_DENIED
}

/** receipt 조립(스펙 4 SettlementReceipt). state가 settled일 때만 유효. */
export function assembleReceipt(state) {
  if (state.phase !== 'settled') return null;
  const b = state.buyers;
  // A의 SPENDING_LIMIT 건당 위임 한도(instant_max) 대비 이번 라운드 지출. 오라클 없이 수량 티어로 판정된 값.
  const delegatedLimitUsdc = Number(TOKEN_LIMITS['buyer-a']?.instant_max ?? 0);
  const spentUsdc = b['buyer-a']?.bidUsdc ?? 0;
  return {
    auctionId: state.auctionId,
    item: state.item,
    winnerBuyerId: state.auctionState?.winnerIsA ? 'buyer-a' : null,
    bidAmountUsdc: b['buyer-a']?.bidUsdc ?? null,
    budget: {
      buyerId: 'buyer-a',
      delegatedLimitUsdc, // 건당 위임 한도(SPENDING_LIMIT instant_max)
      spentUsdc,
      remainingUsdc: Math.max(0, Number((delegatedLimitUsdc - spentUsdc).toFixed(2))),
    },
    commitTxSignatures: BUYERS.map((r) => ({ buyer: r, txHash: b[r]?.commit?.txHash || null })),
    depositDecisions: BUYERS.map((r) => ({
      buyer: r,
      decision: b[r]?.ui,
      status: b[r]?.deposit?.status,
      tier: b[r]?.deposit?.tier,
      txHash: b[r]?.deposit?.txHash || null,
      txId: b[r]?.deposit?.txId || null,
      inPending: b[r]?.deposit?.inPending ?? undefined,
      error: b[r]?.deposit?.error || null,
    })),
    createAuctionTx: state.steps.createAuction?.txHash || null,
    revealTx: state.steps.reveal?.txHash || null,
    settleTx: state.steps.settle?.txHash || null,
    addresses: state.addresses,
    onchainAuction: state.auctionState,
    settlement: state.result,
    resultHash: state.resultMeta?.hash || null,
    resultSource: state.resultMeta?.source || null,
    // x402 결제는 경매 예치와 별개 tx다. SPENDING_LIMIT의 수량 티어는 CAIP-19 키로만 잡히고
    // x402는 TRANSFER로 평가되므로 위 budget 수치에는 잡히지 않는다 — 별도 필드로 싣는다.
    x402: state.x402
      ? {
          amountUsdc: state.x402.amountUsdc,
          daemonTxId: state.x402.daemonTxId,
          onchainSignature: state.x402.onchainSignature,
          payTo: state.x402.payTo,
        }
      : null,
    startedAt: state.startedAt,
    settledAt: state.settledAt,
  };
}

export { BUYERS };

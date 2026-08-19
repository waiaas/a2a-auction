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
 *  ④ 화면 판정은 데몬이 내린 티어 이름(INSTANT·NOTIFY·DELAY·APPROVAL)을 그대로 쓴다
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
import {
  pickFreeAuctionId,
  waitForAuctionAccount,
  waitForTokenBalance,
  waitForVaultDeposit,
} from './lib/onchain-wait.js';
import { unlockViaX402 } from './lib/x402-unlock.js';

const BUYERS = ['buyer-a', 'buyer-b', 'buyer-c'];
const TX_OK = ['CONFIRMED', 'SUBMITTED'];
const actors = JSON.parse(fs.readFileSync(path.join(PATHS.fixtures, 'actors.json'), 'utf8'));

/** 오케스트레이터가 보관하는 초기 상태. */
export function initState() {
  return {
    phase: 'idle', // idle|open|committing|depositing|revealing|settling|settled|error
    auctionId: null,
    startedAt: null,
    openedAt: null, // 경매 개설 완료 시각(판매자 콘솔)
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


/**
 * 경매 개설까지만 실행한다 (판매자 콘솔의 "경매 오픈"). 입찰·정산은 runBidding이 이어받는다.
 * 반환한 ctx를 오케스트레이터가 보관했다가 그대로 넘긴다 — state에는 표시용 문자열만 싣는다.
 */
export async function openAuction(state, deps) {
  const { conn, config, clients } = deps;
  const marketplace = config.marketplace;
  const seller = config.seller;
  const mint = config.mint;
  const assetId = config.assetId;
  const sellerTokenAccount = config.sellerTokenAccount;

  state.startedAt = new Date().toISOString();
  state.phase = 'opening';

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
  pushLog(state, `auction_id=${auctionId} auctionPda=${auctionPda.toBase58()}`);

  // ---- Step 1: create_auction (marketplace) ----
  {
    const body = buildCreateAuction({ marketplace, seller, mint, auctionPda, vault, auctionId });
    const id = await clients['marketplace'].sendTx(body);
    const fin = await clients['marketplace'].pollTx(id, ['CONFIRMED', 'SUBMITTED', 'FAILED', 'CANCELLED']);
    const onchain = await confirmSig(conn, fin.txHash);
    state.steps.createAuction = { status: fin.status, txHash: fin.txHash || null, onchain };
    if (!TX_OK.includes(fin.status)) throw new Error(`create_auction 실패: ${JSON.stringify(fin)}`);
    pushLog(state, `create_auction ${fin.status} onchain=${onchain}`);
  }

  // 데몬의 SUBMITTED는 제출이지 확정이 아니다. auction 계정이 실제로 생길 때까지 짧게
  // 대기하지 않으면 갓 기동한 밸리데이터의 첫 라운드에서 commit_bid가 아직 없는 계정을
  // 참조해 AccountNotInitialized(3012)로 죽는다(5차 감사 — env-recover 직후 1/1 재현).
  // waitForVaultDeposit과 같은 원칙: 확정 실패로 라운드를 죽이지 않고 commit의 온체인
  // 검증에 판단을 맡긴다.
  {
    const wait = await waitForAuctionAccount(conn, auctionPda);
    pushLog(
      state,
      wait.found
        ? `auction 계정 확정 (${wait.waitedMs}ms 대기)`
        : `auction 계정 확인 대기 초과(${wait.waitedMs}ms) — commit은 그대로 시도`,
    );
  }

  state.openedAt = new Date().toISOString();
  state.phase = 'open';
  return { auctionId, auctionPda, vault, bidPda };
}

/**
 * 개설된 경매에 입찰~정산~결과물 unlock을 실행한다. ctx는 openAuction의 반환값이다.
 * 실패해도 되는 단계(B QUEUED, C DENIED)는 오류로 보지 않는다.
 */
export async function runBidding(state, deps, ctx) {
  const { conn, config, clients } = deps;
  const marketplace = config.marketplace;
  const mint = config.mint;
  const assetId = config.assetId;
  const sellerTokenAccount = config.sellerTokenAccount;
  const { auctionId, auctionPda, vault, bidPda } = ctx;

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
      ui: null, // INSTANT | NOTIFY | DELAY | APPROVAL | DENY | TIMEOUT
    };
  }

  // ---- Step 2: A·B WHITELIST에 이번 라운드 auction_pda 추가 (C는 그대로) ----
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
    state.buyers[role].ui = decision; // 데몬 티어 그대로 (또는 DENY·TIMEOUT)
    pushLog(state, `${role} deposit ${fin.status} tier=${fin.tier || '-'} → ${decision}`);
  }
  // B가 승인 대기 큐에 실제로 있는지 확인. 조회 실패는 "큐에 없음(false)"과 다른 사건이라
  // null로 남기고 라운드는 계속한다(pendingTxs가 이제 401 등에서 throw하므로).
  {
    const dep = state.buyers['buyer-b'].deposit;
    try {
      const ids = await clients['buyer-b'].pendingTxIds();
      dep.inPending = ids.includes(dep.txId);
    } catch (e) {
      dep.inPending = null;
      pushLog(state, `B 승인 큐 조회 실패: ${e.message}`);
    }
  }

  // A의 예치가 온체인에 실제로 반영될 때까지 대기한 뒤 reveal로 넘어간다.
  // 데몬은 tx를 제출하면 SUBMITTED를 반환하는데, reveal_bid는 vault 잔고가 reveal 금액
  // 이상일 것을 요구한다(DepositNotFound). 이 간극을 흡수하지 않으면 라운드 전체가 죽는다.
  const depA = state.buyers['buyer-a'].deposit;
  if (isExecutedDecision(depA.decision) || depA.decision === 'TIMEOUT') {
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
  // 정산 반영을 판정할 기준선. devnet은 settle이 confirmed여도 토큰 잔고 조회가 한 박자
  // 늦어 곧바로 읽으면 정산 전 값이 나온다(로컬 밸리데이터는 단일 노드라 즉시 보인다).
  const sellerBefore = await tokenUiBalance(conn, sellerTokenAccount);
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
  // 낙찰가만큼 늘어날 때까지 짧게 기다린다. 기다려도 안 늘면 읽힌 값을 그대로 쓴다 —
  // waitForVaultDeposit과 같은 원칙으로, 조회가 늦은 것을 정산 실패로 접지 않는다.
  const winningUsdc = state.buyers['buyer-a']?.bidUsdc ?? null;
  const expectedSeller =
    sellerBefore != null && winningUsdc != null ? sellerBefore + winningUsdc : null;
  const sellerUsdc = await waitForTokenBalance(conn, sellerTokenAccount, expectedSeller);
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
    state.x402 = await unlockViaX402(clients['buyer-a'], auctionId, (msg) => pushLog(state, msg));
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

/**
 * 개설과 입찰을 연속 실행한다(발표자 버튼 1개 경로). 판매자 콘솔을 거치지 않는 기존 흐름과
 * `verify-e2e.sh`가 이 함수를 쓴다.
 */
export async function runAuction(state, deps) {
  const ctx = await openAuction(state, deps);
  return runBidding(state, deps, ctx);
}


/**
 * 예치 결과를 화면 판정으로 매핑. **데몬이 내린 티어를 그대로 쓴다** —
 * 자체 용어(ALLOW 등)로 접으면 화면 라벨과 정책 엔진의 실제 판정이 어긋난다(콘티 v3 컷 4).
 *
 * 티어보다 먼저 걸러야 하는 것이 둘 있다. 관측 실패(timedOut)는 정책이 거부한 것과 다른
 * 사건이라 DENY로 접지 않고, 정책 거부는 애초에 티어가 매겨지지 않는다.
 */
function classifyDeposit(fin) {
  if (fin.timedOut) return 'TIMEOUT'; // 정지 상태 미도달 = 정책 거부가 아니라 관측 실패
  if (fin.status === 'POLICY_DENIED') return 'DENY';
  if (fin.tier) return fin.tier; // INSTANT | NOTIFY | DELAY | APPROVAL
  if (TX_OK.includes(fin.status)) return 'INSTANT';
  return 'DENY'; // 티어 없이 끝난 건(CANCELLED 등)
}

/**
 * 파이프라인을 통과해 실제로 실행된 판정인지. INSTANT와 NOTIFY만 통과하고
 * DELAY·APPROVAL은 대기 큐로 간다(`stage4-wait.ts:19`). **NOTIFY가 "알림은 가되 실행은
 * 통과"라는 점**이 이 데모에서 가장 미묘한 지점이라 판정 이름 나열 대신 함수로 고정한다.
 */
export function isExecutedDecision(decision) {
  return decision === 'INSTANT' || decision === 'NOTIFY' || decision === 'ALLOW';
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
      // null(관측 실패)을 undefined로 접으면 JSON에서 필드가 사라져 e2e가 원인을 구분 못 한다.
      inPending: b[r]?.deposit?.inPending,
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

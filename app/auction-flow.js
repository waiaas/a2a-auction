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
import { AMOUNTS, AUCTION_ITEM, PROGRAM_ID, PATHS, TOKEN_LIMITS } from './config.js';
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
    await clients[role].updatePolicy(wlId, { allowed_addresses: [PROGRAM_ID, auctionPda.toBase58()] });
  }
  pushLog(state, 'WHITELIST 갱신: A·B = [programId, auctionPda], C = [programId]');

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
  state.vaultAfterDeposit = await tokenUiBalance(conn, vault);
  pushLog(state, `vault after deposits = ${state.vaultAfterDeposit} USDC (A 예치만 기대)`);

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

  // 낙찰자에게 unlock되는 결과물 메타(내용은 seller 서비스가 게이트)
  const result = await getResult(AUCTION_ITEM);
  state.resultMeta = { hash: result.hash, source: result.source, unlockedFor: 'buyer-a' };

  // nextAuctionId 영속화(다음 라운드는 +1부터 스캔)
  const cfg = loadConfig();
  cfg.nextAuctionId = auctionId + 1;
  saveConfig(cfg);

  state.settledAt = new Date().toISOString();
  state.phase = 'settled';
  pushLog(state, `settled: seller=${sellerUsdc} vault=${vaultUsdc} winner=${state.auctionState?.winner}`);
  return state;
}

/** 예치 결과를 데모 판정(UI)으로 매핑. A=NOTIFY지만 실행됨 → ALLOW. */
function classifyDeposit(fin) {
  if (TX_OK.includes(fin.status)) return 'ALLOW'; // A: NOTIFY 자동 실행
  if (fin.status === 'QUEUED' || fin.status === 'DELAYED' || fin.tier === 'APPROVAL') return 'APPROVAL_REQUIRED'; // B
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
    startedAt: state.startedAt,
    settledAt: state.settledAt,
  };
}

export { BUYERS };

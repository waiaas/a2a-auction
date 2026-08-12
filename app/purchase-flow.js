/**
 * 구매 라운드 (콘티 v3). 바이어 1명이 크기가 다른 일 3건을 맡기고, 에이전트가 각각
 * 공급자를 골라 사되, 금액에 따라 정책이 다르게 반응한다.
 *
 * 흐름: 요청 3건 → 리스팅 선택(컷 3) → 구매 3건(컷 4) → 승인(컷 5) → 정산(컷 6)
 *
 * **구매 1건 = 참가자 1명인 경매 1개다**(콘티 §5). 프로그램에 최소 입찰자 수·마감 시각·
 * 라운드 제약이 하나도 없어 commit 1회 → 예치 → reveal 1회 → settle이 그대로 통과하고,
 * 이 경로는 `onchain/tests/happy_path.rs`로 이미 검증돼 있다. 그래서 온체인 프로그램을
 * 건드리지 않는다.
 *
 * 티어가 갈리는 지점은 **예치(TOKEN_TRANSFER) 한 곳뿐**이다. commit은 CONTRACT_CALL이라
 * token_limits가 걸리지 않는다(`spending-limit.ts` evaluateTokenTier가 CONTRACT_CALL을
 * 건너뛴다). 이 분리가 데모 전체를 지탱한다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PROGRAM_ID, PATHS, TOKEN_LIMITS, DELAY_SECONDS, MAIN_BUYER } from './config.js';
import {
  deriveAuctionPda,
  deriveVault,
  deriveBidPda,
  commitHash,
  confirmSig,
  signEd25519,
} from './lib/solana.js';
import { buildCreateAuction, buildCommitBid, buildDeposit } from './lib/instructions.js';
import { pickFreeAuctionId, waitForAuctionAccount } from './lib/onchain-wait.js';
import { loadListings, loadRequests, chooseListing } from './lib/decision.js';
import { saveConfig, loadOwnerKeypair } from './lib/state.js';

/** 이 시나리오의 주인공 바이어. owner가 verified라 APPROVAL이 실제로 큐에 걸린다. */
export const BUYER = MAIN_BUYER;

const TX_OK = ['CONFIRMED', 'SUBMITTED'];
const DEPOSIT_STOP = ['CONFIRMED', 'SUBMITTED', 'QUEUED', 'DELAYED', 'CANCELLED', 'FAILED', 'POLICY_DENIED'];

const actors = JSON.parse(fs.readFileSync(path.join(PATHS.fixtures, 'actors.json'), 'utf8'));

const usdcToBase = (usdc) => BigInt(Math.round(usdc * 1e6));

/** 오케스트레이터가 보관하는 초기 상태. */
export function initPurchaseState() {
  return {
    mode: 'purchase',
    phase: 'idle', // idle | choosing | purchasing | awaiting | settling | settled | error
    startedAt: null,
    buyer: {
      role: BUYER,
      name: actors[BUYER]?.name ?? BUYER,
      emoji: actors[BUYER]?.emoji ?? '',
      // 화면이 "정책은 한 줄"이라고 말하려면 그 한 줄이 어디서 온 값인지 분명해야 한다.
      policy: {
        notifyMaxUsdc: Number(TOKEN_LIMITS[BUYER].notify_max),
        delayMaxUsdc: Number(TOKEN_LIMITS[BUYER].delay_max),
        delaySeconds: DELAY_SECONDS,
      },
    },
    listings: [],
    purchases: [],
    log: [],
    error: null,
  };
}

function pushLog(state, msg) {
  state.log.push(msg);
  console.log(`  [purchase] ${msg}`);
}

/**
 * 예치 결과를 화면 판정으로 매핑. 데몬이 내린 티어를 그대로 쓴다.
 * 관측 실패(timedOut)와 정책 거부는 티어보다 먼저 걸러야 한다 — 서로 다른 사건이다.
 */
function classifyDeposit(fin) {
  if (fin.timedOut) return 'TIMEOUT';
  if (fin.status === 'POLICY_DENIED') return 'DENY';
  if (fin.tier) return fin.tier;
  if (TX_OK.includes(fin.status)) return 'INSTANT';
  return 'DENY';
}

/** 대기 큐에 걸린 판정인지(= 사람 또는 시간이 개입해야 진행된다). */
export function isQueuedDecision(decision) {
  return decision === 'DELAY' || decision === 'APPROVAL';
}

/**
 * 컷 3: 요청마다 카탈로그에서 공급자를 고른다.
 *
 * 선택을 먼저 전부 끝내고 구매로 넘어간다. 화면에서 "고르는 장면"과 "사는 장면"이 섞이면
 * 자율성(무엇을 쓸지 에이전트가 정한다)과 정책(얼마까지 허용되나)이 한 덩어리로 보인다.
 */
async function chooseAll(state, deps) {
  const { config } = deps;
  state.phase = 'choosing';
  const listings = loadListings();
  const requests = loadRequests();
  state.listings = listings;

  for (const request of requests) {
    const { listing, reason, rejected, source } = await chooseListing(request, listings);
    state.purchases.push({
      requestId: request.id,
      title: request.title,
      need: request.need,
      size: request.size,
      listing: {
        id: listing.id,
        title: listing.title,
        priceUsdc: listing.priceUsdc,
        sellerName: listing.seller.name,
        sellerEmoji: listing.seller.emoji,
        deliverable: listing.deliverable,
      },
      decision: { reason, rejected, source },
      amountUsdc: listing.priceUsdc,
      sellerAddress: config.seller,
      auctionId: null,
      addresses: null,
      steps: { createAuction: null, commit: null, deposit: null, reveal: null, settle: null },
      tier: null,
      ui: null,
      txId: null,
    });
    pushLog(state, `선택 ${request.id} → ${listing.id} (${listing.priceUsdc} USDC, ${source})`);
  }
}

/**
 * 구매 건마다 경매를 열고 주소를 유도한다. auction_id는 온체인에서 빈 슬롯을 찾아 쓰므로
 * 세 건이 서로 다른 경매를 갖고, bid PDA도 자연히 갈린다(같은 바이어라도 충돌하지 않는다).
 */
async function openAuctionFor(state, deps, purchase) {
  const { conn, config, clients } = deps;
  const marketplace = config.marketplace;

  const auctionId = await pickFreeAuctionId(conn, marketplace, config.nextAuctionId);
  const auctionPda = deriveAuctionPda(marketplace, auctionId);
  const vault = deriveVault(config.mint, auctionPda);
  const bidPda = deriveBidPda(auctionPda, config.addresses[BUYER]);

  purchase.auctionId = auctionId;
  purchase.addresses = {
    auctionPda: auctionPda.toBase58(),
    vault: vault.toBase58(),
    bidPda: bidPda.toBase58(),
  };

  const body = buildCreateAuction({
    marketplace,
    seller: config.seller,
    mint: config.mint,
    auctionPda,
    vault,
    auctionId,
  });
  const id = await clients['marketplace'].sendTx(body);
  const fin = await clients['marketplace'].pollTx(id, ['CONFIRMED', 'SUBMITTED', 'FAILED', 'CANCELLED']);
  const onchain = await confirmSig(conn, fin.txHash);
  purchase.steps.createAuction = { status: fin.status, txHash: fin.txHash || null, onchain };
  if (!TX_OK.includes(fin.status)) throw new Error(`create_auction 실패(${purchase.requestId}): ${JSON.stringify(fin)}`);

  // 제출은 확정이 아니다. 계정이 실제로 생기기 전에 commit이 들어가면 AccountNotInitialized로 죽는다.
  const wait = await waitForAuctionAccount(conn, auctionPda);
  pushLog(
    state,
    `경매 #${auctionId} 개설 (${purchase.listing.id})${wait.found ? '' : ` — 계정 확인 대기 초과(${wait.waitedMs}ms), commit은 그대로 시도`}`,
  );

  // 다음 라운드가 같은 슬롯을 다시 스캔하지 않도록 진행분을 기록한다.
  config.nextAuctionId = auctionId + 1;
  saveConfig(config);

  return { auctionId, auctionPda, vault, bidPda };
}

/**
 * WHITELIST를 이번 라운드 수신처로 갱신한다.
 *
 * **PUT이 전체를 덮어쓰므로 세 건의 auction_pda를 한 번에 넣어야 한다.** 구매마다 따로
 * 갱신하면 직전 건의 vault 수신처가 지워져 나중 예치가 POLICY_DENIED로 막힌다.
 * seller는 정산 후 결과물 unlock의 x402 결제(payTo=seller)를 위해 함께 연다.
 */
async function updateWhitelist(state, deps, pdas) {
  const { config, clients } = deps;
  const allowed = [PROGRAM_ID, ...pdas, config.seller];
  await clients[BUYER].updatePolicy(config.policies[BUYER].whitelist, { allowed_addresses: allowed });
  pushLog(state, `WHITELIST 갱신: programId + auction_pda ${pdas.length}건 + seller`);
}

/**
 * 컷 4: 세 건을 같은 정책에 통과시킨다. 금액만 다르고 나머지는 같다.
 *
 * 예치는 정지 상태(확정·큐 등재·거부)까지만 관측한다. DELAY는 유예가 끝나면 스스로 실행되고
 * APPROVAL은 사람이 승인해야 하므로, 여기서 끝까지 기다리면 발표가 멈춘다.
 */
async function purchaseAll(state, deps) {
  const { conn, config, clients } = deps;
  state.phase = 'purchasing';

  const ctxs = [];
  for (const purchase of state.purchases) {
    ctxs.push(await openAuctionFor(state, deps, purchase));
  }
  await updateWhitelist(state, deps, ctxs.map((c) => c.auctionPda.toBase58()));

  for (const [i, purchase] of state.purchases.entries()) {
    const { auctionId, auctionPda, bidPda } = ctxs[i];
    const amount = usdcToBase(purchase.amountUsdc);

    // commit: CONTRACT_CALL이라 금액 티어가 걸리지 않는다. 세 건 모두 통과해야 정상이다.
    {
      const body = buildCommitBid({
        bidder: config.addresses[BUYER],
        auctionPda,
        bidPda,
        commitHash: commitHash(amount, BUYER, auctionId),
      });
      const id = await clients[BUYER].sendTx(body);
      const fin = await clients[BUYER].pollTx(id, ['CONFIRMED', 'SUBMITTED', 'FAILED', 'CANCELLED']);
      const onchain = await confirmSig(conn, fin.txHash);
      purchase.steps.commit = { status: fin.status, txHash: fin.txHash || null, onchain };
      if (!TX_OK.includes(fin.status)) throw new Error(`commit 실패(${purchase.requestId}): ${JSON.stringify(fin)}`);
    }

    // 예치: 여기서 티어가 갈린다.
    {
      const body = buildDeposit({ auctionPda, amount, mint: config.mint, assetId: config.assetId });
      const id = await clients[BUYER].sendTx(body);
      const fin = await clients[BUYER].pollTx(id, DEPOSIT_STOP, 25000);
      const onchain = await confirmSig(conn, fin.txHash);
      const decision = classifyDeposit(fin);
      purchase.txId = id;
      purchase.tier = fin.tier || null;
      purchase.ui = decision;
      purchase.steps.deposit = {
        txId: id,
        status: fin.status,
        tier: fin.tier || null,
        txHash: fin.txHash || null,
        onchain,
        error: fin.error || fin.errorMessage || null,
      };
      pushLog(
        state,
        `구매 ${purchase.listing.id} ${purchase.amountUsdc} USDC → ${decision} (${fin.status})`,
      );
    }
  }

  // 대기 건이 남았는지에 따라 다음 장면이 갈린다(승인·유예가 있으면 컷 5로).
  state.phase = state.purchases.some((p) => isQueuedDecision(p.ui)) ? 'awaiting' : 'settling';
}

/**
 * 컷 5: 승인 대기 건을 사람이 승인한다. 스토리의 정점.
 *
 * **owner 서명이 유일한 경로다** — 거부와 달리 어드민 우회가 없어서, 지금은 시드가 보존한
 * owner 키로 서명한다. 익스텐션 승인 경로가 준비되면 서명만 지갑에서 받아 그대로 이 자리에
 * 끼우면 된다(콘티 §6의 "웹이 서명받고 오케스트레이터가 중계"와 같은 모양).
 *
 * @param {string} requestId - 승인할 구매 건
 */
export async function approvePurchase(state, deps, requestId) {
  const { clients } = deps;
  const purchase = state.purchases.find((p) => p.requestId === requestId);
  if (!purchase) throw new Error(`구매 건을 찾을 수 없다: ${requestId}`);
  if (purchase.ui !== 'APPROVAL') throw new Error(`승인 대상이 아니다: ${requestId} (${purchase.ui})`);
  if (!purchase.txId) throw new Error(`승인할 tx가 없다: ${requestId}`);

  const kp = loadOwnerKeypair();
  const ownerAddress = kp.publicKey.toBase58();
  // 승인 메시지는 즉시 소비되고 재현이 필요 없다. tx를 특정하고 유일성만 확보한다.
  const message = `approve-tx:${purchase.txId}:${Date.now()}`;
  const signature = signEd25519(kp.secretKey, message).toString('base64');

  await clients[BUYER].approveTx(purchase.txId, ownerAddress, message, signature);
  pushLog(state, `승인 ${purchase.listing.id} ${purchase.amountUsdc} USDC (owner 서명)`);

  // 승인은 큐에서 풀어줄 뿐이고 실행은 파이프라인이 이어서 한다 — 정지 상태까지 따라간다.
  const fin = await clients[BUYER].pollTx(purchase.txId, ['CONFIRMED', 'SUBMITTED', 'FAILED', 'CANCELLED'], 30000);
  purchase.steps.deposit = {
    ...purchase.steps.deposit,
    status: fin.status,
    txHash: fin.txHash || purchase.steps.deposit?.txHash || null,
    onchain: await confirmSig(deps.conn, fin.txHash),
    approvedAt: new Date().toISOString(),
  };
  purchase.ui = TX_OK.includes(fin.status) ? 'APPROVED' : classifyDeposit(fin);
  pushLog(state, `승인 후 실행 ${purchase.listing.id} → ${fin.status}`);

  if (!state.purchases.some((p) => isQueuedDecision(p.ui))) state.phase = 'settling';
  return purchase;
}

/**
 * 구매 라운드 실행 (컷 3 → 컷 4).
 * 정산(컷 6)은 승인·유예가 풀린 뒤라 별도 호출로 분리한다.
 */
export async function runPurchaseRound(state, deps) {
  state.startedAt = new Date().toISOString();
  await chooseAll(state, deps);
  await purchaseAll(state, deps);
  pushLog(
    state,
    `라운드 판정: ${state.purchases.map((p) => `${p.amountUsdc}→${p.ui}`).join(' / ')}`,
  );
}

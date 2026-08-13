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
import { PROGRAM_ID, PATHS, TOKEN_LIMITS, DELAY_SECONDS, MAIN_BUYER, X402_UNLOCK } from './config.js';
import {
  deriveAuctionPda,
  deriveVault,
  deriveBidPda,
  commitHash,
  saltFor,
  confirmSig,
  signEd25519,
  tokenUiBalance,
  fetchAuction,
  PublicKey,
} from './lib/solana.js';
import {
  buildCreateAuction,
  buildCommitBid,
  buildDeposit,
  buildRevealBid,
  buildSettle,
} from './lib/instructions.js';
import {
  pickFreeAuctionId,
  waitForAuctionAccount,
  waitForVaultDeposit,
  waitForTokenBalance,
} from './lib/onchain-wait.js';
import { getResult } from './lib/gemini.js';
import { unlockViaX402 } from './lib/x402-unlock.js';
import { loadListings, loadRequests, chooseListing } from './lib/decision.js';
import { saveConfig, loadOwnerKeypair } from './lib/state.js';

/** 이 시나리오의 주인공 바이어. owner가 verified라 APPROVAL이 실제로 큐에 걸린다. */
export const BUYER = MAIN_BUYER;

const TX_OK = ['CONFIRMED', 'SUBMITTED'];
/** 더 기다려도 바뀌지 않는 종료 상태. 대기 큐에서 이 상태로 끝난 건은 결말로 확정한다. */
const TERMINAL_FAIL = ['CANCELLED', 'FAILED', 'EXPIRED', 'POLICY_DENIED', 'REJECTED'];
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
      // 결과물 생성(컷 7)이 쓰는 원문 과업. 리스팅이 아니라 요청이 과업의 원천이다.
      task: request.prompt,
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

  enforceDistinctTiers(state, listings);
}

/**
 * 세 선택이 서로 다른 가격대를 덮도록 강제한다.
 *
 * **컷 4는 컷 3의 출력에 얹혀 있다.** 모델이 두 요청에 같은 리스팅을 고르면 두 건이 같은
 * 티어로 접혀 "같은 정책, 세 가지 반응"이 그 자리에서 무너진다. 폴백은 모델이 실패했을
 * 때만 도는 장치라, 모델이 **성공적으로 쏠린 선택**을 한 경우는 잡지 못한다.
 *
 * 겹친 건만 요청에 적힌 폴백 리스팅으로 내리고, 그 사실을 화면 태그(source)와 로그에
 * 남긴다 — 조용히 바꾸면 화면이 "에이전트 판단"이라고 거짓을 말하게 된다.
 */
function enforceDistinctTiers(state, listings) {
  const seen = new Set();
  for (const purchase of state.purchases) {
    if (!seen.has(purchase.listing.id)) {
      seen.add(purchase.listing.id);
      continue;
    }
    const request = loadRequests().find((r) => r.id === purchase.requestId);
    const fallback = listings.find((l) => l.id === request?.expectedListingId);
    if (!fallback || seen.has(fallback.id)) continue;

    pushLog(
      state,
      `티어 중복 교정: ${purchase.requestId}의 선택 ${purchase.listing.id} → ${fallback.id} ` +
      `(세 건이 서로 다른 가격대를 덮어야 컷 4가 성립한다)`,
    );
    purchase.listing = {
      id: fallback.id,
      title: fallback.title,
      priceUsdc: fallback.priceUsdc,
      sellerName: fallback.seller.name,
      sellerEmoji: fallback.seller.emoji,
      deliverable: fallback.deliverable,
    };
    purchase.amountUsdc = fallback.priceUsdc;
    purchase.decision = {
      ...purchase.decision,
      source: 'fallback',
      reason:
        `다른 요청이 같은 리스팅을 선택해 중복을 피했다. 요청 크기 '${purchase.size}'에 맞는 ` +
        `${fallback.title}(${fallback.priceUsdc} USDC)로 조정했다.`,
    };
    seen.add(fallback.id);
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
 * 대기 중인 건의 현재 상태를 데몬에서 다시 읽는다.
 *
 * **유예(DELAY)는 시간이 지나면 스스로 실행된다.** 화면이 폴링하며 이 함수를 부르면
 * "기다렸더니 통과했다"가 관측된다 — 컷 4에서 가장 설명하기 어려운 티어가 스스로 증명되는
 * 지점이라, 판정을 한 번 찍고 끝내지 않고 갱신 경로를 둔다.
 */
export async function refreshPurchases(state, deps) {
  const { conn, clients } = deps;
  let changed = false;

  for (const purchase of state.purchases) {
    if (!isQueuedDecision(purchase.ui) || !purchase.txId) continue;
    const tx = await clients[BUYER].getTx(purchase.txId);

    // 종료 상태(거부·취소·실패)도 흡수해야 한다. 이걸 건너뛰면 그 건이 영원히 대기로 남아
    // phase가 awaiting에 갇히고, 화면은 이미 거부된 건에 "승인하기" 버튼을 계속 띄운다.
    if (TERMINAL_FAIL.includes(tx.status)) {
      purchase.ui = tx.status === 'POLICY_DENIED' ? 'DENY' : 'REJECTED';
      purchase.steps.deposit = { ...purchase.steps.deposit, status: tx.status };
      pushLog(state, `대기 종료 ${purchase.listing.id} → ${purchase.ui} (${tx.status})`);
      changed = true;
      continue;
    }
    if (!TX_OK.includes(tx.status)) continue;

    // 유예가 풀려 실행된 것과 사람이 승인해 실행된 것은 다른 사건이라 라벨을 나눈다.
    purchase.ui = purchase.tier === 'APPROVAL' ? 'APPROVED' : 'RELEASED';
    purchase.steps.deposit = {
      ...purchase.steps.deposit,
      status: tx.status,
      txHash: tx.txHash || purchase.steps.deposit?.txHash || null,
      onchain: await confirmSig(conn, tx.txHash),
    };
    pushLog(state, `대기 해제 ${purchase.listing.id} → ${purchase.ui} (${tx.status})`);
    changed = true;
  }

  if (changed && !state.purchases.some((p) => isQueuedDecision(p.ui))) state.phase = 'settling';
  return changed;
}

/** 정산 대상인지. 대기 중이거나 이미 정산됐거나 예치가 막힌 건은 제외한다. */
function isSettleable(purchase) {
  if (isQueuedDecision(purchase.ui)) return false;
  if (purchase.steps.settle) return false;
  return ['NOTIFY', 'INSTANT', 'APPROVED', 'RELEASED'].includes(purchase.ui);
}

/**
 * 구매 1건을 정산한다. reveal로 낙찰을 확정하고 settle로 vault → seller를 옮긴다.
 *
 * 참가자가 1명이라 reveal도 1회다. commit 때 쓴 salt와 금액이 그대로 맞아야 온체인
 * sha256 검증을 통과하므로, 커밋과 같은 인자로 유도한다.
 */
async function settleOne(state, deps, purchase) {
  const { conn, config, clients } = deps;
  const auctionPda = new PublicKey(purchase.addresses.auctionPda);
  const vault = new PublicKey(purchase.addresses.vault);
  const bidPda = new PublicKey(purchase.addresses.bidPda);
  const amount = usdcToBase(purchase.amountUsdc);

  // reveal은 vault 잔고가 금액 이상일 것을 요구한다(DepositNotFound). 제출과 확정 사이의
  // 간극을 흡수하지 않으면 정산 전체가 죽는다.
  //
  // 기본 5초로는 짧다 — 특히 DELAY 건은 유예가 막 풀려 SUBMITTED가 된 직후라 온체인
  // 반영이 덜 됐을 수 있다(감사 지적). 20초까지 기다리고, 그래도 안 되면 reveal은 시도하되
  // 아래 settle 가드가 최종 판단을 맡는다.
  const wait = await waitForVaultDeposit(conn, vault, purchase.steps.deposit?.txHash, purchase.amountUsdc, 500, 40);
  if (!wait.confirmed) {
    pushLog(state, `${purchase.listing.id} 예치 확정 대기 초과(${wait.waitedMs}ms) — reveal은 그대로 시도`);
  }

  // reveal은 한 번만 보낸다. 재시도로 다시 보내면 온체인이 AlreadyRevealed로 거부해
  // 정산이 영구히 막힌다(감사 지적). 이미 성공한 reveal이 있으면 건너뛴다.
  if (!purchase.steps.reveal || !TX_OK.includes(purchase.steps.reveal.status)) {
    const body = buildRevealBid({
      bidder: config.addresses[BUYER],
      auctionPda,
      bidPda,
      vault,
      amount,
      salt: saltFor(BUYER, purchase.auctionId),
    });
    const id = await clients[BUYER].sendTx(body);
    const fin = await clients[BUYER].pollTx(id, ['CONFIRMED', 'SUBMITTED', 'FAILED', 'CANCELLED']);
    const onchain = await confirmSig(conn, fin.txHash);
    purchase.steps.reveal = { status: fin.status, txHash: fin.txHash || null, onchain };
    if (!TX_OK.includes(fin.status)) throw new Error(`reveal 실패(${purchase.requestId}): ${JSON.stringify(fin)}`);
  }

  /**
   * **settle 직전 필수 가드 (콘티 §5).**
   *
   * `settle.rs:29-33`은 winner가 없어도 `status = Settled`를 먼저 쓰고, 전송만 건너뛴다.
   * 복구 명령이 없으므로 이 경우 **돈이 0원 이동한 채 경매가 영구히 잠긴다.** 데몬의
   * SUBMITTED는 브로드캐스트일 뿐 온체인 성공이 아니라서, reveal이 DepositNotFound 등으로
   * 실패해도 앞 단계는 통과할 수 있다. 그래서 데몬 응답이 아니라 **온체인 계정 상태**를
   * 게이트로 삼는다 — winner와 highest가 실제로 세팅된 뒤에만 settle을 보낸다.
   */
  const beforeSettle = await fetchAuction(conn, auctionPda);
  if (!beforeSettle) {
    throw new Error(`settle 중단(${purchase.requestId}): auction #${purchase.auctionId} 계정을 읽을 수 없다`);
  }
  if (beforeSettle.status === 'Settled') {
    throw new Error(`settle 중단(${purchase.requestId}): auction #${purchase.auctionId}가 이미 Settled다`);
  }
  if (!beforeSettle.winner || BigInt(beforeSettle.highest) === 0n) {
    throw new Error(
      `settle 중단(${purchase.requestId}): reveal이 온체인에 반영되지 않았다 ` +
      `(winner=${beforeSettle.winner ?? 'none'}, highest=${beforeSettle.highest}). ` +
      `이대로 settle하면 돈이 움직이지 않은 채 경매가 영구히 잠긴다.`,
    );
  }

  // 정산 반영 기준선. 잔고 조회가 한 박자 늦을 수 있어 before를 먼저 잡는다.
  const sellerBefore = await tokenUiBalance(conn, config.sellerTokenAccount);
  {
    const body = buildSettle({
      marketplace: config.marketplace,
      auctionPda,
      vault,
      sellerTokenAccount: config.sellerTokenAccount,
    });
    const id = await clients['marketplace'].sendTx(body);
    const fin = await clients['marketplace'].pollTx(id, ['CONFIRMED', 'SUBMITTED', 'FAILED', 'CANCELLED']);
    const onchain = await confirmSig(conn, fin.txHash);
    purchase.steps.settle = { status: fin.status, txHash: fin.txHash || null, onchain };
    if (!TX_OK.includes(fin.status)) throw new Error(`settle 실패(${purchase.requestId}): ${JSON.stringify(fin)}`);
  }

  const expected = sellerBefore != null ? sellerBefore + purchase.amountUsdc : null;
  const sellerUsdc = await waitForTokenBalance(conn, config.sellerTokenAccount, expected);
  const onchainAuction = await fetchAuction(conn, auctionPda);
  purchase.result = {
    sellerUsdc,
    vaultUsdc: await tokenUiBalance(conn, vault),
    auctionStatus: onchainAuction?.status ?? null,
    winnerIsBuyer: onchainAuction?.winner === config.addresses[BUYER],
  };
  pushLog(
    state,
    `정산 ${purchase.listing.id} ${purchase.amountUsdc} USDC → seller ${sellerUsdc} (auction #${purchase.auctionId} ${purchase.result.auctionStatus})`,
  );

  // 컷 7 전반부: 구매한 능력이 실행되어 결과물이 생긴다. 여기서 auctionId 캐시에 확정해
  // seller가 동일 hash를 재현한다(M2 원칙). 상품 메타(item)도 캐시에 실려 seller가
  // 리스팅 매핑을 몰라도 올바른 상품 정보를 내려준다.
  const result = await getResult(
    { title: purchase.listing.title, task: purchase.task, seller: purchase.listing.sellerName },
    purchase.auctionId,
  );
  purchase.resultMeta = { hash: result.hash, source: result.source };
  pushLog(state, `결과물 생성 ${purchase.listing.id} hash=${result.hash.slice(0, 12)}… (${result.source})`);
}

/**
 * 컷 7 후반부: 결과물 열람에 x402 마이크로페이먼트를 붙인다.
 *
 * 정산(온체인 Settled)이 seller의 시간 게이트라 반드시 정산 뒤에 온다. 실패해도 정산을
 * 되돌리지 않는다 — 결제 실패는 열람이 잠긴 것이지 구매가 무효가 된 것이 아니다.
 * unlockError를 남겨 두면 다음 settlePurchases 호출이 재시도한다.
 */
async function unlockOne(state, deps, purchase) {
  try {
    purchase.x402 = await unlockViaX402(deps.clients[BUYER], purchase.auctionId, (m) => pushLog(state, m));
    purchase.unlockError = null;
    pushLog(
      state,
      `x402 unlock ${purchase.listing.id}: ${purchase.x402.amountUsdc} USDC sig=${purchase.x402.onchainSignature}`,
    );
  } catch (e) {
    purchase.unlockError = e.message;
    pushLog(state, `x402 unlock 실패 ${purchase.listing.id}: ${e.message}`);
  }
}

/**
 * 컷 6: 실행이 끝난 건들을 온체인 정산한다.
 *
 * 대기 중인 건은 건너뛴다 — 승인이나 유예가 풀린 뒤 다시 부르면 그때 정산된다.
 * 한 건이 실패해도 나머지를 정산한다. 세 건은 서로 다른 경매라 서로를 막지 않는다.
 */
export async function settlePurchases(state, deps) {
  state.phase = 'settling';
  for (const purchase of state.purchases) {
    if (!isSettleable(purchase)) continue;
    try {
      await settleOne(state, deps, purchase);
    } catch (e) {
      purchase.settleError = e.message;
      pushLog(state, `정산 실패 ${purchase.listing.id}: ${e.message}`);
    }
  }

  // 컷 7: 정산된 건의 결과물을 x402로 연다. 첫 시도와 실패 재시도가 같은 조건이다
  // (settle 있음 + x402 없음). X402_UNLOCK이 꺼져 있으면 무료 열람 경로 그대로다(킬 스위치).
  if (X402_UNLOCK) {
    for (const purchase of state.purchases) {
      if (purchase.steps.settle && !purchase.x402) await unlockOne(state, deps, purchase);
    }
  }

  const done = state.purchases.filter((p) => p.steps.settle).length;
  const waiting = state.purchases.filter((p) => isQueuedDecision(p.ui)).length;
  state.phase = waiting ? 'awaiting' : 'settled';
  pushLog(state, `정산 ${done}/${state.purchases.length}건 완료${waiting ? ` (대기 ${waiting}건 남음)` : ''}`);
}

/**
 * 구매 라운드 실행 (컷 3 → 컷 4).
 * 정산(컷 6)은 승인·유예가 풀린 뒤라 별도 호출로 분리한다.
 */
export async function runPurchaseRound(state, deps) {
  state.startedAt = new Date().toISOString();

  // 지난 라운드의 대기 건을 먼저 걷어낸다. 남아 있으면 이번 라운드 판정이 전부 APPROVAL로
  // 무너진다(실측: 리허설 2회차에서 5·10·20이 모두 APPROVAL로 나왔다).
  const drained = await deps.clients[BUYER].drainPending();
  if (drained) pushLog(state, `지난 라운드 대기 ${drained}건 정리`);

  await chooseAll(state, deps);
  await purchaseAll(state, deps);
  pushLog(
    state,
    `라운드 판정: ${state.purchases.map((p) => `${p.amountUsdc}→${p.ui}`).join(' / ')}`,
  );
}

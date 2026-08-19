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
import { bumpNextAuctionId, loadOwnerKeypair } from './lib/state.js';

/** 이 시나리오의 주인공 바이어. owner가 verified라 APPROVAL이 실제로 큐에 걸린다. */
export const BUYER = MAIN_BUYER;

const TX_OK = ['CONFIRMED', 'SUBMITTED'];
/** 더 기다려도 바뀌지 않는 종료 상태. 대기 큐에서 이 상태로 끝난 건은 결말로 확정한다. */
const TERMINAL_FAIL = ['CANCELLED', 'FAILED', 'EXPIRED', 'POLICY_DENIED', 'REJECTED'];
const DEPOSIT_STOP = ['CONFIRMED', 'SUBMITTED', 'QUEUED', 'DELAYED', 'CANCELLED', 'FAILED', 'POLICY_DENIED'];

const actors = JSON.parse(fs.readFileSync(path.join(PATHS.fixtures, 'actors.json'), 'utf8'));

const usdcToBase = (usdc) => BigInt(Math.round(usdc * 1e6));

/**
 * 오케스트레이터가 보관하는 초기 상태.
 *
 * @param {object} [buyer] - 사용자별 라운드일 때 그 사용자의 표시 정보와 **실제 정책값**.
 *   생략하면 공용 주인공 바이어(구 경매 경로·verify 스크립트)로 채운다. 정책값을 주입받는
 *   이유는 사용자가 자기 한도를 바꾸기 때문이다 — config 상수를 그대로 쓰면 화면이 데몬에
 *   등록된 값과 다른 숫자를 말하게 된다.
 */
export function initPurchaseState(buyer) {
  return {
    mode: 'purchase',
    phase: 'idle', // idle | choosing | purchasing | awaiting | settling | settled | error
    startedAt: null,
    buyer: buyer ?? {
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
  // config 전체가 아니라 이 필드만 쓴다 — 사용자별 deps는 config 사본이라 통째로 저장하면
  // demo-config.json의 buyer-a 자리가 접속자 지갑으로 덮인다(`bumpNextAuctionId` 주석 참조).
  config.nextAuctionId = auctionId + 1;
  bumpNextAuctionId(auctionId + 1);

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
 * 구매 1건 실행: commit → deposit. **티어가 갈리는 지점은 예치 한 곳뿐이다.**
 * commit은 CONTRACT_CALL이라 token_limits가 걸리지 않는다(`spending-limit.ts`가 건너뛴다).
 *
 * 예치는 정지 상태(확정·큐 등재·거부)까지만 관측한다. DELAY는 유예가 끝나면 스스로 실행되고
 * APPROVAL은 사람이 승인해야 하므로, 여기서 끝까지 기다리면 발표가 멈춘다.
 */
async function executePurchase(state, deps, purchase, ctx) {
  const { conn, config, clients } = deps;
  const { auctionId, auctionPda, bidPda } = ctx;
  const amount = usdcToBase(purchase.amountUsdc);

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
    pushLog(state, `구매 ${purchase.listing.id} ${purchase.amountUsdc} USDC → ${decision} (${fin.status})`);
  }
  return purchase;
}

/**
 * 컷 4: 세 건을 같은 정책에 통과시킨다. 금액만 다르고 나머지는 같다.
 *
 * 예치는 정지 상태(확정·큐 등재·거부)까지만 관측한다. DELAY는 유예가 끝나면 스스로 실행되고
 * APPROVAL은 사람이 승인해야 하므로, 여기서 끝까지 기다리면 발표가 멈춘다.
 */
async function purchaseAll(state, deps) {
  state.phase = 'purchasing';

  const ctxs = [];
  for (const purchase of state.purchases) {
    ctxs.push(await openAuctionFor(state, deps, purchase));
  }
  await updateWhitelist(state, deps, ctxs.map((c) => c.auctionPda.toBase58()));

  for (const [i, purchase] of state.purchases.entries()) {
    await executePurchase(state, deps, purchase, ctxs[i]);
  }

  // 대기 건이 남았는지에 따라 다음 장면이 갈린다(승인·유예가 있으면 컷 5로).
  state.phase = state.purchases.some((p) => isQueuedDecision(p.ui)) ? 'awaiting' : 'settling';
}

/**
 * 단건 구매 (MCP `purchase_skill`이 쓰는 경로, 컷 2).
 *
 * 라운드가 요청 3건을 한꺼번에 도는 것과 달리, 여기서는 **이미 고른 리스팅 하나**를 산다.
 * 도구 호출자가 후보를 조회(`list_skills`)하고 스스로 골랐다는 전제라, 선택 단계를 건너뛴다.
 *
 * **정책 판정을 그대로 반환한다**(콘티 §8의 설계 핵심). 5달러는 즉시 성공, 10달러는 유예 중,
 * 20달러는 승인 대기가 도구 응답에 찍히면 별도 설명 없이 정책 엔진이 스스로를 증명한다.
 */
export async function purchaseOne(state, deps, { listingId, title, need, requestId }) {
  const listing = loadListings().find((l) => l.id === listingId);
  if (!listing) throw new Error(`카탈로그에 없는 리스팅이다: ${listingId}`);

  const purchase = newPurchase(state, deps, {
    // 호출자가 id를 미리 알아야 진행을 따라갈 수 있다(MCP는 비동기 응답 뒤 이 id로 폴링한다).
    requestId: requestId ?? `mcp-${listingId}-${state.purchases.length + 1}`,
    listing,
    title: title ?? listing.title,
    need: need ?? 'MCP 도구로 직접 구매',
    task: need ?? listing.summary,
    // 도구 호출자가 직접 고른 것이므로 에이전트 판단이 아니다. 화면이 이를 구분해 표시한다.
    decision: { reason: 'MCP 도구 호출자가 직접 지정한 리스팅이다.', rejected: null, source: 'direct' },
  });
  return runOnePurchase(state, deps, purchase);
}

/**
 * 사용자가 직접 쓴 요청 하나를 산다 (자유 요청 경로).
 *
 * **fixtures의 고정 3건과 이 경로의 차이가 "콘티 재생 장치"와 "서비스"를 가른다.** 요청이
 * 밖에서 들어오므로 어떤 리스팅이 뽑힐지 미리 알 수 없고, 그래서 판정도 미리 정해져 있지 않다.
 * 선택은 컷 3과 같은 `chooseListing`을 쓴다 — 화면이 "에이전트가 골랐다"고 말하려면 실제로
 * 같은 판단 경로여야 한다.
 *
 * @param {{title?:string, prompt:string, need?:string}} req - 사용자가 입력한 요청
 */
export async function purchaseFromRequest(state, deps, req) {
  const prompt = String(req.prompt || '').trim();
  if (!prompt) throw new Error('요청 내용이 비어 있다');

  const listings = loadListings();
  const request = {
    id: `req-${state.purchases.length + 1}`,
    title: req.title?.trim() || prompt.slice(0, 40),
    prompt,
    need: req.need?.trim() || '사용자가 직접 입력한 요청',
    size: 'medium', // 폴백 판정용 기본 깊이. 라이브가 성공하면 쓰이지 않는다
  };
  const { listing, reason, rejected, source } = await chooseListing(request, listings);

  const purchase = newPurchase(state, deps, {
    requestId: req.requestId ?? `user-${Date.now().toString(36)}-${state.purchases.length + 1}`,
    listing,
    title: request.title,
    need: request.need,
    task: request.prompt,
    size: listing.depth,
    decision: { reason, rejected, source },
  });
  pushLog(state, `선택 ${request.id} → ${listing.id} (${listing.priceUsdc} USDC, ${source})`);
  return runOnePurchase(state, deps, purchase);
}

/** 구매 1건의 초기 객체. 라운드 경로와 단건 경로가 같은 모양을 쓰도록 한곳에서 만든다. */
function newPurchase(state, deps, { requestId, listing, title, need, task, size, decision }) {
  if (!state.startedAt) state.startedAt = new Date().toISOString();
  if (!state.listings.length) state.listings = loadListings();

  const purchase = {
    requestId,
    title,
    need,
    size: size ?? listing.depth,
    task,
    listing: {
      id: listing.id,
      title: listing.title,
      priceUsdc: listing.priceUsdc,
      sellerName: listing.seller.name,
      sellerEmoji: listing.seller.emoji,
      deliverable: listing.deliverable,
    },
    decision,
    amountUsdc: listing.priceUsdc,
    sellerAddress: deps.config.seller,
    auctionId: null,
    addresses: null,
    steps: { createAuction: null, commit: null, deposit: null, reveal: null, settle: null },
    tier: null,
    ui: null,
    txId: null,
  };
  state.purchases.push(purchase);
  return purchase;
}

/** 단건 구매의 온체인·정책 경로. 라운드와 달리 이미 쌓인 구매가 있는 상태에서 돈다. */
async function runOnePurchase(state, deps, purchase) {
  const ctx = await openAuctionFor(state, deps, purchase);
  // WHITELIST는 PUT이 전체를 덮어쓰므로 지금까지의 모든 auction_pda를 함께 넣어야 한다.
  // 하나만 넣으면 앞서 산 건의 수신처가 지워져 그 건의 정산이 막힌다.
  const pdas = state.purchases.filter((p) => p.addresses).map((p) => p.addresses.auctionPda);
  await updateWhitelist(state, deps, pdas);
  await executePurchase(state, deps, purchase, ctx);

  state.phase = state.purchases.some((p) => isQueuedDecision(p.ui)) ? 'awaiting' : 'settling';
  return purchase;
}

/**
 * 컷 5: 승인 대기 건을 사람이 승인한다. 스토리의 정점.
 *
 * **owner 서명이 유일한 경로다** — 거부와 달리 어드민 우회가 없다.
 *
 * 서명 주체는 두 가지다. 사용자별 에이전트 지갑은 오너가 **접속자의 지갑 주소**라 서버가
 * 대신 서명할 수 없고(키가 없다), 반드시 브라우저에서 받은 서명을 그대로 중계해야 한다.
 * 공용 주인공 지갑(구 경매 경로·verify 스크립트)만 시드가 보존한 owner 키로 서명한다.
 *
 * @param {string} requestId - 승인할 구매 건
 * @param {{address:string, message:string, signature:string}} [ownerSig] - 지갑에서 받은 서명.
 *   주면 그대로 중계하고, 없으면 서버 보관 키로 서명한다.
 */
export async function approvePurchase(state, deps, requestId, ownerSig = null) {
  const { clients } = deps;
  const purchase = state.purchases.find((p) => p.requestId === requestId);
  if (!purchase) throw new Error(`구매 건을 찾을 수 없다: ${requestId}`);
  if (purchase.ui !== 'APPROVAL') throw new Error(`승인 대상이 아니다: ${requestId} (${purchase.ui})`);
  if (!purchase.txId) throw new Error(`승인할 tx가 없다: ${requestId}`);

  let ownerAddress, message, signature;
  if (ownerSig) {
    ({ address: ownerAddress, message, signature } = ownerSig);
  } else {
    const kp = loadOwnerKeypair();
    ownerAddress = kp.publicKey.toBase58();
    // 승인 메시지는 즉시 소비되고 재현이 필요 없다. tx를 특정하고 유일성만 확보한다.
    message = `approve-tx:${purchase.txId}:${Date.now()}`;
    signature = signEd25519(kp.secretKey, message).toString('base64');
  }

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
 * 대기 건을 거둔다. **승인만 있고 거부가 없으면 대기 큐가 영원히 쌓인다** — 남은 대기 건은
 * 이후 판정을 전부 APPROVAL로 밀어올려 정책 대조가 조용히 무너진다(실측된 함정).
 *
 * DELAY와 APPROVAL은 큐가 달라 경로가 갈린다. DELAY는 유예 취소(세션 권한), APPROVAL은
 * 오너 서명 거부다 — 맡긴 사람이 거두는 것이 위임 모델과 맞는다.
 *
 * @param {{address:string, message:string, signature:string}} [ownerSig] - APPROVAL 건에 필요
 */
export async function cancelPurchase(state, deps, requestId, ownerSig = null) {
  const purchase = state.purchases.find((p) => p.requestId === requestId);
  if (!purchase) throw new Error(`구매 건을 찾을 수 없다: ${requestId}`);
  if (!isQueuedDecision(purchase.ui)) throw new Error(`대기 중인 건이 아니다: ${requestId} (${purchase.ui})`);

  const client = deps.clients[BUYER];
  if (purchase.ui === 'DELAY') {
    await client.cancelDelayedTx(purchase.txId);
  } else {
    if (!ownerSig) throw new Error('승인 대기 건을 거부하려면 오너 서명이 필요하다');
    await client.rejectTxAsOwner(purchase.txId, ownerSig.address, ownerSig.message, ownerSig.signature);
  }

  purchase.ui = 'REJECTED';
  purchase.steps.deposit = { ...purchase.steps.deposit, status: 'CANCELLED', rejectedAt: new Date().toISOString() };
  pushLog(state, `대기 취소 ${purchase.listing.id} ${purchase.amountUsdc} USDC`);
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
    // before를 함께 남긴다. "정산 완료"라는 라벨보다 **숫자가 실제로 움직인 것**이
    // 훨씬 강한 증거이고, 그 대조는 before 없이는 화면에서 만들 수 없다.
    sellerBefore,
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
    {
      title: purchase.listing.title,
      task: purchase.task,
      seller: purchase.listing.sellerName,
      // 라이브는 이 힌트로 분량을 가르고, 실패하면 리스팅별 폴백 원고로 내려간다.
      // 어느 경로든 세 건의 결과물이 서로 달라야 가격 차이가 설명된다.
      depthHint: `${purchase.listing.deliverable.format}, 약 ${purchase.listing.deliverable.approxWords}자, 출처 ${purchase.listing.deliverable.sourceCount}건 수준`,
      fallbackFile: `result-${purchase.listing.id}.md`,
    },
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
 * 판정이 어떻게 끝났는지를 한 단어로. 티어는 "무엇으로 판정됐나"이고 이건 "그래서 어떻게
 * 됐나"라서 층이 다르다 — 컷 8은 둘을 나란히 놓아야 "판단과 정산이 기록으로 남는다"가 된다.
 */
function outcomeOf(purchase) {
  if (purchase.ui === 'DENY') return 'denied';
  if (purchase.ui === 'REJECTED') return 'rejected';
  if (isQueuedDecision(purchase.ui)) return 'waiting';
  if (purchase.steps.settle) return 'settled';
  if (purchase.settleError) return 'settle_failed';
  return 'executed';
}

/**
 * 컷 8: 세 건의 판정 기록을 하나의 증거 체인으로 조립한다.
 *
 * **화면이 주장하는 모든 수치에 온체인·데몬 근거를 붙인다.** 티어는 데몬이 내린 값,
 * 결말은 온체인 상태, 금액은 정산 후 실제 잔고다. 진행 중에도 조립되므로(정산 전 호출 가능)
 * 발표 중 아무 때나 열어도 그 시점까지의 기록이 나온다.
 */
export function assemblePurchaseReceipt(state) {
  if (!state.purchases.length) return null;

  // 정책은 상태에 실린 값을 쓴다. 사용자가 자기 한도를 바꾸면 영수증도 그 값을 말해야 한다
  // (config 상수를 읽으면 화면과 영수증이 서로 다른 숫자를 말한다).
  const policy = state.buyer.policy;
  const purchases = state.purchases.map((p) => ({
    requestId: p.requestId,
    request: { title: p.title, need: p.need, size: p.size },
    listing: { id: p.listing.id, title: p.listing.title, seller: p.listing.sellerName },
    amountUsdc: p.amountUsdc,
    // 무엇을 왜 골랐나(컷 3) — 라이브 판단과 폴백 규칙을 구분해 싣는다.
    decision: { reason: p.decision.reason, rejected: p.decision.rejected, source: p.decision.source },
    // 어떤 티어로 판정됐나(컷 4)
    tier: p.tier,
    verdict: p.ui,
    // 그래서 어떻게 끝났나(컷 5·6)
    outcome: outcomeOf(p),
    auctionId: p.auctionId,
    addresses: p.addresses,
    tx: {
      createAuction: p.steps.createAuction?.txHash ?? null,
      commit: p.steps.commit?.txHash ?? null,
      deposit: p.steps.deposit?.txHash ?? null,
      reveal: p.steps.reveal?.txHash ?? null,
      settle: p.steps.settle?.txHash ?? null,
    },
    approvedAt: p.steps.deposit?.approvedAt ?? null,
    onchain: p.result
      ? {
          auctionStatus: p.result.auctionStatus,
          winnerIsBuyer: p.result.winnerIsBuyer,
          sellerBefore: p.result.sellerBefore ?? null,
          sellerUsdc: p.result.sellerUsdc,
        }
      : null,
    // 결과물(컷 7). hash는 seller가 같은 값을 재현하므로 열람본과 대조할 수 있다.
    result: p.resultMeta ? { hash: p.resultMeta.hash, source: p.resultMeta.source } : null,
    // x402는 구매 대금과 별개 tx다. SPENDING_LIMIT 수량 티어는 CAIP-19 키로만 잡히고
    // x402는 TRANSFER로 평가되므로 아래 합계에 섞지 않고 따로 싣는다.
    x402: p.x402
      ? {
          amountUsdc: p.x402.amountUsdc,
          daemonTxId: p.x402.daemonTxId,
          onchainSignature: p.x402.onchainSignature,
          payTo: p.x402.payTo,
        }
      : null,
    error: p.settleError ?? p.unlockError ?? p.steps.deposit?.error ?? null,
  }));

  const settled = purchases.filter((p) => p.outcome === 'settled');
  const round2 = (n) => Number(n.toFixed(2));

  return {
    mode: 'purchase',
    buyer: state.buyer,
    // 이 데모의 설계도 한 줄. 화면 문구가 아니라 데몬에 실제로 등록된 값에서 온다.
    policy: {
      ...policy,
      note:
        `${policy.notifyMaxUsdc} USDC까지 알림, ${policy.delayMaxUsdc} USDC까지 유예 ` +
        `${policy.delaySeconds}초, 초과는 사람 승인`,
    },
    purchases,
    totals: {
      requested: purchases.length,
      settled: settled.length,
      // 실제로 나간 돈만 센다. 대기·거부 건을 합계에 넣으면 영수증이 거짓을 말한다.
      spentUsdc: round2(settled.reduce((s, p) => s + p.amountUsdc, 0)),
      x402Usdc: round2(purchases.reduce((s, p) => s + (p.x402?.amountUsdc ?? 0), 0)),
      sellerUsdc: settled.length ? settled[settled.length - 1].onchain?.sellerUsdc ?? null : null,
    },
    tierBreakdown: purchases.map((p) => ({ amountUsdc: p.amountUsdc, tier: p.tier, verdict: p.verdict, outcome: p.outcome })),
    phase: state.phase,
    startedAt: state.startedAt,
  };
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

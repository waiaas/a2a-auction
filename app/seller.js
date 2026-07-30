/**
 * Seller 결과 서비스 (스펙 3.3·5.2). 온체인 낙찰·정산을 직접 확인한 뒤에만 결과물을 내준다.
 * 오케스트레이터 상태를 믿지 않고 체인을 읽는다 — 게이트는 온체인 Settled·winner뿐이다.
 *
 *   GET /slot/:auctionId/result
 *     - 온체인 auction이 Settled + winner 존재 → 200 + ServiceResult
 *     - 미정산/미존재 → 403 + 상태 안내
 *
 * 주의: 호출자 신원 검증은 없다(요청에 신원이 실리지도 않는다). 여기 구현된 것은
 * "정산 전에는 아무도 못 본다"는 시간 게이트이고, 정산 후에는 요청자를 가리지 않는다.
 * 낙찰자 서명(nonce 챌린지) 요구는 README 하드닝 로드맵.
 *
 * 실행: node seller.js   ← localnet 조회가 있어 Bash는 dangerouslyDisableSandbox 필요
 */
import express from 'express';
import {
  SELLER_PORT,
  AUCTION_ITEM,
  X402_UNLOCK,
  X402_AMOUNT_BASE,
  SELLER_PUBLIC_URL,
  USDC_DECIMALS,
} from './config.js';
import { connection, deriveAuctionPda, fetchAuction } from './lib/solana.js';
import { loadConfig } from './lib/state.js';
import { getResult } from './lib/gemini.js';
import {
  buildPaymentRequired,
  decodePaymentPayload,
  loadFacilitator,
  settlePayment,
  readPaymentMarker,
  writePaymentMarker,
} from './lib/x402-gate.js';

const app = express();
app.use(express.json());

// X402_UNLOCK일 때만 facilitator 키가 필요하다. 없으면 라운드 중간에 실패하는 대신 기동 때 죽는다.
const facilitator = X402_UNLOCK ? loadFacilitator() : null;

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.get('/slot/:auctionId/result', async (req, res) => {
  const auctionId = Number(req.params.auctionId);
  if (!Number.isInteger(auctionId) || auctionId < 0) {
    return res.status(400).json({ error: 'bad_auction_id' });
  }

  const config = loadConfig();
  if (!config) return res.status(503).json({ error: 'not_seeded' });

  const conn = connection();
  const auctionPda = deriveAuctionPda(config.marketplace, auctionId);

  // RPC I/O는 시스템 경계 — 일시적 실패(밸리데이터 블립)가 프로세스를 죽이지 않게 여기서 잡는다.
  let auction;
  try {
    auction = await fetchAuction(conn, auctionPda);
  } catch (e) {
    console.error(`[seller] RPC 조회 실패 auction=${auctionId}: ${e.message}`);
    return res.status(503).json({ error: 'rpc_unavailable', auctionId });
  }

  if (!auction) {
    return res.status(403).json({
      locked: true,
      reason: 'auction_not_found',
      auctionId,
      auctionPda: auctionPda.toBase58(),
    });
  }
  if (auction.status !== 'Settled' || !auction.winner) {
    return res.status(403).json({
      locked: true,
      reason: 'not_settled',
      status: auction.status,
      auctionId,
    });
  }

  // ---- x402 결제 게이트 (X402_UNLOCK) ----
  // 온체인 정산 게이트를 통과한 뒤에만 발동한다. 순서: 403 not_settled → 402 → 200.
  // 결제 완료는 마커로 영속하므로 UI 재조회·verify-e2e 재호출이 재결제를 유발하지 않는다.
  let payment = X402_UNLOCK ? readPaymentMarker(auctionId) : null;
  if (X402_UNLOCK && !payment) {
    const requirement = {
      resourceUrl: `${SELLER_PUBLIC_URL || `http://127.0.0.1:${SELLER_PORT}`}/slot/${auctionId}/result`,
      payTo: config.seller,
      mint: config.mint,
      feePayer: facilitator.publicKey.toBase58(),
    };
    const header = req.get('PAYMENT-SIGNATURE');
    if (!header) return res.status(402).json(buildPaymentRequired(requirement));

    // 결제 payload는 외부 입력이고 체인 제출까지 하므로 여기가 시스템 경계다.
    // 실패 시 402를 다시 내려 데몬이 "결제 거부"로 기록하게 한다 — 무료 unlock으로 새지 않는다.
    try {
      payment = await settlePayment(conn, facilitator, decodePaymentPayload(header), {
        amount: BigInt(X402_AMOUNT_BASE),
        mint: config.mint,
        destAta: config.sellerTokenAccount,
        decimals: USDC_DECIMALS,
      });
      writePaymentMarker(auctionId, payment);
      console.log(`[seller] x402 결제 확정 auction=${auctionId} sig=${payment.signature}`);
    } catch (e) {
      console.error(`[seller] x402 결제 처리 실패 auction=${auctionId}: ${e.message}`);
      return res.status(402).json(buildPaymentRequired({ ...requirement, error: e.message }));
    }
  }

  // 정산 확인됨 → 결과 공개. 승자 주소를 함께 반환해 호출자가 대조할 수 있게 한다.
  // orchestrator가 정산 시 저장한 확정 캐시를 재사용 → receipt.resultHash와 동일(M2).
  const result = await getResult(AUCTION_ITEM, auctionId);
  return res.json({
    locked: false,
    auctionId,
    winner: auction.winner,
    unlockedForBuyerId: auction.winner === config.addresses['buyer-a'] ? 'buyer-a' : 'unknown',
    item: AUCTION_ITEM,
    result: {
      contentMarkdown: result.contentMarkdown,
      hash: result.hash,
      source: result.source,
    },
    // 데몬은 자기 tx id만 알고 온체인 signature는 모른다(facilitator가 제출하므로).
    // 온체인 증거를 receipt·verify-e2e가 쓰려면 수취 측이 돌려줘야 한다.
    payment: payment
      ? { signature: payment.signature, amountBase: payment.amountBase, status: payment.status }
      : null,
  });
});

app.listen(SELLER_PORT, () => {
  console.log(`seller service listening on http://127.0.0.1:${SELLER_PORT}`);
});

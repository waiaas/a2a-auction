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
import { SELLER_PORT, AUCTION_ITEM } from './config.js';
import { connection, deriveAuctionPda, fetchAuction } from './lib/solana.js';
import { loadConfig } from './lib/state.js';
import { getResult } from './lib/gemini.js';

const app = express();
app.use(express.json());

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
  });
});

app.listen(SELLER_PORT, () => {
  console.log(`seller service listening on http://127.0.0.1:${SELLER_PORT}`);
});

/**
 * Seller 결과 서비스 (스펙 3.3·5.2). 온체인 낙찰·정산을 직접 확인한 뒤에만 결과물을 내준다.
 * 정산 증명이 곧 접근 권한이다 — 오케스트레이터 상태를 믿지 않고 체인을 읽는다.
 *
 *   GET /slot/:auctionId/result
 *     - 온체인 auction이 Settled + winner 존재 → 200 + ServiceResult
 *     - 미정산/미존재 → 403 + 상태 안내
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
  const auction = await fetchAuction(conn, auctionPda);

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

  // 정산 확인됨 → 결과 unlock (낙찰자에게만 의미 있음; 승자 주소를 함께 반환해 대조 가능)
  const result = await getResult(AUCTION_ITEM);
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

/**
 * x402 결과물 unlock (컷 7). 바이어의 데몬으로 seller 결과물을 마이크로페이먼트로 연다.
 * 경매 흐름과 구매 흐름이 함께 쓴다.
 *
 * 데몬 응답의 `payment` 존재가 "402를 거쳐 실제로 결제했다"는 증거다 — 무료로 열렸다면
 * passthrough 200이라 payment가 없다. 실패 시 무료 unlock으로 조용히 넘어가지 않는다
 * (그러면 "x402 실사용" 주장이 거짓이 된다). 재시도 1회 후 호출자에게 error를 표면화한다.
 */
import { SELLER_PUBLIC_URL } from '../config.js';

/**
 * @param {object} client - 바이어의 daemonClient (X402_ALLOWED_DOMAINS 정책 보유 지갑)
 * @param {number} auctionId
 * @param {(msg:string)=>void} log - 진행 로그 (상태 머신의 pushLog를 바인딩해 넘긴다)
 */
export async function unlockViaX402(client, auctionId, log) {
  if (!SELLER_PUBLIC_URL) {
    throw new Error('X402_UNLOCK=1인데 SELLER_PUBLIC_URL이 없다 (cloudflared 터널 URL 필요)');
  }
  const url = `${SELLER_PUBLIC_URL}/slot/${auctionId}/result`;
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const r = await client.x402Fetch(url);
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
      log(`x402 unlock 시도 ${attempt} 실패 (auction #${auctionId}): ${e.message}`);
    }
  }
  throw new Error(`x402 unlock 실패(2회): ${lastError.message}`);
}

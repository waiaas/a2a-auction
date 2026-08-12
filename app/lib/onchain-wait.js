/**
 * 온체인 반영 대기 유틸. 경매 흐름과 구매 흐름이 함께 쓴다.
 *
 * 공통 원칙: **대기 실패로 라운드를 죽이지 않는다.** 데몬의 SUBMITTED는 제출이지 확정이
 * 아니고, 조회가 한 박자 늦었을 뿐 실제로는 반영된 경우가 많다. 여기서 throw하면 조회
 * 지연이 정책 실패처럼 보인다. 판단은 뒤따르는 온체인 명령의 검증에 맡기고, 여기서는
 * 얼마나 기다렸는지만 사실대로 돌려준다.
 */
import { deriveAuctionPda, fetchAuction, tokenUiBalance, confirmSig } from './solana.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 온체인에서 비어 있는 auction_id 슬롯을 앞으로 스캔(스파이크·이전 라운드와 충돌 방지). */
export async function pickFreeAuctionId(conn, marketplace, start) {
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
 * create 직후 auction 계정이 조회될 때까지 짧게 재시도한다.
 *
 * 이게 없으면 갓 기동한 밸리데이터의 첫 라운드에서 commit_bid가 아직 없는 계정을 참조해
 * AccountNotInitialized(3012)로 죽는다(5차 감사 — env-recover 직후 1/1 재현).
 */
export async function waitForAuctionAccount(conn, auctionPda, intervalMs = 500, tries = 10) {
  for (let i = 0; i < tries; i++) {
    if (await fetchAuction(conn, auctionPda)) return { found: true, waitedMs: i * intervalMs };
    await sleep(intervalMs);
  }
  return { found: false, waitedMs: tries * intervalMs };
}

/**
 * 토큰 계정 잔고가 목표치 이상이 될 때까지 짧게 재시도한다(정산 반영 대기).
 * minUiAmount가 null이면 즉시 1회 조회로 끝낸다. 도달하지 못해도 마지막에 읽은 값을
 * 그대로 돌려준다 — 판정은 온체인 Auction 계정(Settled·winner)이 이미 담당한다.
 */
export async function waitForTokenBalance(conn, account, minUiAmount, intervalMs = 500, tries = 10) {
  let balance = await tokenUiBalance(conn, account);
  if (minUiAmount == null) return balance;
  for (let i = 0; i < tries && !(balance != null && balance >= minUiAmount); i++) {
    await sleep(intervalMs);
    balance = await tokenUiBalance(conn, account);
  }
  return balance;
}

/**
 * 예치가 온체인에 반영될 때까지 짧게 재시도한다.
 * reveal_bid의 온체인 요구사항(vault 잔고 >= reveal 금액)을 그대로 게이트로 쓴다.
 */
export async function waitForVaultDeposit(conn, vault, txHash, minUiAmount, intervalMs = 500, tries = 10) {
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

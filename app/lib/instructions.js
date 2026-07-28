/**
 * 경매 프로그램 트랜잭션 본문 빌더. 계정 순서·플래그는 온체인 Anchor 정의(create_auction.rs 등)와
 * D-6 스파이크에서 검증된 조합을 그대로 따른다. 여기서 순서가 틀리면 온체인에서 조용히 실패한다.
 *
 * 반환값은 데몬 `POST /v1/transactions/send`의 body(walletId·network 제외)다.
 */
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { PROGRAM_ID, USDC_DECIMALS } from '../config.js';
import { acc, ixData, u64le, SYS_PROGRAM, PublicKey } from './solana.js';

const TOKEN_PROG = TOKEN_PROGRAM_ID.toBase58();
const ATA_PROG = ASSOCIATED_TOKEN_PROGRAM_ID.toBase58();

/** CONTRACT_CALL 공통 래퍼. to·programId는 항상 경매 프로그램. */
function contractCall(dataB64, accounts) {
  return {
    type: 'CONTRACT_CALL',
    to: PROGRAM_ID,
    programId: PROGRAM_ID,
    instructionData: dataB64,
    accounts,
  };
}

/** create_auction — marketplace(authority) 서명. auction·vault 계정을 init. */
export function buildCreateAuction({ marketplace, seller, mint, auctionPda, vault, auctionId }) {
  const data = ixData('create_auction', u64le(auctionId));
  const accounts = [
    acc(marketplace, true, true), // authority (signer, w, payer)
    acc(seller, false, false), // seller (ro, 주소만 기록)
    acc(mint, false, false), // usdc_mint (ro)
    acc(auctionPda, false, true), // auction (w, pda init)
    acc(vault, false, true), // vault (w, ATA init)
    acc(TOKEN_PROG, false, false),
    acc(ATA_PROG, false, false),
    acc(SYS_PROGRAM, false, false),
  ];
  return contractCall(data, accounts);
}

/** commit_bid — bidder 서명. bid 계정 init. WHITELIST(programId)·CONTRACT_WHITELIST 심사 통과 필요. */
export function buildCommitBid({ bidder, auctionPda, bidPda, commitHash }) {
  const data = ixData('commit_bid', commitHash);
  const accounts = [
    acc(bidder, true, true), // bidder (signer, w, payer)
    acc(auctionPda, false, false), // auction (ro)
    acc(bidPda, false, true), // bid (w, pda init)
    acc(SYS_PROGRAM, false, false),
  ];
  return contractCall(data, accounts);
}

/**
 * deposit — 단독 TOKEN_TRANSFER. to=auction_pda(vault owner) → 데몬이 vault ATA를 유도.
 * token.assetId(CAIP-19)가 있어야 token_limits 수량 티어가 걸린다(load-bearing ③).
 */
export function buildDeposit({ auctionPda, amount, mint, assetId }) {
  return {
    type: 'TOKEN_TRANSFER',
    to: typeof auctionPda === 'string' ? auctionPda : auctionPda.toBase58(),
    amount: amount.toString(),
    token: {
      address: typeof mint === 'string' ? mint : mint.toBase58(),
      decimals: USDC_DECIMALS,
      symbol: 'USDC',
      assetId,
    },
  };
}

/** reveal_bid — bidder 서명. 커밋 해시 검증 + vault 예치 도착 확인. */
export function buildRevealBid({ bidder, auctionPda, bidPda, vault, amount, salt }) {
  const data = ixData('reveal_bid', u64le(amount), salt);
  const accounts = [
    acc(bidder, true, false), // bidder (signer, ro; feePayer로 승격)
    acc(auctionPda, false, true), // auction (w)
    acc(bidPda, false, true), // bid (w)
    acc(vault, false, false), // vault (ro, 잔고만 읽음)
  ];
  return contractCall(data, accounts);
}

/** settle — marketplace(authority) 서명. vault → seller ATA로 낙찰금 CPI 전송. */
export function buildSettle({ marketplace, auctionPda, vault, sellerTokenAccount }) {
  const data = ixData('settle');
  const accounts = [
    acc(marketplace, true, false), // authority (signer, ro; feePayer 승격)
    acc(auctionPda, false, true), // auction (w)
    acc(vault, false, true), // vault (w)
    acc(sellerTokenAccount, false, true), // seller_token_account (w)
    acc(TOKEN_PROG, false, false),
  ];
  return contractCall(data, accounts);
}

export { PublicKey };

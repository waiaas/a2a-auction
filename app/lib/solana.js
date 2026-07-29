/**
 * Solana 저수준 유틸: 주소 유도, instruction 인코딩, auction 계정 borsh 디코드, Ed25519 서명.
 *
 * 데몬을 거치지 않는 순수 온체인 계산과 조회만 담당한다(정책·서명은 데몬 몫).
 */
import crypto from 'node:crypto';
import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { PROGRAM_ID, RPC_URL, DISC } from '../config.js';

export const SYS_PROGRAM = new PublicKey('11111111111111111111111111111111');
export const programId = new PublicKey(PROGRAM_ID);

export function connection() {
  return new Connection(RPC_URL, 'confirmed');
}

/** u64 little-endian 8바이트. */
export function u64le(v) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(v));
  return b;
}

export function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest();
}

/** instruction data(base64) = discriminator(8) || tail. */
export function ixData(name, ...tail) {
  return Buffer.concat([Buffer.from(DISC[name]), ...tail]).toString('base64');
}

/** CONTRACT_CALL의 accounts 배열 원소. */
export function acc(pubkey, isSigner, isWritable) {
  const s = pubkey?.toBase58 ? pubkey.toBase58() : String(pubkey);
  return { pubkey: s, isSigner, isWritable };
}

/**
 * 라운드 결정론적 salt. 같은 (role, auctionId)면 항상 같은 값 → commit/reveal 재현 가능
 * (salt를 state에 들고 다니지 않아도 된다).
 *
 * 주의: role 3개와 auctionId가 모두 공개값이라 누구나 commitHash를 재계산할 수 있다.
 * 이 구조는 **입찰 해시 선등록**이지 금액 은닉이 아니다 — 은닉이 필요하면 입찰자별
 * 랜덤 salt 생성과 보관이 필요하다(README 하드닝 로드맵).
 */
export function saltFor(role, auctionId) {
  return sha256(Buffer.from(`a2a-salt|${role}|${auctionId}`));
}

/** commit 해시 = sha256(amount_le(8) || salt(32)). 온체인 reveal 검증식과 동일. */
export function commitHash(amount, role, auctionId) {
  return sha256(Buffer.concat([u64le(amount), saltFor(role, auctionId)]));
}

/** auction PDA: ["auction", authority(marketplace), auction_id_le]. */
export function deriveAuctionPda(marketplacePk, auctionId) {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('auction'), new PublicKey(marketplacePk).toBuffer(), u64le(auctionId)],
    programId,
  );
  return pda;
}

/** vault: auction PDA가 authority인 USDC ATA (allowOwnerOffCurve). */
export function deriveVault(mintPk, auctionPda) {
  return getAssociatedTokenAddressSync(new PublicKey(mintPk), auctionPda, true);
}

/** bid PDA: ["bid", auction, bidder]. */
export function deriveBidPda(auctionPda, bidderPk) {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('bid'), auctionPda.toBuffer(), new PublicKey(bidderPk).toBuffer()],
    programId,
  );
  return pda;
}

/**
 * auction 계정 수동 borsh 디코드 (IDL 없이). state.rs의 필드 순서를 그대로 따른다.
 * @returns {{status:string, highest:string, winner:string|null, totalRevealed:string}|null}
 */
export function decodeAuction(data) {
  if (!data) return null;
  let o = 8; // discriminator
  const readPk = () => {
    const pk = new PublicKey(data.subarray(o, o + 32));
    o += 32;
    return pk.toBase58();
  };
  const authority = readPk();
  const seller = readPk();
  const usdcMint = readPk();
  const vault = readPk();
  const auctionId = data.readBigUInt64LE(o);
  o += 8;
  const status = data.readUInt8(o);
  o += 1; // 0 Committing, 1 Revealing, 2 Settled
  const highest = data.readBigUInt64LE(o);
  o += 8;
  const hasWinner = data.readUInt8(o);
  o += 1;
  let winner = null;
  if (hasWinner === 1) winner = readPk();
  const statusName = ['Committing', 'Revealing', 'Settled'][status] ?? `unknown(${status})`;
  return {
    authority,
    seller,
    usdcMint,
    vault,
    auctionId: auctionId.toString(),
    status: statusName,
    highest: highest.toString(),
    winner,
  };
}

/** auction PDA를 온체인에서 읽어 디코드. 없으면 null. */
export async function fetchAuction(conn, auctionPda) {
  const info = await conn.getAccountInfo(new PublicKey(auctionPda));
  return info ? decodeAuction(info.data) : null;
}

/** 토큰 계정 잔고(uiAmount). 계정 없으면 null. */
export async function tokenUiBalance(conn, tokenAccount) {
  try {
    const r = await conn.getTokenAccountBalance(new PublicKey(tokenAccount));
    return r.value.uiAmount;
  } catch {
    return null;
  }
}

/** txHash의 온체인 확정 상태. */
export async function confirmSig(conn, txHash) {
  if (!txHash) return 'no-sig';
  try {
    const st = await conn.getSignatureStatuses([txHash]);
    const v = st.value[0];
    if (!v) return 'unknown';
    return v.confirmationStatus || (v.confirmations === null ? 'finalized' : 'confirmed');
  } catch {
    return 'err';
  }
}

/**
 * Ed25519 detached 서명 (Node crypto, 외부 nacl 불필요).
 * secretKey64 = solana Keypair.secretKey (앞 32B가 seed).
 */
export function signEd25519(secretKey64, message) {
  const seed = Buffer.from(secretKey64.slice(0, 32));
  const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
  const key = crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  return crypto.sign(null, Buffer.from(message, 'utf8'), key); // 64 bytes
}

export { Keypair, PublicKey, LAMPORTS_PER_SOL };

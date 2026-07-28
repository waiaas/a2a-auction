/**
 * 온체인 인프라 셋업(시드 전용). deployer 키페어로 서명하는 작업만 여기 둔다:
 *  SOL airdrop, USDC mint 생성/재사용, ATA 생성, USDC 지급(top-up).
 *
 * 오케스트레이터는 이 모듈을 쓰지 않는다(데몬 API + 읽기 전용 조회만). deployer 키 격리.
 */
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
} from '@solana/spl-token';
import { LAMPORTS_PER_SOL, PublicKey } from './solana.js';
import { USDC_DECIMALS } from '../config.js';

/** 주소의 SOL 잔고가 minSol 미만이면 airdrop으로 채운다. */
export async function ensureSol(conn, address, minSol = 1, topUpSol = 2) {
  const pk = new PublicKey(address);
  const bal = await conn.getBalance(pk);
  if (bal < minSol * LAMPORTS_PER_SOL) {
    const sig = await conn.requestAirdrop(pk, topUpSol * LAMPORTS_PER_SOL);
    await conn.confirmTransaction(sig, 'confirmed');
  }
  return (await conn.getBalance(pk)) / LAMPORTS_PER_SOL;
}

/**
 * USDC mint 확보. reuseMint가 온체인에 존재하면 재사용, 아니면 새로 생성.
 * @returns {Promise<PublicKey>}
 */
export async function ensureMint(conn, deployer, reuseMint) {
  if (reuseMint) {
    const info = await conn.getAccountInfo(new PublicKey(reuseMint));
    if (info) return new PublicKey(reuseMint);
  }
  // deployer = mint authority + payer, freeze authority 없음
  return createMint(conn, deployer, deployer.publicKey, null, USDC_DECIMALS);
}

/** owner의 ATA 확보(없으면 생성). */
export async function ensureAta(conn, deployer, mint, owner) {
  const acc = await getOrCreateAssociatedTokenAccount(
    conn,
    deployer,
    new PublicKey(mint),
    new PublicKey(owner),
  );
  return acc.address;
}

/**
 * ATA 잔고를 target 이상으로 top-up(부족분만 mint). 멱등.
 * @returns {Promise<{ata:string, balanceBase:bigint}>}
 */
export async function ensureTokenBalance(conn, deployer, mint, owner, targetBase) {
  const mintPk = new PublicKey(mint);
  const ata = await ensureAta(conn, deployer, mintPk, owner);
  const acc = await getAccount(conn, ata);
  const have = acc.amount; // bigint
  if (have < BigInt(targetBase)) {
    await mintTo(conn, deployer, mintPk, ata, deployer, BigInt(targetBase) - have);
  }
  const after = await getAccount(conn, ata);
  return { ata: ata.toBase58(), balanceBase: after.amount };
}

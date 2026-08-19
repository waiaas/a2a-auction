/**
 * 오너 → 에이전트 지갑 USDC 입금.
 *
 * **이 입금이 곧 위임 행위다.** 서버가 에이전트 지갑에 직접 넣으면 "사람이 얼마까지 맡겼는가"가
 * 사라지고 데모의 주제 자체가 없어진다. 그래서 서버는 **서명되지 않은 트랜잭션을 조립만** 하고,
 * 서명은 반드시 사용자의 지갑에서 일어난다. 서버는 오너의 키를 갖지 않는다.
 *
 * 서명은 받되 **전송은 서버가 한다**(`signTransaction` → 서버 브로드캐스트). 지갑의
 * `signAndSendTransaction`은 지갑이 자기 RPC로 보내는데, 이 데모의 체인은 로컬 밸리데이터라
 * 지갑이 닿을 수 없다. 서명만 받아 우리 RPC로 보내면 localnet과 devnet에서 같은 코드가 돈다.
 *
 * 에이전트가 쓸 가스(SOL)도 **같은 트랜잭션에 함께 실어** 오너가 보낸다. 서버가 대납하면
 * 그만큼 실제 비용을 서비스가 떠안는데, 이 자금은 위임의 크기와 무관한 순수 운영 비용이라
 * 대줄 이유가 없다(2026-08-14 결정). 명령을 한 트랜잭션에 묶으므로 서명은 여전히 한 번이다.
 */
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction,
} from '@solana/spl-token';
import { Transaction, VersionedTransaction, SystemProgram } from '@solana/web3.js';
import { USDC_DECIMALS } from '../config.js';
import { connection, PublicKey, LAMPORTS_PER_SOL } from './solana.js';
import { UserError } from './user-error.js';

/**
 * 에이전트 지갑이 온체인 실행에 쓸 가스. 위임 한도와 무관한 실행 비용이다.
 *
 * **실측 기준**: 구매 1건에 약 0.0015 SOL을 쓴다(commit·deposit·reveal·x402 수수료 +
 * bid PDA rent 0.00145). 라운드 3건을 돈 지갑이 0.05에서 0.0456으로 줄었다. 0.02면
 * 13건 정도라 체험에 넉넉하고, 오너가 한 번에 부담하기에도 부담이 없는 크기다.
 */
export const AGENT_GAS_SOL = Number(process.env.AGENT_GAS_SOL || 0.02);

/**
 * 입금 트랜잭션을 조립한다(서명 없음).
 *
 * 에이전트 지갑의 USDC 계정(ATA)이 아직 없으면 생성 명령을 함께 넣는다. 이때 rent를 내는
 * payer도 오너다 — 서버가 대신 내면 그만큼 위임 관계 밖의 자금이 섞인다.
 *
 * @returns {Promise<{txBase64:string, lastValidBlockHeight:number, amountUsdc:number}>}
 */
export async function buildDepositTx({ ownerAddress, agentAddress, mint, amountUsdc }) {
  const amount = Number(amountUsdc);
  if (!Number.isFinite(amount) || amount <= 0) throw new UserError('입금액은 0보다 커야 합니다.');

  const conn = connection();
  const owner = new PublicKey(ownerAddress);
  const agent = new PublicKey(agentAddress);
  const mintPk = new PublicKey(mint);

  const ownerAta = await getAssociatedTokenAddress(mintPk, owner);
  const agentAta = await getAssociatedTokenAddress(mintPk, agent);

  const ownerInfo = await conn.getAccountInfo(ownerAta);
  if (!ownerInfo) throw new UserError('보낼 USDC가 없습니다. 먼저 체험 자산을 받아 주세요.');

  const tx = new Transaction();

  // 에이전트가 온체인 명령을 보내려면 가스가 있어야 한다. 부족분만 채운다 — 매 입금마다
  // 정액을 얹으면 쓰지도 않을 SOL이 에이전트 지갑에 쌓인다.
  const agentLamports = await conn.getBalance(agent);
  const gasTarget = Math.round(AGENT_GAS_SOL * LAMPORTS_PER_SOL);
  if (agentLamports < gasTarget) {
    tx.add(
      SystemProgram.transfer({
        fromPubkey: owner,
        toPubkey: agent,
        lamports: gasTarget - agentLamports,
      }),
    );
  }

  const agentInfo = await conn.getAccountInfo(agentAta);
  if (!agentInfo) {
    tx.add(createAssociatedTokenAccountInstruction(owner, agentAta, agent, mintPk));
  }
  tx.add(
    createTransferCheckedInstruction(
      ownerAta,
      mintPk,
      agentAta,
      owner,
      BigInt(Math.round(amount * 10 ** USDC_DECIMALS)),
      USDC_DECIMALS,
    ),
  );

  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  tx.feePayer = owner;

  // 서명 자리를 비운 채 직렬화한다. 지갑이 이 바이트를 받아 자기 서명을 채운다.
  const txBase64 = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
  return { txBase64, lastValidBlockHeight, amountUsdc: amount };
}

/**
 * 지갑이 서명한 트랜잭션을 전송하고 확정까지 기다린다.
 *
 * 확정을 기다리는 이유: 화면이 "입금됐습니다"라고 말한 직후 사용자가 구매를 누르는데, 그때
 * 잔고가 아직 반영되지 않았으면 정책이 아니라 잔고 때문에 실패한다. 실패 원인이 어긋나면
 * 사용자는 정책 엔진을 오해한다.
 */
export async function submitSignedTx(signedTxBase64) {
  const conn = connection();
  const raw = Buffer.from(signedTxBase64, 'base64');
  // 지갑이 legacy로 돌려주든 versioned로 돌려주든 바이트 그대로 보낼 수 있다.
  const signature = await conn.sendRawTransaction(raw, { skipPreflight: false });
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
  await conn.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
  return signature;
}

/** 지갑이 versioned를 돌려줬는지 확인만 하는 용도(전송 경로는 바이트를 그대로 쓴다). */
export function isVersioned(signedTxBase64) {
  try {
    VersionedTransaction.deserialize(Buffer.from(signedTxBase64, 'base64'));
    return true;
  } catch {
    return false;
  }
}

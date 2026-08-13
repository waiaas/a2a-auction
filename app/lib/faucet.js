/**
 * 체험용 자산 지급 (테스트넷 faucet).
 *
 * **오너 지갑에만 준다.** 에이전트 지갑에 직접 넣으면 위임 관계를 건너뛰게 되고,
 * 그러면 "얼마까지 맡겼는가"라는 이 데모의 주제가 사라진다. 오너가 받은 자금을 자기
 * 서명으로 에이전트 지갑에 옮기는 것이 위임 행위다.
 *
 * 두 자산의 성격이 다르다.
 *  - USDC: 우리가 발행한 mint라 `deployer`가 얼마든지 찍는다. 사실상 무제한.
 *  - SOL: 발행할 수 없다. localnet은 airdrop이 무제한이지만 **devnet은 보유분이 전부**다
 *         (공용 faucet은 rate limit·봇 차단이 걸려 자동 수급이 안 된다).
 *
 * 그래서 SOL에만 상한을 건다. 상한에 걸리면 조용히 실패하지 않고 사유를 돌려준다 —
 * 심사위원 입장에서 원인 불명의 실패는 서비스 고장으로 읽힌다.
 */
import { USDC_DECIMALS } from '../config.js';
import { connection, PublicKey, LAMPORTS_PER_SOL } from './solana.js';
import { loadDeployer } from './state.js';
import { ensureSol, ensureTokenBalance } from './onchain-setup.js';
import { recordFunding, totalFundedSol } from './store.js';

/**
 * 사용자 1명에게 줄 양.
 *
 * SOL 산정 근거: 오너가 쓰는 곳은 **에이전트 지갑으로 입금하는 트랜잭션 한 번**뿐이다
 * (승인은 메시지 서명이라 온체인 수수료가 없다). USDC ATA 생성 rent 0.00204 + 수수료
 * 몇 건이면 0.005 SOL 안쪽이라, 여유를 크게 줘도 0.05면 충분하다.
 */
export const GRANT_SOL = Number(process.env.FAUCET_GRANT_SOL || 0.05);
export const GRANT_USDC = Number(process.env.FAUCET_GRANT_USDC || 100);

/**
 * faucet이 devnet에서 내보낼 수 있는 SOL 총량.
 *
 * TODO(사람 개입 필요): devnet 배포 전에 실제 보유량을 확인해 이 값을 정한다.
 * 자금 출처는 `onchain/deployer.json`의 지갑이며, 그 주소로 devnet SOL을 보내면 된다.
 * localnet은 airdrop이 무제한이라 이 상한이 사실상 작동하지 않는다.
 */
export const TOTAL_SOL_BUDGET = Number(process.env.FAUCET_TOTAL_SOL || 1);

/** 지급 가능 여부. 거절 사유를 문자열로 돌려준다(화면이 그대로 보여줄 수 있게). */
export function checkBudget() {
  const used = totalFundedSol();
  if (used + GRANT_SOL > TOTAL_SOL_BUDGET) {
    return {
      ok: false,
      reason: '체험 정원이 찼습니다. 운영자가 테스트넷 자금을 보충하면 다시 열립니다.',
      usedSol: used,
      budgetSol: TOTAL_SOL_BUDGET,
    };
  }
  return { ok: true, usedSol: used, budgetSol: TOTAL_SOL_BUDGET };
}

/**
 * 오너 지갑에 체험용 SOL·USDC를 지급한다(멱등에 가깝게 — 목표치까지만 채운다).
 *
 * @param {string} ownerAddress - 연결한 지갑 주소
 * @param {object} config - demo-config.json (mint 주소)
 */
export async function grantToOwner(ownerAddress, config) {
  const budget = checkBudget();
  if (!budget.ok) return { granted: false, ...budget };

  const conn = connection();
  const deployer = loadDeployer();
  const owner = new PublicKey(ownerAddress);

  const solBefore = (await conn.getBalance(owner)) / LAMPORTS_PER_SOL;
  // 목표치까지만 채운다. 이미 충분하면 건드리지 않는다 — 재접속마다 퍼주면 상한이 무의미해진다.
  const solAfter = await ensureSol(conn, ownerAddress, GRANT_SOL, GRANT_SOL, deployer);
  const solGiven = Math.max(0, solAfter - solBefore);

  const { balanceBase } = await ensureTokenBalance(
    conn,
    deployer,
    new PublicKey(config.mint),
    ownerAddress,
    BigInt(Math.round(GRANT_USDC * 10 ** USDC_DECIMALS)),
  );

  recordFunding(ownerAddress, { sol: solGiven, usdc: GRANT_USDC });
  return {
    granted: true,
    solBalance: solAfter,
    usdcBalance: Number(balanceBase) / 10 ** USDC_DECIMALS,
    solGiven,
    note: '오너 지갑에 지급했습니다. 에이전트에게 맡기려면 직접 입금해야 합니다.',
  };
}

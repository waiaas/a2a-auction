/**
 * 체험용 자산 지급 (테스트넷 faucet).
 *
 * **오너 지갑에만 준다.** 에이전트 지갑에 직접 넣으면 위임 관계를 건너뛰게 되고,
 * 그러면 "얼마까지 맡겼는가"라는 이 데모의 주제가 사라진다. 오너가 받은 자금을 자기
 * 서명으로 에이전트 지갑에 옮기는 것이 위임 행위다.
 *
 * 두 자산의 성격이 다르다.
 *  - USDC: 우리가 발행한 mint라 `deployer`가 얼마든지 찍는다. **달리 구할 방법이 없으므로**
 *          어느 네트워크에서든 지급한다(안 주면 아무것도 살 수 없다).
 *  - SOL: 발행할 수 없다. 실제 비용이라 **devnet에서는 지급하지 않는다**(사용자 결정,
 *         2026-08-14). 접속자가 공용 faucet에서 받아 온 SOL로 가스를 낸다.
 *
 * localnet만 예외로 SOL을 준다. airdrop이 무제한이라 비용이 0이고, 개발·리허설에서
 * 매번 외부 faucet을 도는 것은 순수한 낭비다. 이 분기가 곧 "비용이 드는가"의 경계다.
 */
import { USDC_DECIMALS, NETWORK_LABEL } from '../config.js';
import { connection, PublicKey, LAMPORTS_PER_SOL } from './solana.js';
import { loadDeployer } from './state.js';
import { ensureSol, ensureTokenBalance } from './onchain-setup.js';
import { recordFunding, totalFundedSol } from './store.js';

/**
 * localnet에서만 주는 SOL. 다른 네트워크에서는 지급하지 않는다.
 *
 * 에이전트 가스(0.02)를 입금 트랜잭션에 실어 보내고도 수수료와 ATA rent가 남아야 하므로
 * 그 합보다 넉넉히 둔다. airdrop이라 비용은 0이다.
 */
export const GRANT_SOL = Number(process.env.FAUCET_GRANT_SOL || 0.1);
export const GRANT_USDC = Number(process.env.FAUCET_GRANT_USDC || 100);

/** SOL을 지급해도 되는 환경인가. airdrop이 공짜인 로컬 밸리데이터에서만 참이다. */
export const CAN_GRANT_SOL = NETWORK_LABEL === 'localnet';

/** 접속자가 직접 SOL을 받아야 할 때 안내할 곳. 화면이 그대로 링크로 쓴다. */
export const PUBLIC_FAUCET_URL = 'https://faucet.solana.com';

/**
 * 지급 가능 여부. SOL을 주지 않는 환경에서는 상한 개념 자체가 없다(USDC는 우리 mint라 무제한).
 * 화면이 그대로 보여줄 수 있게 사유를 문자열로 돌려준다.
 */
export function checkBudget() {
  return { ok: true, grantsSol: CAN_GRANT_SOL, usedSol: totalFundedSol() };
}

/**
 * 오너 지갑에 체험용 자산을 지급한다(멱등에 가깝게 — 목표치까지만 채운다).
 *
 * USDC는 어디서든 준다. 우리가 발행한 mint라 달리 구할 방법이 없어서, 안 주면 접속자가
 * 아무것도 살 수 없다. SOL은 localnet에서만 준다.
 *
 * @param {string} ownerAddress - 연결한 지갑 주소
 * @param {object} config - demo-config.json (mint 주소)
 */
export async function grantToOwner(ownerAddress, config) {
  const conn = connection();
  const deployer = loadDeployer();
  const owner = new PublicKey(ownerAddress);

  let solBalance = (await conn.getBalance(owner)) / LAMPORTS_PER_SOL;
  let solGiven = 0;
  if (CAN_GRANT_SOL) {
    const after = await ensureSol(conn, ownerAddress, GRANT_SOL, GRANT_SOL, deployer);
    solGiven = Math.max(0, after - solBalance);
    solBalance = after;
  }

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
    solBalance,
    usdcBalance: Number(balanceBase) / 10 ** USDC_DECIMALS,
    solGiven,
    grantsSol: CAN_GRANT_SOL,
    // 가스가 없으면 입금 자체가 안 되므로, 지급 직후에 다음 할 일을 정확히 알려준다.
    note: CAN_GRANT_SOL
      ? '오너 지갑에 지급했습니다. 에이전트에게 맡기려면 직접 입금해야 합니다.'
      : solBalance > 0
        ? '체험용 USDC를 지급했습니다. 가스는 지갑에 있는 SOL로 냅니다.'
        : `체험용 USDC를 지급했습니다. 다만 지갑에 SOL이 없어 입금 트랜잭션을 보낼 수 없습니다. ${PUBLIC_FAUCET_URL} 에서 devnet SOL을 받아 주세요.`,
  };
}

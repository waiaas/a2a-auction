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
 *  - SOL: 발행할 수 없다. localnet은 airdrop이 무제한이라 그냥 주고, **devnet은 보유분이
 *         전부라 총량 상한 안에서만 준다.**
 *
 * 상한을 두고 주는 쪽을 택한 이유(2026-08-14 재검토): 접속자에게 "공용 faucet에서 SOL을
 * 받아 오라"고 하면 대부분 거기서 이탈한다. 첫 화면에서 흐름이 끊기면 이 데모가 보여주려는
 * 것에 닿지도 못한다. 이미 확보해 둔 테스트 자산이라 추가 지출이 없고, 상한에 걸리면
 * **조용히 실패하지 않고 사유와 대안을 돌려준다** — 원인 불명의 실패는 서비스 고장으로 읽힌다.
 */
import { USDC_DECIMALS, NETWORK_LABEL } from '../config.js';
import { connection, PublicKey, LAMPORTS_PER_SOL } from './solana.js';
import { loadDeployer } from './state.js';
import { ensureSol, ensureTokenBalance } from './onchain-setup.js';
import { recordFunding, totalFundedSol } from './store.js';

/**
 * 사용자 1명에게 주는 SOL.
 *
 * 오너가 쓰는 곳은 에이전트 지갑으로 보내는 입금 한 번뿐이다. 가스 0.02 + ATA rent 0.00204 +
 * 수수료를 합쳐 0.023 안쪽이라 0.05면 두 배 여유다. localnet은 airdrop이 공짜라 더 넉넉히 준다.
 */
export const GRANT_SOL = Number(process.env.FAUCET_GRANT_SOL || (NETWORK_LABEL === 'localnet' ? 0.1 : 0.05));
export const GRANT_USDC = Number(process.env.FAUCET_GRANT_USDC || 100);

/** airdrop이 공짜인 환경인가. 여기서만 상한 없이 준다. */
export const IS_LOCAL_CHAIN = NETWORK_LABEL === 'localnet';

/**
 * devnet에서 내보낼 SOL 총량.
 *
 * deployer 보유분(2026-08-14 실측 6.03 SOL)의 절반으로 잡았다. 나머지는 USDC 발행 수수료 등
 * 운영에 쓴다. 0.05씩이라 약 60명분이다.
 */
export const TOTAL_SOL_BUDGET = Number(process.env.FAUCET_TOTAL_SOL || 3);

/** 접속자가 직접 SOL을 받아야 할 때 안내할 곳. 화면이 그대로 링크로 쓴다. */
export const PUBLIC_FAUCET_URL = 'https://faucet.solana.com';

/**
 * 지급 가능 여부. 상한에 걸려도 USDC는 계속 준다(우리 mint라 비용이 없다) — SOL만 막힌다.
 * 화면이 그대로 보여줄 수 있게 사유를 문자열로 돌려준다.
 */
export function checkBudget() {
  if (IS_LOCAL_CHAIN) return { ok: true, grantsSol: true, unlimited: true };
  const used = totalFundedSol();
  if (used + GRANT_SOL > TOTAL_SOL_BUDGET) {
    return {
      ok: false,
      grantsSol: false,
      reason: `체험용 SOL이 모두 소진됐습니다(${TOTAL_SOL_BUDGET} SOL). 공식 faucet에서 직접 받아 주세요.`,
      usedSol: used,
      budgetSol: TOTAL_SOL_BUDGET,
    };
  }
  return { ok: true, grantsSol: true, usedSol: used, budgetSol: TOTAL_SOL_BUDGET };
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

  const budget = checkBudget();
  let solBalance = (await conn.getBalance(owner)) / LAMPORTS_PER_SOL;
  let solGiven = 0;
  if (budget.ok) {
    // 목표치까지만 채운다. 이미 충분하면 건드리지 않는다 — 재접속마다 퍼주면 상한이 무의미해진다.
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
    grantsSol: budget.ok,
    // 가스가 없으면 입금 자체가 안 되므로, 지급 직후에 다음 할 일을 정확히 알려준다.
    note: budget.ok
      ? '오너 지갑에 지급했습니다. 에이전트에게 맡기려면 직접 입금해야 합니다.'
      : solBalance > 0
        ? `체험용 USDC를 지급했습니다. ${budget.reason}`
        : `체험용 USDC를 지급했습니다. 다만 지갑에 SOL이 없어 트랜잭션을 보낼 수 없습니다. ${PUBLIC_FAUCET_URL} 에서 devnet SOL을 받아 주세요.`,
  };
}

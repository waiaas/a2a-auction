/**
 * 사용자별 실행 컨텍스트.
 *
 * **온보딩이 지갑을 만들어도 구매 경로가 그 지갑을 쓰지 않으면 아무 의미가 없다.**
 * `purchase-flow.js`는 주인공 바이어 한 명(`MAIN_BUYER`)을 전제로 쓰여 있고 모든 호출이
 * `clients[BUYER]`·`config.addresses[BUYER]`·`config.policies[BUYER]`를 지난다. 그래서 흐름을
 * 고치는 대신 **그 세 자리에 접속자의 에이전트 지갑을 끼운 deps 사본**을 만들어 넘긴다.
 * 흐름 코드는 자기가 누구의 지갑으로 도는지 알 필요가 없다.
 *
 * config는 반드시 사본이어야 한다. 원본을 고치면 같은 프로세스의 다른 사용자와 구 경매 경로가
 * 방금 접속한 사람의 주소를 보게 된다.
 */
import { MAIN_BUYER, DELAY_SECONDS, USDC_DECIMALS } from '../config.js';
import { daemonClient } from './daemon.js';
import { walletRefOf } from './onboarding.js';
import { loadEnv, masterPasswordFor } from './state.js';
import { connection, PublicKey } from './solana.js';
import { UserError } from './user-error.js';
import { getAssociatedTokenAddress } from '@solana/spl-token';

/**
 * 사용자의 에이전트 지갑으로 도는 deps를 만든다.
 *
 * @param {object} base - `buildDeps()` 산출(공용)
 * @param {object} user - store의 users 행
 */
export function buildUserDeps(base, user) {
  const daemonUrl = base.byRole[MAIN_BUYER].daemonUrl;
  const masterPassword = masterPasswordFor(loadEnv(), MAIN_BUYER);
  const client = daemonClient(walletRefOf(user, daemonUrl), masterPassword);

  return {
    ...base,
    config: {
      ...base.config,
      addresses: { ...base.config.addresses, [MAIN_BUYER]: user.agent_address },
      policies: { ...base.config.policies, [MAIN_BUYER]: user.policyIds },
    },
    clients: { ...base.clients, [MAIN_BUYER]: client },
    user,
  };
}

/**
 * 데몬에 **실제로 등록된** 한도를 읽는다.
 *
 * 화면이 "내 정책"이라고 말하는 숫자는 여기서 와야 한다. config 상수를 읽으면 사용자가 한도를
 * 바꾼 뒤에도 화면이 옛 값을 유지해, 판정과 표시가 어긋난 채로 데모가 돈다(감사 F1과 같은 결).
 */
export async function readPolicyLimits(deps) {
  const policies = await deps.clients[MAIN_BUYER].listPolicies();
  const sl = policies.find((p) => p.type === 'SPENDING_LIMIT');
  const limits = sl?.rules?.token_limits?.[deps.config.assetId];
  return {
    notifyMaxUsdc: limits?.notify_max != null ? Number(limits.notify_max) : null,
    delayMaxUsdc: limits?.delay_max != null ? Number(limits.delay_max) : null,
    delaySeconds: Number(sl?.rules?.delay_seconds ?? DELAY_SECONDS),
  };
}

/**
 * 한도를 바꾼다. **이 한 번의 조작이 다음 구매의 판정을 바꾼다** — 사용자가 정책 엔진의
 * 존재를 직접 확인하는 유일한 지점이라, 값 검증을 서버에서 확실히 한다.
 *
 * instant_max는 0으로 고정한다. 자체 발행 mint가 Pyth에 없어 데몬이 최소 NOTIFY로 강제
 * 격상하므로(config.js의 TOKEN_LIMITS 주석) INSTANT 구간을 열어 두면 화면이 도달하지 못하는
 * 티어를 약속하게 된다.
 */
export async function writePolicyLimits(deps, { notifyMaxUsdc, delayMaxUsdc }) {
  const notify = Number(notifyMaxUsdc);
  const delay = Number(delayMaxUsdc);
  if (!Number.isFinite(notify) || !Number.isFinite(delay)) throw new UserError('한도를 숫자로 입력해 주세요.');
  if (notify < 0 || delay < 0) throw new UserError('한도는 0 이상이어야 합니다.');
  if (notify > delay) {
    throw new UserError('알림 한도는 유예 한도보다 클 수 없습니다. 두 값을 바꿔서 입력해 보세요.');
  }

  const policyId = deps.config.policies[MAIN_BUYER]?.spendingLimit;
  if (!policyId) throw new UserError('이 지갑에 지출 한도 정책이 없습니다. 다시 연결해 주세요.', 409);

  await deps.clients[MAIN_BUYER].updatePolicy(policyId, {
    token_limits: {
      [deps.config.assetId]: { instant_max: '0', notify_max: String(notify), delay_max: String(delay) },
    },
    delay_seconds: DELAY_SECONDS,
  });
  return { notifyMaxUsdc: notify, delayMaxUsdc: delay, delaySeconds: DELAY_SECONDS };
}

/** 지갑 한 곳의 SOL·USDC 잔고. 화면이 "지금 얼마 있나"를 말하는 근거다. */
export async function readBalances(address, mint) {
  const conn = connection();
  const owner = new PublicKey(address);
  const lamports = await conn.getBalance(owner);
  const ata = await getAssociatedTokenAddress(new PublicKey(mint), owner);
  let usdc = 0;
  try {
    const bal = await conn.getTokenAccountBalance(ata);
    usdc = Number(bal.value.amount) / 10 ** USDC_DECIMALS;
  } catch {
    usdc = 0; // ATA 미생성 = 잔고 0. 에러가 아니라 상태다
  }
  return { sol: lamports / 1e9, usdc, tokenAccount: ata.toBase58() };
}

/**
 * 정책 티어 대조 검증 (콘티 v3 컷 4의 전제).
 *
 * **리허설 때마다 돌려야 한다.** 컷 4는 "한 정책에서 금액만 바꿔 판정이 갈린다"를 보여주는데,
 * 이 대조는 설정값만으로 보장되지 않는다. 실제로 두 가지가 깨뜨린다.
 *
 *  ① 오라클 격상 — 자체 발행 mint는 가격 조회가 notListed로 끝나고 데몬이 **최소 NOTIFY로
 *     강제 격상**한다(`stage3-policy.ts:181-205`). 그래서 INSTANT 구간은 쓰지 않는다.
 *  ② 대기 큐 누적 — QUEUED·DELAYED 건이 남아 있으면 이후 판정이 **전부 APPROVAL로 무너진다**
 *     (실측: 큐 13건 상태에서 5 USDC도 APPROVAL). 리허설을 반복할수록 조용히 쌓인다.
 *
 * 실행: node verify-tiers.js   ← 샌드박스 해제 필요(루프백·LAN RPC)
 */
import { TOKEN_LIMITS, DELAY_SECONDS, MAIN_BUYER, PATHS } from './config.js';
import { loadStateByRole, loadEnv, masterPasswordFor, loadConfig } from './lib/state.js';
import { daemonClient } from './lib/daemon.js';

/** 검증 대상 바이어. 새 시나리오의 주인공(콘티 v3 §1). */
const ROLE = MAIN_BUYER;

/** 구간마다 대표값 하나씩. 경계값이 아니라 구간 한가운데 값을 쓴다. */
const USDC = (n) => String(BigInt(n) * 1_000_000n);

/** token_limits(human-readable)에서 금액별 기대 티어를 유도한다 — 설정을 바꾸면 기대값도 따라온다. */
function expectedTier(usdc, limits) {
  if (usdc <= Number(limits.instant_max)) return 'INSTANT';
  if (usdc <= Number(limits.notify_max)) return 'NOTIFY';
  if (usdc <= Number(limits.delay_max)) return 'DELAY';
  return 'APPROVAL';
}

async function main() {
  const byRole = loadStateByRole();
  const env = loadEnv();
  const cfg = loadConfig();
  if (!cfg) throw new Error(`${PATHS.demoConfig} 없음 — node seed.js 를 먼저 실행하라`);

  const client = daemonClient(byRole[ROLE], masterPasswordFor(env, ROLE));
  const limits = TOKEN_LIMITS[ROLE];
  const cases = [5, 10, 20].map((usdc) => ({ usdc, expect: expectedTier(usdc, limits) }));

  console.log('=== 정책 티어 대조 검증 ===');
  console.log(`대상 ${ROLE} · token_limits ${limits.instant_max}/${limits.notify_max}/${limits.delay_max} · delay_seconds ${DELAY_SECONDS}`);

  const drained = await client.drainPending();
  if (drained) console.log(`대기 큐 ${drained}건 정리 (누적분이 판정을 APPROVAL로 밀어올린다)`);

  const results = [];
  for (const c of cases) {
    const id = await client.sendTx({
      type: 'TOKEN_TRANSFER',
      to: cfg.addresses.seller,
      amount: USDC(c.usdc),
      token: { address: cfg.mint, decimals: 6, symbol: 'USDC', assetId: cfg.assetId },
    });
    const fin = await client.pollTx(id, ['CONFIRMED', 'FAILED', 'CANCELLED', 'QUEUED', 'DELAYED', 'POLICY_DENIED']);
    const ok = fin.tier === c.expect;
    results.push({ ...c, actual: fin.tier, status: fin.status, ok });
    console.log(
      `  ${String(c.usdc).padStart(2)} USDC → tier=${String(fin.tier).padEnd(9)} ` +
      `status=${String(fin.status).padEnd(10)} 기대=${c.expect.padEnd(9)} ${ok ? 'OK' : '불일치'}`,
    );
  }

  // 검증이 남긴 대기 건을 그대로 두면 다음 실행(또는 데모 라운드)의 판정을 오염시킨다.
  const left = await client.drainPending();
  if (left) console.log(`검증 잔여 ${left}건 정리`);

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    console.error(`\n티어 대조 실패 ${failed.length}건 — 컷 4가 성립하지 않는다.`);
    process.exit(1);
  }
  console.log(`\n티어 대조 성립: ${results.map((r) => `${r.usdc}→${r.actual}`).join(' / ')}`);
}

main().catch((e) => {
  console.error('\nVERIFY FATAL:', e.message);
  process.exit(1);
});

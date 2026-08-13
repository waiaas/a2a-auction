/**
 * 컨트랙트 데모 경로 통합 실행 스크립트 (스펙 D-5). 서버 없이 플로우 코어를 한 번에 돌린다:
 *   create_auction → commit×3 → deposit×3 → reveal A → settle → 결과 요약
 *
 * 오케스트레이터/seller와 같은 코어(auction-flow.js)를 쓰므로, 이게 통과하면 HTTP 경로도 같은 결과를 낸다.
 * 실행: node demo-path.js   ← Bash는 dangerouslyDisableSandbox 필요(데몬·localnet 호출)
 */
import { initState, buildDeps, runAuction, assembleReceipt, BUYERS } from './auction-flow.js';

async function main() {
  const deps = buildDeps();
  const state = initState();
  console.log('=== 컨트랙트 데모 경로 통합 실행 ===');
  await runAuction(state, deps);

  console.log('\n=== 3분기 판정 ===');
  for (const role of BUYERS) {
    const b = state.buyers[role];
    console.log(
      `  ${b.emoji} ${role} bid=${b.bidUsdc} → ${b.ui}` +
        ` (commit=${b.commit?.status}, deposit=${b.deposit?.status}/${b.deposit?.tier || '-'})`,
    );
  }
  console.log('\n=== 온체인 ===');
  console.log(`  auction: ${state.auctionState?.status} winner=${state.auctionState?.winner} (A=${state.auctionState?.winnerIsA})`);
  console.log(`  settle: seller=${state.result?.sellerUsdc} USDC, vault=${state.result?.vaultUsdc} USDC`);
  console.log(`  result: hash=${state.resultMeta?.hash?.slice(0, 16)}… source=${state.resultMeta?.source}`);

  const receipt = assembleReceipt(state);
  // 판정 라벨은 이제 데몬 티어 이름 그대로다(구 ALLOW/APPROVAL_REQUIRED 아님).
  // A는 실행 통과, B는 대기 큐, C는 거부라는 **의미**로 검증한다 — 라벨 문자열을 박아 두면
  // 티어 표기가 바뀔 때마다 이 검증이 조용히 빨간불이 된다.
  const EXECUTED = ['INSTANT', 'NOTIFY'];
  const QUEUED = ['DELAY', 'APPROVAL'];
  const ok =
    EXECUTED.includes(state.buyers['buyer-a'].ui) &&
    QUEUED.includes(state.buyers['buyer-b'].ui) &&
    state.buyers['buyer-c'].ui === 'DENY' &&
    state.auctionState?.status === 'Settled' &&
    state.auctionState?.winnerIsA === true &&
    state.result?.sellerUsdc >= 2.8;

  console.log(
    `\n판정: ${ok ? '✅ PASS (A 실행 / B 대기 / C 거부 · settle 완료 · A 낙찰)' : '❌ FAIL'}` +
    `  [A=${state.buyers['buyer-a'].ui} B=${state.buyers['buyer-b'].ui} C=${state.buyers['buyer-c'].ui}]`,
  );
  if (!ok) {
    console.log(JSON.stringify(receipt, null, 2));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('\nDEMO-PATH FATAL:', e.message);
  process.exit(1);
});

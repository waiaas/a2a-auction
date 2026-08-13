/**
 * 사용자별 구매 상태 보관.
 *
 * 전역 상태 하나로는 동시 접속자가 서로의 화면을 덮어쓴다. 심사위원 두 명이 같은 시각에
 * 들어오면 한 사람의 구매가 다른 사람 화면에 뜨고, 승인 버튼도 남의 건에 열린다.
 *
 * 메모리에 두되 **DB에서 복원한다.** 서버가 재시작해도 어제 산 것이 남아 있어야 하고,
 * 대기 중이던 건은 데몬 쪽에 그대로 살아 있어서 상태만 잃으면 화면에서 영영 사라진다.
 */
import { initPurchaseState, isQueuedDecision } from '../purchase-flow.js';
import { listPurchases, savePurchase } from './store.js';

/** ownerAddress → { state, running } */
const rounds = new Map();

/** 이미 끝난 건인지(더 할 일이 없는 상태). phase 복원에 쓴다. */
function isDone(p) {
  return Boolean(p.steps?.settle) || ['DENY', 'REJECTED'].includes(p.ui);
}

function phaseOf(purchases) {
  if (!purchases.length) return 'idle';
  if (purchases.some((p) => isQueuedDecision(p.ui))) return 'awaiting';
  if (purchases.some((p) => !isDone(p))) return 'settling';
  return 'settled';
}

/**
 * 사용자의 현재 라운드를 얻는다. 메모리에 없으면 DB에서 복원한다.
 *
 * @param {string} ownerAddress
 * @param {object} buyer - 표시 정보 + 실제 정책값(`readPolicyLimits` 결과로 채운다)
 */
export function getRound(ownerAddress, buyer) {
  let round = rounds.get(ownerAddress);
  if (!round) {
    const state = initPurchaseState(buyer);
    const restored = listPurchases(ownerAddress);
    if (restored.length) {
      // 저장은 최신순이라 화면 순서(오래된 것부터)로 되돌린다.
      state.purchases = restored.reverse();
      state.startedAt = state.purchases[0]?.startedAt ?? null;
      state.phase = phaseOf(state.purchases);
      state.log.push(`이전 기록 ${state.purchases.length}건을 불러왔습니다.`);
    }
    round = { state, running: false };
    rounds.set(ownerAddress, round);
  }
  // 정책은 매번 최신값으로 갈아끼운다 — 사용자가 방금 한도를 바꿨을 수 있다.
  if (buyer) round.state.buyer = { ...round.state.buyer, ...buyer };
  return round;
}

/** 진행분을 DB에 남긴다. 각 단계가 끝날 때마다 불러 재시작에도 살아남게 한다. */
export function persistRound(ownerAddress, state) {
  for (const purchase of state.purchases) {
    try {
      savePurchase(ownerAddress, purchase);
    } catch (e) {
      // 저장 실패가 진행을 막지는 않는다. 다만 조용히 넘기면 재시작 후에야 드러난다.
      console.error(`[rounds] 구매 저장 실패 ${purchase.requestId}: ${e.message}`);
    }
  }
}

/** 리허설 초기화용. 메모리만 비운다(DB 이력은 store.clearUser 소관). */
export function dropRound(ownerAddress) {
  rounds.delete(ownerAddress);
}

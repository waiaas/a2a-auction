/**
 * state 객체(오케스트레이터 계약)에서 화면 파생값을 뽑는 순수 함수 모음.
 * 서버가 이미 판정(buyers[x].ui)·정산을 계산해 주므로 여기서는 표시용 가공만 한다.
 */
export const BUYER_ORDER = ['buyer-a', 'buyer-b', 'buyer-c'];

/** 서명/주소 축약: 앞 head · 뒤 tail. 값 없으면 null. */
export function truncTx(sig, head = 6, tail = 5) {
  if (!sig) return null;
  if (sig.length <= head + tail + 1) return sig;
  return `${sig.slice(0, head)}…${sig.slice(-tail)}`;
}

export function fmtUsdc(n) {
  if (n == null || Number.isNaN(Number(n))) return '—';
  return Number(n).toFixed(2);
}

/** 데몬 거부 에러를 사람이 읽는 짧은 사유로 축약. 원문은 호출부가 title로 보존한다. */
export function friendlyDenyReason(error) {
  if (!error) return null;
  if (/not in whitelist/i.test(error)) {
    const m = error.match(/Address\s+(\w+)/);
    return m ? `수신처 WHITELIST 미등록 (${truncTx(m[1], 4, 4)})` : '수신처 WHITELIST 미등록';
  }
  return error.length > 64 ? `${error.slice(0, 61)}…` : error;
}

/** buyer 배열을 서버 map에서 고정 순서로 뽑는다(없으면 빈 배열). */
export function orderedBuyers(buyers) {
  if (!buyers) return [];
  return BUYER_ORDER.map((r) => buyers[r]).filter(Boolean);
}

/** RAW 최고 입찰: 실행 가능 여부와 무관한 최고 bidUsdc. */
export function rawHighest(buyers) {
  const list = orderedBuyers(buyers);
  if (!list.length) return null;
  return list.reduce((top, b) => (b.bidUsdc > (top?.bidUsdc ?? -1) ? b : top), null);
}

/** EXECUTABLE 낙찰자: 온체인 정산 확정 시에만. auctionState.winner 주소로 buyer를 매칭. */
export function executableWinner(state) {
  const a = state?.auctionState;
  if (!a || a.status !== 'Settled' || !a.winner) return null;
  const list = orderedBuyers(state.buyers);
  const winner = list.find((b) => b.address === a.winner) || (a.winnerIsA ? state.buyers?.['buyer-a'] : null);
  if (!winner) return null;
  return { ...winner, highestUsdc: Number(a.highest) / 1e6 };
}

/** commit 상태 → 표시용 {cls,label}. TX_OK면 확정, 없으면 대기. */
export function commitStat(commit) {
  if (!commit) return { cls: 'pending', label: '대기' };
  const ok = commit.onchain === 'confirmed' || ['SUBMITTED', 'CONFIRMED'].includes(commit.status);
  return ok ? { cls: 'ok', label: '확정' } : { cls: 'bad', label: commit.status || '실패' };
}

/**
 * 판정 표시의 단일 소스.
 *
 * **키는 WAIaaS 정책 티어 이름 그대로다.** 화면에 ALLOW/DENY 같은 자체 용어를 쓰면
 * 심사위원이 보는 라벨과 데몬이 실제로 내린 판정이 어긋난다(콘티 v3 컷 4). 티어가
 * 그대로 보여야 정책 엔진이 스스로를 증명한다.
 *
 * 구 시나리오(3자 경매)의 ALLOW·APPROVAL_REQUIRED·DENY는 흐름 재구성이 끝날 때까지
 * 화면이 깨지지 않도록 함께 남겨 둔다.
 */
const VERDICT = {
  // WAIaaS 정책 티어
  INSTANT: { cls: 'ok', short: 'INSTANT', label: 'INSTANT', step: '즉시 실행', sub: '한도 내 · 즉시 실행' },
  NOTIFY: { cls: 'ok', short: 'NOTIFY', label: 'NOTIFY', step: '실행', sub: '알림 발송 · 실행은 통과' },
  DELAY: { cls: 'warn', short: 'DELAY', label: 'DELAY', step: '유예 대기', sub: '유예 중 · 취소 가능' },
  APPROVAL: { cls: 'warn', short: 'APPROVAL', label: 'APPROVAL', step: '승인 대기', sub: 'owner 승인 대기' },
  // 정책 판정이 아니라 관측 실패(데몬 응답 타임아웃) — 거부와 같은 배지로 보이면 서사가 뒤집힌다.
  TIMEOUT: { cls: 'pending', short: 'TIMEOUT', label: 'TIMEOUT', step: '관측 실패', sub: '판정 관측 실패' },
  // 구 시나리오 호환
  ALLOW: { cls: 'ok', short: 'ALLOW', label: 'ALLOW', step: '실행', sub: '위임 한도 내 · 자동 실행' },
  APPROVAL_REQUIRED: { cls: 'warn', short: 'APPROVAL', label: 'APPROVAL REQUIRED', step: '승인 대기', sub: 'owner 승인 대기' },
  DENY: { cls: 'bad', short: 'DENY', label: 'DENY', step: '거부', sub: '수신처 정책 거부' },
};

const VERDICT_PENDING = { cls: 'pending', short: '대기', label: '판정 대기', step: '대기', sub: '' };

/** 예치 상태 → 표시용 {cls,label}. 판정(ui) 기준. */
export function depositStat(ui) {
  const v = VERDICT[ui];
  return v ? { cls: v.cls, label: v.step } : { cls: 'pending', label: '대기' };
}

/** 최종 판정 배지 → {cls,label,sub}. */
export function verdictInfo(ui) {
  const v = VERDICT[ui] ?? VERDICT_PENDING;
  return { cls: v.cls, label: v.label, sub: v.sub };
}

/** 파이프라인 스텝: phase로 각 단계의 done/active/pending을 계산. */
const PHASE_ORDER = ['committing', 'depositing', 'revealing', 'settling', 'settled'];
const STEPS = [
  { key: 'committing', label: 'commit' },
  { key: 'depositing', label: 'deposit' },
  { key: 'revealing', label: 'reveal' },
  { key: 'settling', label: 'settle' },
  { key: 'settled', label: 'settled', final: true },
];

export function pipelineSteps(phase) {
  const cur = PHASE_ORDER.indexOf(phase);
  return STEPS.map((s) => {
    const idx = PHASE_ORDER.indexOf(s.key);
    let status = 'pending';
    if (s.final) status = phase === 'settled' ? 'done' : 'pending';
    else if (cur > idx) status = 'done';
    else if (cur === idx) status = 'active';
    return { ...s, status };
  });
}

/** 라운드가 실행 중(로딩)인지. 'open'은 개설이 끝나고 입찰을 기다리는 상태라 제외한다. */
export function isRunning(phase) {
  return ['opening', 'committing', 'depositing', 'revealing', 'settling'].includes(phase);
}

/** v4 판정 pill (짧은 라벨). */
export function verdictShort(ui) {
  const v = VERDICT[ui] ?? VERDICT_PENDING;
  return { cls: v.cls, label: v.short };
}

/** hero 상단 상태 pill: phase → {cls,label}. */
export function statusPill(phase) {
  switch (phase) {
    case 'settled': return { cls: 'gold', label: 'SETTLED ★' };
    case 'error': return { cls: 'bad', label: '오류' };
    case 'idle': return { cls: 'pending', label: '준비' };
    case 'open': return { cls: 'pending', label: 'OPEN · 입찰 대기' };
    default: return { cls: 'live', label: 'LIVE' }; // 진행 중
  }
}

/** hero 메타의 상태 문구. */
export function phaseLabel(phase) {
  return {
    opening: '경매 개설 중',
    open: '입찰 대기',
    committing: '입찰 커밋 중',
    depositing: '예치 · 정책 판정 중',
    revealing: 'reveal 중',
    settling: '정산 중',
    settled: 'Settled',
    error: '오류',
    idle: '준비 완료',
  }[phase] || phase;
}

/** 라이브 액티비티 피드: 현재 state의 실제 이벤트에서 파생(가짜 타임스탬프 없음). */
export function liveActivity(state) {
  const items = [];
  if (state.phase === 'settled' && state.auctionState?.winnerIsA) {
    const s = state.result?.sellerUsdc;
    items.push({
      icon: 'marketplace', who: 'Marketplace', act: `settled #${state.auctionId}`,
      sub: `winner Analyst · vault→seller ${s != null ? Number(s).toFixed(2) : '—'}`,
    });
  }
  // 실물은 "데몬의 대기 큐에 등재"까지다. 알림 외부 발송(푸시·문자)은 미구성이므로
  // 화면이 발송된 것처럼 말하지 않는다 — NOTIFY도 "알림 기록"까지만 적는다.
  const TIMELINE = {
    INSTANT: { act: 'deposit 실행', sub: 'INSTANT · 즉시 실행' },
    NOTIFY: { act: 'deposit 실행', sub: 'NOTIFY · 알림 기록 · 실행은 통과' },
    DELAY: { act: '유예 대기', sub: 'DELAY · 유예 큐 등재 · 취소 가능' },
    APPROVAL: { act: '승인 대기', sub: 'APPROVAL · 데몬 승인 큐 등재' },
    TIMEOUT: { act: '판정 관측 실패', sub: '데몬 응답 타임아웃' },
    ALLOW: { act: 'deposit 실행', sub: 'ALLOW · 자동 실행' },
    APPROVAL_REQUIRED: { act: '승인 대기', sub: '데몬 승인 큐 등재' },
    DENY: { act: '정책 거부', sub: 'WHITELIST 미등록' },
  };
  for (const b of orderedBuyers(state.buyers)) {
    const t = TIMELINE[b.ui];
    if (t) items.push({ icon: b.role, who: b.name, act: t.act, sub: `${fmtUsdc(b.bidUsdc)} · ${t.sub}` });
  }
  const committed = orderedBuyers(state.buyers).filter((b) => b.commit).length;
  if (committed) items.push({ icon: 'chain', who: `${committed} agents`, act: 'committed bids', sub: '입찰 해시 선등록 · reveal 전' });
  return items;
}

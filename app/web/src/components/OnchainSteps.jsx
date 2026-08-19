import TxLink from './TxLink.jsx';

/**
 * 온체인 진행 표시.
 *
 * 구매 1건은 체인에서 다섯 번 일어난다(개설 → 주문 → 예치 → 공개 → 정산). 그런데 화면은
 * 그 다섯이 다 끝난 뒤 영수증에서만 보여줬다. **진행 중에는 "진행 중입니다"라는 문장
 * 하나뿐이라, 실제로 체인에서 일이 벌어지는 동안 화면이 가장 조용했다.**
 *
 * 상태는 1.5초 폴링으로 갱신되므로 단계가 하나씩 켜지는 것이 그대로 보인다. 이 데모에서
 * "목업이 아니다"를 말이 아니라 움직임으로 증명하는 자리다.
 *
 * **예치가 정책이 갈리는 유일한 지점이다**(commit은 CONTRACT_CALL이라 token_limits가 걸리지
 * 않는다). 그래서 그 단계에만 판정을 함께 적는다 — 어디서 사람이 개입하는지가 곧 이 데모의
 * 주제이므로, 다섯 칸 중 어느 칸에서 멈췄는지가 설명 없이 읽혀야 한다.
 */
const STAGES = [
  { key: 'createAuction', label: '거래 개설' },
  { key: 'commit', label: '주문 등록' },
  { key: 'deposit', label: '대금 예치', gate: true },
  { key: 'reveal', label: '금액 공개' },
  { key: 'settle', label: '정산' },
];

const DONE = new Set(['CONFIRMED', 'SUBMITTED']);
const WAIT = new Set(['QUEUED', 'DELAYED']);
const FAIL = new Set(['CANCELLED', 'FAILED', 'POLICY_DENIED', 'REJECTED', 'EXPIRED']);

function stageState(step) {
  if (!step) return 'idle';
  if (FAIL.has(step.status)) return 'fail';
  if (WAIT.has(step.status)) return 'wait';
  if (DONE.has(step.status)) return 'done';
  return 'idle';
}

/** 멈춰 선 이유는 티어마다 다르다. "대기 중"만 적으면 무엇을 해야 하는지가 사라진다. */
function waitNote(ui) {
  if (ui === 'APPROVAL') return '내 서명 대기';
  if (ui === 'DELAY') return '유예 중';
  return '대기 중';
}

export default function OnchainSteps({ steps, ui, running }) {
  if (!steps) return null;

  const marks = STAGES.map((s) => {
    const step = steps[s.key];
    return { ...s, step, state: stageState(step) };
  });

  const done = marks.filter((m) => m.state === 'done').length;
  // 멈춰 선 건(대기·실패)에는 진행 표시를 켜지 않는다. 기다리는 중인데 도는 것처럼
  // 보이면 사용자가 승인 버튼을 찾지 않는다.
  const halted = marks.some((m) => m.state === 'wait' || m.state === 'fail');
  const activeIdx = running && !halted ? marks.findIndex((m) => m.state === 'idle') : -1;

  return (
    <div className="os">
      <div className="os-h">
        <span className="os-t">온체인 진행</span>
        <span className="os-c tnum">{done}/{STAGES.length}</span>
      </div>
      <ol className="os-row">
        {marks.map((m, i) => (
          <li key={m.key} className={`os-i ${m.state}${i === activeIdx ? ' active' : ''}`}>
            <span className="os-d" />
            <span className="os-l">{m.label}</span>
            {m.step?.txHash && <TxLink sig={m.step.txHash} />}
            {m.state === 'wait' && <span className="os-n">{waitNote(ui)}</span>}
            {m.gate && m.state === 'idle' && i === activeIdx && <span className="os-n">정책 판정 중</span>}
          </li>
        ))}
      </ol>
    </div>
  );
}

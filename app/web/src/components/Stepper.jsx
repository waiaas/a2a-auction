/**
 * 진행 단계 표시.
 *
 * **한 화면에 전 과정을 쌓아 두면 지금 무엇이 일어나는지 설명할 수 없다**(8/19 퀵싱크).
 * 라우팅으로 페이지를 나누는 대신 이 막대로 단계를 표시하고 현재 단계만 펼친다 —
 * 새로고침이나 뒤로가기로 진행 중인 구매가 끊기는 위험 없이 같은 효과를 낸다.
 */
export const STEPS = [
  { id: 'request', label: '요청' },
  { id: 'choose', label: '공급자 선택' },
  { id: 'approve', label: '승인' },
  { id: 'settle', label: '결제' },
  { id: 'result', label: '결과물' },
  { id: 'receipt', label: '영수증' },
];

export default function Stepper({ current }) {
  const at = STEPS.findIndex((s) => s.id === current);

  return (
    <ol className="stepper" aria-label="진행 단계">
      {STEPS.map((s, i) => {
        const state = i < at ? 'done' : i === at ? 'cur' : 'todo';
        return (
          <li key={s.id} className={`step ${state}`} aria-current={state === 'cur' ? 'step' : undefined}>
            <span className="step-dot" aria-hidden="true" />
            {s.label}
          </li>
        );
      })}
    </ol>
  );
}

import { useState } from 'react';

/**
 * 자유 요청 입력.
 *
 * **여기가 "콘티 재생 장치"와 "서비스"를 가르는 자리다.** 고정된 세 건이 도는 대신 사용자가
 * 필요한 것을 직접 쓰고, 에이전트가 카탈로그에서 알아서 고른다. 그래서 무엇이 뽑힐지도,
 * 어떤 판정이 날지도 미리 정해져 있지 않다.
 *
 * 예시를 몇 개 두는 이유는 백지에서 시작하면 대부분 아무것도 쓰지 못하기 때문이다.
 */
const EXAMPLES = [
  '다음 주 팀 회의 전에 훑어볼 스테이블코인 결제 시장 요약',
  '투자 검토용으로 쓸 온체인 결제 프로토콜 심층 리포트',
  '경쟁사 동향을 한 장으로 정리한 주간 브리핑',
];

export default function RequestBox({ onSubmit, busy, catalog }) {
  const [text, setText] = useState('');

  const send = () => {
    const value = text.trim();
    if (!value) return;
    onSubmit(value);
    setText('');
  };

  return (
    <section className="svc-card svc-request">
      <header>
        <span className="svc-role">여기서도 시켜볼 수 있습니다</span>
        {catalog?.length > 0 && (
          <span className="svc-sub">
            카탈로그 {catalog.length}건 · {Math.min(...catalog.map((l) => l.priceUsdc))}~
            {Math.max(...catalog.map((l) => l.priceUsdc))} USDC
          </span>
        )}
      </header>

      {/* 정식 경로는 MCP다. 이 입력창은 MCP 클라이언트가 없는 사람을 위한 보조라, 화면이
          그 사실을 말하고 대응하는 도구 호출을 함께 보여준다. */}
      <p className="svc-note">
        MCP 클라이언트가 없어도 확인하실 수 있게 둔 보조 입력입니다. 아래에 적는 것은 도구로는{' '}
        <code>request_work(prompt)</code> 호출과 같습니다.
      </p>

      <textarea
        rows={3}
        placeholder="필요한 것을 그대로 적어 주세요. 에이전트가 카탈로그에서 알맞은 공급자를 고릅니다."
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send();
        }}
      />

      <div className="svc-req-actions">
        <div className="svc-examples">
          {EXAMPLES.map((ex) => (
            <button key={ex} type="button" className="svc-chip" onClick={() => setText(ex)}>
              {ex.length > 26 ? `${ex.slice(0, 26)}…` : ex}
            </button>
          ))}
        </div>
        <button className="cta" disabled={busy || !text.trim()} onClick={send}>
          {busy ? '진행 중…' : '맡기기'}
        </button>
      </div>
    </section>
  );
}

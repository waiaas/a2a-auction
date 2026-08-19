import AgentCard from './AgentCard.jsx';
import { fmtUsdc } from '../lib/derive.js';

/**
 * 후보 나열과 가중치 조정 (8/19 퀵싱크 신설).
 *
 * **요청을 넣자마자 결제로 넘어가면 "왜 이걸 골랐나"를 설명할 자리가 없다.** 그때까지 이
 * 데모는 금액에 100% 가중치가 걸려 있어, 0.1달러 차이로 저품질을 고르는 그림을 방어할 수
 * 없었다. 그래서 후보를 먼저 늘어놓고 무엇을 중요하게 볼지 사용자가 정하게 한다.
 *
 * 고르는 것은 여전히 에이전트다. 사람이 정하는 것은 기준이고, 그 기준으로 1위가 된 것을
 * 에이전트가 사고 결제까지 진행한다 — 사람이 후보를 클릭해 고르면 자율성 장면이 사라진다.
 */
export default function CandidateList({ prompt, candidates, priceWeight, onWeight, onSubmit, onOpenSample, onCancel, busy }) {
  const pricePct = Math.round(priceWeight * 100);
  const picked = candidates[0];

  return (
    <div className="cand">
      <div className="cand-h">
        <div>
          <span className="svc-role">에이전트가 후보를 찾았습니다</span>
          <p className="cand-prompt">{prompt}</p>
        </div>
        <button className="cta ghost" onClick={onCancel} disabled={busy}>요청 고치기</button>
      </div>

      <section className="svc-card cand-weight">
        <header>
          <span className="svc-role">무엇을 중요하게 볼까요</span>
          <span className="svc-sub">가격 {pricePct}% · 품질 {100 - pricePct}%</span>
        </header>
        <div className="weight-row">
          <span className="weight-cap">가격 중시</span>
          <input
            type="range"
            min="0"
            max="100"
            step="5"
            value={pricePct}
            onChange={(e) => onWeight(Number(e.target.value) / 100)}
            disabled={busy}
            aria-label="가격과 품질의 가중치"
          />
          <span className="weight-cap">품질 중시</span>
        </div>
        <p className="svc-note">
          품질에는 <b>샘플 채점</b>과 <b>평점</b>이 함께 들어갑니다. 평점은 지금까지 받은 결과물을
          채점한 평균이라, 별점을 스스로 올릴 수는 없습니다.
        </p>
      </section>

      <div className="cand-grid">
        {candidates.map((c) => (
          <AgentCard key={c.id} listing={c} onOpenSample={onOpenSample} busy={busy} showRank />
        ))}
      </div>

      <div className="cand-go">
        <p className="svc-note">
          이 기준이면 에이전트는 <b>{picked?.seller.name}</b>에게{' '}
          <b>{fmtUsdc(picked?.priceUsdc ?? 0)} USDC</b>를 지불합니다. 한도를 넘으면 내 지갑 서명을
          요청합니다.
        </p>
        <button className="cta" onClick={() => onSubmit(priceWeight)} disabled={busy || !picked}>
          {busy ? '진행 중…' : '이 기준으로 맡기기'}
        </button>
      </div>
    </div>
  );
}

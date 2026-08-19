import { fmtUsdc } from '../lib/derive.js';

/**
 * 등록된 에이전트 한 장.
 *
 * 메인 카탈로그와 후보 나열이 같은 카드를 쓴다. 두 화면에서 카드 모양이 다르면 "아까 그
 * 에이전트"임을 알아보기 어렵고, 무엇보다 같은 정보를 두 번 만들면 한쪽만 고치게 된다.
 *
 * **평점 · 이용 횟수 · 가격 세 가지는 항상 노출한다**(8/19 퀵싱크). 순위와 종합 점수는
 * 후보 화면에서만 붙는다 — 카탈로그에는 아직 비교할 기준이 없다.
 */
export default function AgentCard({ listing, onOpenSample, busy, showRank = false }) {
  const { scores, rank } = listing;

  return (
    <article className={`svc-card cand-card ${showRank && rank === 1 ? 'cand-top' : ''}`}>
      {showRank && (
        <header>
          <span className="cand-rank">{rank}위</span>
          {rank === 1 && <span className="pill gold"><span className="d" />에이전트 선택</span>}
        </header>
      )}

      <div className="cand-id">
        <span className="cand-emoji" aria-hidden="true">{listing.seller.emoji}</span>
        <div>
          <b>{listing.seller.name}</b>
          <span className="svc-sub">{listing.title}</span>
        </div>
      </div>

      <div className="cand-price">{fmtUsdc(listing.priceUsdc)}<small> USDC</small></div>

      <dl className="cand-stats">
        {showRank && scores && (
          <div><dt>종합</dt><dd className="cand-total">{scores.total}</dd></div>
        )}
        <div><dt>평점</dt><dd>{listing.rating ?? '—'}</dd></div>
        <div><dt>이용</dt><dd>{listing.track.completed}회</dd></div>
        <div><dt>샘플 채점</dt><dd>{listing.sample?.score ?? '—'}</dd></div>
      </dl>

      <p className="cand-sum">{listing.summary}</p>

      {listing.sample?.markdown && (
        <button className="cta ghost" onClick={() => onOpenSample(listing)} disabled={busy}>
          샘플 보기
        </button>
      )}
    </article>
  );
}

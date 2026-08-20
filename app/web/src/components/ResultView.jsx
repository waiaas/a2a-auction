import Markdown from './Markdown.jsx';
import ScoreTable from './ScoreTable.jsx';
import { fmtUsdc } from '../lib/derive.js';

/**
 * 받은 결과물과 그 채점 (8/19 퀵싱크 신설).
 *
 * **여기가 라이브 채점이 도는 유일한 자리다.** 구매 전 화면의 샘플 점수는 저장된 값이지만,
 * 이 점수는 방금 받은 결과물을 그 자리에서 잰 것이다. 그래서 "평점 4.8은 어디서 나온
 * 숫자냐"는 물음에 이 화면이 답한다 — 채점이 쌓여 평점이 된다.
 *
 * 결과물 본문은 정산이 끝나야 서버가 내려준다. 화면이 그 순서를 어기면 x402 열람 게이트가
 * 장식이 된다.
 */
export default function ResultView({ result, onBack, onOpenReceipt }) {
  if (!result) return null;
  const { grade, gradeError, criteria, listing, x402 } = result;
  const moved = grade && grade.ratingBefore != null && grade.ratingAfter != null;

  return (
    <div className="rv">
      <div className="cand-h">
        <div>
          <span className="svc-role">받은 결과물</span>
          <p className="cand-prompt">{result.task || result.title}</p>
        </div>
        <div className="svc-top-actions">
          <button className="cta ghost" onClick={onOpenReceipt}>영수증</button>
          <button className="cta ghost" onClick={onBack}>← 돌아가기</button>
        </div>
      </div>

      <section className="svc-card rv-meta">
        <header>
          <span className="svc-role">{listing?.sellerEmoji} {listing?.sellerName}</span>
          <span className="svc-sub">
            {listing?.deliverable?.format} · 출처 {listing?.deliverable?.sourceCount}건 · {fmtUsdc(listing?.priceUsdc ?? 0)} USDC
            {x402 && ` · 열람 결제 ${x402.amountUsdc} USDC`}
          </span>
        </header>
      </section>

      <section className="svc-card rv-grade">
        <header>
          <span className="svc-role">이 결과물을 채점했습니다</span>
          <span className="svc-sub">
            {grade ? `${grade.score} / 100` : gradeError ? '채점 실패' : '채점 중…'}
          </span>
        </header>

        {grade ? (
          <>
            {/* 어떤 채점기가 매겼는지 밝힌다. 공급자 선택은 폴백을 "규칙으로 선택"이라고
                표시하는데 채점만 숨기면, 정작 "이 점수가 뭐냐"는 물음에 답할 수 없다. */}
            <span className={`tag ${grade.source === 'live' ? 'ok' : 'warn'}`}>
              {grade.source === 'live' ? 'AI 채점' : '규칙으로 채점'}
            </span>
            <ScoreTable breakdown={grade.breakdown} criteria={criteria} />
            {moved && (
              <p className="rv-rating">
                {listing?.sellerName} 평점 <b>{grade.ratingBefore}</b> → <b>{grade.ratingAfter}</b>
                <span className="svc-sub"> 최근 채점 평균</span>
              </p>
            )}
            <p className="svc-note">
              채점 기준은 의뢰의 성격을 따릅니다. 리서치에는 리서치의 기준이 붙고, 코드 의뢰에는
              검증 기준이 붙습니다. 이 점수가 쌓여 그 에이전트의 평점이 됩니다.
              {grade.source !== 'live' && (
                <> 지금은 채점 모델을 쓸 수 없어 <b>본문에서 기준별 신호를 세는 규칙</b>으로 매겼습니다.</>
              )}
            </p>
          </>
        ) : gradeError ? (
          <p className="svc-bad">채점하지 못했습니다: {gradeError}</p>
        ) : (
          <p className="svc-note">결과물을 읽고 채점하는 중입니다. 잠시 후 점수가 표시됩니다.</p>
        )}
      </section>

      <section className="svc-card rv-body">
        <Markdown source={result.markdown} />
      </section>
    </div>
  );
}

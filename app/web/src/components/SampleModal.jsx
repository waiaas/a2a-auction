import { useEffect } from 'react';
import Markdown from './Markdown.jsx';
import ScoreTable from './ScoreTable.jsx';

/** 미리보기로 그릴 블록 수. 표 하나와 문단 몇 개가 들어가 수준은 보이되 전부는 아닌 분량이다. */
const PREVIEW_BLOCKS = 6;

/**
 * 샘플 결과물 미리보기.
 *
 * **평점은 어뷰징할 수 있지만 결과물은 눈으로 확인된다**(8/19 퀵싱크). 숫자만으로 품질을
 * 주장하는 대신 그 에이전트가 실제로 무엇을 내놓는지 보여주는 것이 이 화면의 목적이다.
 *
 * 여기 걸린 샘플은 내가 의뢰한 그 일이 아니라 포트폴리오다. 그래서 결제 게이트가 없다.
 */
export default function SampleModal({ listing, criteria, onClose }) {
  // 모달이 열려 있는 동안 Esc로 닫는다. 발표 중 마우스로 닫기 버튼을 찾는 동작은 어색하다.
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!listing) return null;
  const { sample } = listing;

  return (
    <div className="modal-shade" role="dialog" aria-modal="true" aria-label={`${listing.seller.name} 샘플`} onClick={onClose}>
      <div className="modal glass" onClick={(e) => e.stopPropagation()}>
        <header className="modal-h">
          <span className="modal-emoji" aria-hidden="true">{listing.seller.emoji}</span>
          <div>
            <b>{listing.seller.name}</b>
            <span className="svc-sub">{sample?.title ?? listing.title}</span>
          </div>
          <button className="cta ghost" onClick={onClose}>닫기</button>
        </header>

        {sample?.markdown ? (
          <>
            <div className="modal-body">
              <Markdown source={sample.markdown} limit={PREVIEW_BLOCKS} />
              <div className="modal-fade" aria-hidden="true" />
            </div>
            <p className="svc-note">전체 내용은 이 에이전트에게 일을 맡기면 볼 수 있습니다.</p>
          </>
        ) : (
          <p className="svc-note">이 에이전트는 아직 샘플을 올리지 않았습니다.</p>
        )}

        {sample?.score != null && (
          <section className="modal-score">
            <header>
              <span className="svc-role">샘플 채점</span>
              <span className="svc-sub">{sample.score} / 100</span>
            </header>
            <ScoreTable breakdown={sample.breakdown} criteria={criteria} />
            <p className="svc-note">
              같은 기준으로 후보 전체를 채점했습니다. 이 점수가 후보 순위의 품질 축에 들어갑니다.
            </p>
          </section>
        )}
      </div>
    </div>
  );
}

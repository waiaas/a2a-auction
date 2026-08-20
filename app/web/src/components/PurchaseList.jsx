import { verdictInfo, fmtUsdc } from '../lib/derive.js';
import { navigate } from '../lib/router.js';

/**
 * 내 구매 목록 — 요약 행만 놓고, 내용은 행을 눌러 상세 페이지에서 본다 (8/20 피드백).
 *
 * 아코디언(결정 ⑯의 "지난 단계는 한 줄로 접는다")을 페이지 이동으로 승격한 것이다.
 * 같은 화면에서 카드가 펼쳐지는 것은 "화면만 갈아껴진다"로 읽히고, 판단 근거·온체인
 * 5단계·승인 버튼은 한 건짜리 상세(`#/tasks/:id`, TaskDetail)가 맡는 편이 서비스답다.
 */
export default function PurchaseList({ purchases, busy, onSettle, x402Enabled }) {
  if (!purchases.length) {
    return <p className="svc-empty">아직 맡긴 일이 없습니다. 홈에서 필요한 것을 적어 보세요.</p>;
  }

  const needsSettle = purchases.some(
    (p) => !p.steps?.settle && ['NOTIFY', 'INSTANT', 'RELEASED', 'APPROVED'].includes(p.ui),
  );
  // 정산은 끝났는데 열람 결제가 실패한 건. 이 조건이 없으면 정산 버튼이 사라져서, 돈을 낸
  // 사람이 결과물을 영영 못 본다(unlock 재시도가 정산 경로 안에만 있기 때문).
  const needsUnlock = Boolean(x402Enabled) && purchases.some((p) => p.steps?.settle && !p.x402);
  const settleable = needsSettle || needsUnlock;

  // 서버 배열은 생성순(오래된 것부터)이고 회귀·스테퍼가 "마지막 = 최신"을 전제하므로
  // 순서는 여기 표시 계층에서만 뒤집는다. 방금 맡긴 일이 스크롤 없이 맨 위에 보여야 한다.
  const newestFirst = [...purchases].reverse();

  return (
    <div className="svc-list">
      <div className="svc-list-head">
        <h3>맡긴 일 {purchases.length}건</h3>
        {settleable && (
          <button className="cta ghost" disabled={busy} onClick={onSettle}>
            {needsSettle ? '결과물 받기 (정산)' : '열람 결제 다시 시도'}
          </button>
        )}
      </div>

      {newestFirst.map((p) => (
        <TaskRow key={p.requestId} p={p} />
      ))}
    </div>
  );
}

function TaskRow({ p }) {
  const v = verdictInfo(p.ui);
  const open = () => navigate(`#/tasks/${p.requestId}`);

  return (
    <article
      className={`buy buy-row ${p.ui === 'APPROVAL' ? 'hl' : ''}`}
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => e.key === 'Enter' && open()}
    >
      <div className="buy-h">
        {/* `need`(용도)는 싣지 않는다. 웹으로 들어온 요청은 예외 없이 "사용자가 직접 입력한
            요청"이라 목록에서는 같은 문구가 건수만큼 반복돼 제목을 훑는 것을 방해한다.
            경로 구분이 필요하면 상세의 선택 근거가 말한다(8/20 리허설). */}
        <div className="t">{p.title}</div>
        {p.grade && <span className="buy-mini">채점 {p.grade.score}점</span>}
        <span className="buy-mini tnum">{fmtUsdc(p.amountUsdc)} USDC</span>
        <span className={`pill ${v.cls}`}><span className="d" />{v.label}</span>
        <span className="buy-caret" aria-hidden="true">›</span>
      </div>
    </article>
  );
}

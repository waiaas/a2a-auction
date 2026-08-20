import { verdictInfo, fmtUsdc } from '../lib/derive.js';
import OnchainSteps from './OnchainSteps.jsx';
import { navigate } from '../lib/router.js';

/**
 * 맡긴 일 한 건의 상세 페이지 (8/20 피드백으로 아코디언에서 승격).
 *
 * 한 건마다 세 가지를 나란히 놓는다. **무엇을 왜 골랐나**(에이전트의 판단), **어떤 티어로
 * 판정됐나**(정책 엔진), **그래서 어떻게 끝났나**(온체인 결과). 셋 중 하나만 보여주면
 * 사용자는 결과가 왜 그렇게 됐는지 알 수 없다.
 *
 * 실패도 같은 자리에 같은 무게로 적는다. 원인을 말하지 않는 실패는 서비스 고장으로 읽힌다.
 */
export default function TaskDetail({ p, busy, running, onApprove, onCancel, onSettle, onOpenResult, x402Enabled }) {
  if (!p) {
    // 새로고침 직후 폴링이 아직 안 채웠거나, 존재하지 않는 주소로 들어온 경우.
    return (
      <div className="cand">
        <div className="cand-h">
          <div>
            <span className="svc-role">맡긴 일</span>
            <p className="cand-prompt">불러오는 중이거나 없는 건입니다.</p>
          </div>
          <button className="cta ghost" onClick={() => navigate('#/tasks')}>← 목록으로</button>
        </div>
      </div>
    );
  }

  const v = verdictInfo(p.ui);
  const failure = failureNote(p);
  const needsSettle = !p.steps?.settle && ['NOTIFY', 'INSTANT', 'RELEASED', 'APPROVED'].includes(p.ui);
  const needsUnlock = Boolean(x402Enabled) && p.steps?.settle && !p.x402;

  return (
    <div className="cand">
      <div className="cand-h">
        <div>
          <span className="svc-role">맡긴 일</span>
          <p className="cand-prompt">{p.title}</p>
        </div>
        <button className="cta ghost" onClick={() => navigate('#/tasks')}>← 목록으로</button>
      </div>

      <article className={`buy ${p.ui === 'APPROVAL' ? 'hl' : ''}`}>
        <div className="buy-h">
          <div>
            <div className="t">{p.title}</div>
            <div className="s">{p.need}</div>
          </div>
          <span className={`pill ${v.cls}`}><span className="d" />{v.label}</span>
        </div>

        <div className="buy-pick">
          <span className="e">{p.listing.sellerEmoji}</span>
          <b>{p.listing.title}</b>
          <span className="a tnum">{fmtUsdc(p.amountUsdc)} USDC</span>
          <span className={`tag ${p.decision.source === 'live' ? 'ok' : 'warn'}`}>
            {p.decision.source === 'live' ? '에이전트 판단' : '규칙으로 선택'}
          </span>
        </div>
        <div className="buy-why">{p.decision.reason}</div>
        {p.decision.rejected && <div className="buy-rej">고르지 않은 것: {p.decision.rejected}</div>}

        <OnchainSteps steps={p.steps} ui={p.ui} running={running} />

        <div className="buy-f">
          {/* 이 판정을 누가 내렸는지 화면이 말해야 한다. 어드민 탭을 빼기로 한 대신
              (8/19 결정 ⑰ 번복) WAIaaS가 드러나는 자리를 여기에 둔다. */}
          <span className="wai-tag">WAIaaS 정책</span>
          <span>{tierExplain(p)}</span>
          {p.auctionId != null && <span>거래 #{p.auctionId}</span>}
          {p.steps?.settle && <span className="ok">정산 완료</span>}
          {p.x402 && <span className="ok">열람 결제 {p.x402.amountUsdc} USDC</span>}
          {/* 채점은 받은 결과물을 그 자리에서 잰 점수다. 이 점수가 셀러 평점이 된다. */}
          {p.grade && <span className="ok">채점 {p.grade.score}점</span>}
          {failure && <span className="bad">{failure}</span>}

          {(needsSettle || needsUnlock) && (
            <button className="cta svc-approve" disabled={busy} onClick={onSettle}>
              {needsSettle ? '결과물 받기 (정산)' : '열람 결제 다시 시도'}
            </button>
          )}
          {p.steps?.settle && onOpenResult && (
            <button className="cta svc-approve" disabled={busy} onClick={() => onOpenResult(p)}>
              결과물 보기
            </button>
          )}

          {p.ui === 'APPROVAL' && (
            <>
              {/* `bad`를 클래스로 쓰지 않는다 — `.buy-f .bad`(실패 문구용 빨간 글씨)가
                  버튼에 걸려 글자색이 배경과 같아진다. */}
              <button className="cta svc-approve" disabled={busy} onClick={() => onApprove(p)}>
                내 지갑으로 승인
              </button>
              <button className="cta ghost" disabled={busy} onClick={() => onCancel(p)}>
                거부
              </button>
            </>
          )}
          {p.ui === 'DELAY' && (
            <button className="cta ghost" disabled={busy} onClick={() => onCancel(p)}>
              유예 중 취소
            </button>
          )}
        </div>
      </article>
    </div>
  );
}

/** 판정이 무슨 뜻인지 그 건의 금액으로 말한다. 티어 이름만으로는 아무도 이해하지 못한다. */
function tierExplain(p) {
  switch (p.ui) {
    case 'NOTIFY':
    case 'INSTANT':
      return `${p.amountUsdc} USDC는 한도 안이라 알림만 가고 진행됐습니다.`;
    case 'DELAY':
      return `${p.amountUsdc} USDC는 유예 구간이라 잠시 기다립니다. 그 사이 취소할 수 있습니다.`;
    case 'APPROVAL':
      return `${p.amountUsdc} USDC는 맡긴 한도를 넘어 내 서명이 필요합니다.`;
    case 'APPROVED':
      return '내가 승인해서 진행됐습니다.';
    case 'RELEASED':
      return '유예가 끝나 스스로 진행됐습니다.';
    case 'REJECTED':
      return '내가 거부해서 돈이 나가지 않았습니다.';
    case 'DENY':
      return '정책이 막아 실행되지 않았습니다.';
    default:
      return '진행 중입니다.';
  }
}

/** 실패 문구. 원인별로 다음에 할 일을 붙인다. */
function failureNote(p) {
  if (p.settleError) {
    return /Settled|이미/.test(p.settleError)
      ? '이미 정산된 건입니다.'
      : `정산이 끝나지 않았습니다: ${p.settleError}`;
  }
  if (p.unlockError) return `결과물 열람 결제가 실패했습니다: ${p.unlockError}`;
  if (p.steps?.deposit?.error) return `실행이 막혔습니다: ${p.steps.deposit.error}`;
  return null;
}

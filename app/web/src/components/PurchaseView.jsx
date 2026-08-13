import { useCallback, useEffect, useState } from 'react';
import Icon from './Icon.jsx';
import { fetchPurchaseState, fetchCatalog, startPurchase, settlePurchase, approvePurchase } from '../api.js';
import { verdictInfo, fmtUsdc } from '../lib/derive.js';

/**
 * 구매 라운드 화면 (콘티 v3 컷 1~6).
 *
 * 한 화면에 세 장면을 세로로 쌓는다. 카탈로그(무엇을 살 수 있나) → 정책 한 줄(무엇이 허용되나)
 * → 구매 3건(같은 정책이 금액마다 어떻게 반응하나). **판정 배지는 데몬이 내린 티어 이름을
 * 그대로 쓴다** — 화면 용어와 정책 엔진의 판정이 어긋나면 데모가 스스로를 증명하지 못한다.
 */
export default function PurchaseView({ onBack, onOpenReceipt }) {
  const [state, setState] = useState(null);
  const [listings, setListings] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetchCatalog().then((d) => setListings(d.listings)).catch(() => {});
  }, []);

  // 유예는 시간이 지나면 스스로 풀린다. 폴링이 그 변화를 잡는 유일한 경로다.
  useEffect(() => {
    let alive = true;
    const tick = () => {
      fetchPurchaseState()
        .then((d) => { if (alive) setState(d); })
        .catch(() => {});
    };
    tick();
    const id = setInterval(tick, 1500);
    return () => { alive = false; clearInterval(id); };
  }, []);

  const run = useCallback(async (fn) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }, []);

  const purchases = state?.purchases ?? [];
  const policy = state?.buyer?.policy;
  const running = state?.running || busy;
  // 대기가 풀렸는데 아직 정산되지 않은 건이 있으면 정산할 거리가 있다.
  const settleable = purchases.some((p) => !p.steps?.settle && ['NOTIFY', 'INSTANT', 'RELEASED', 'APPROVED'].includes(p.ui));

  return (
    <div className="stage">
      <div className="sec-h">
        <h2>에이전트 구매 라운드</h2>
        <button className="cta ghost" onClick={onBack}>← 돌아가기</button>
      </div>

      {policy && (
        <p className="pol">
          정책 한 줄: <b>{policy.notifyMaxUsdc} USDC까지 알림</b>, <b>{policy.delayMaxUsdc} USDC까지 유예 {policy.delaySeconds}초</b>,
          그 이상은 <b>사람 승인</b>
        </p>
      )}

      <div className="lst">
        {listings.map((l) => (
          <div className="lst-c" key={l.id}>
            <div className="lst-h">
              <span className="e">{l.seller.emoji}</span>
              <div>
                <div className="t">{l.title}</div>
                <div className="s">{l.seller.name}</div>
              </div>
              <div className="p tnum">{l.priceUsdc}<u>USDC</u></div>
            </div>
            <div className="lst-m">{l.summary}</div>
            <div className="lst-f">
              {l.deliverable.format} · 출처 {l.deliverable.sourceCount}건 · 수행 {l.track.completed}건 · 재구매 {Math.round(l.track.repeatRate * 100)}%
            </div>
          </div>
        ))}
      </div>

      <div className="acts">
        <button className="cta" disabled={running} onClick={() => run(startPurchase)}>
          {running ? '진행 중…' : '일 맡기기 (3건)'}
        </button>
        <button className="cta ghost" disabled={running || !settleable} onClick={() => run(settlePurchase)}>
          정산하기
        </button>
        <button className="cta ghost" disabled={!purchases.length} onClick={onOpenReceipt}>
          영수증
        </button>
        {state?.phase && <span className="ph">phase: {state.phase}</span>}
      </div>

      {error && <div className="errbar">{error}</div>}

      {purchases.map((p) => {
        const v = verdictInfo(p.ui);
        return (
          <div className={`buy ${p.ui === 'APPROVAL' ? 'hl' : ''}`} key={p.requestId}>
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
                {p.decision.source === 'live' ? '에이전트 판단' : '폴백 규칙'}
              </span>
            </div>
            <div className="buy-why">{p.decision.reason}</div>
            {p.decision.rejected && <div className="buy-rej">기각: {p.decision.rejected}</div>}

            <div className="buy-f">
              <span>{v.sub}</span>
              {p.auctionId != null && <span>auction #{p.auctionId}</span>}
              {/* 성공만 초록으로 말한다. 실패를 같은 색으로 적으면 화면이 거짓을 말한다. */}
              {p.steps?.settle && <span className="ok">정산 완료 · seller {p.result?.sellerUsdc ?? '—'} USDC</span>}
              {p.x402 && <span className="ok">x402 {p.x402.amountUsdc} USDC 결제</span>}
              {p.settleError && <span className="bad">정산 실패: {p.settleError}</span>}
              {p.unlockError && <span className="bad">열람 결제 실패: {p.unlockError}</span>}
              {p.ui === 'APPROVAL' && (
                <button className="cta bad" disabled={running} onClick={() => run(() => approvePurchase(p.requestId))}>
                  <Icon name="clipboard" size={13} /> 승인하기
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

import { useEffect, useState } from 'react';
import { fetchPurchaseReceipt } from '../api.js';
import { verdictInfo, fmtUsdc } from '../lib/derive.js';

/**
 * 구매 라운드 영수증 (콘티 v3 컷 8). "모든 판단과 정산이 기록으로 남는다".
 *
 * 세 건을 나란히 놓고 각 건마다 **판정(무엇으로 갈렸나)과 결말(그래서 어떻게 됐나)을 함께**
 * 보여준다. 티어만 적으면 대기 중인 건과 끝난 건이 같아 보이고, 결말만 적으면 정책이 왜
 * 그렇게 갈랐는지가 사라진다.
 *
 * 금액은 실제로 나간 것만 합산한다 — 대기·거부 건을 합계에 넣으면 영수증이 거짓을 말한다.
 */

/** 결말 라벨. 판정(티어)과 층이 달라 색도 따로 준다. */
const OUTCOME = {
  settled: { cls: 'ok', label: '정산 완료' },
  executed: { cls: 'ok', label: '실행됨 · 정산 대기' },
  waiting: { cls: 'warn', label: '대기 중' },
  rejected: { cls: 'bad', label: '거부됨' },
  denied: { cls: 'bad', label: '정책 거부' },
  settle_failed: { cls: 'bad', label: '정산 실패' },
};

const short = (s, n = 16) => (s ? `${String(s).slice(0, n)}…` : '—');

export default function PurchaseReceipt({ onBack }) {
  const [receipt, setReceipt] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    const tick = () => {
      fetchPurchaseReceipt()
        .then((d) => { if (alive) { setReceipt(d); setError(null); } })
        .catch((e) => { if (alive) setError(e.message); });
    };
    tick();
    const id = setInterval(tick, 2000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  if (error || !receipt) {
    return (
      <div className="stage">
        <div className="sec-h">
          <h2>구매 영수증</h2>
          <button className="cta ghost" onClick={onBack}>← 돌아가기</button>
        </div>
        <p className="pol">{error ? '아직 라운드 기록이 없습니다. 구매 라운드를 먼저 실행하세요.' : '불러오는 중…'}</p>
      </div>
    );
  }

  const t = receipt.totals;

  return (
    <div className="stage">
      <div className="sec-h">
        <h2>구매 영수증</h2>
        <button className="cta ghost" onClick={onBack}>← 돌아가기</button>
      </div>

      <p className="pol">
        정책: <b>{receipt.policy.note}</b> · {receipt.network} · phase {receipt.phase}
      </p>

      <div className="rc-sum">
        <div><span className="l">요청</span><span className="v tnum">{t.requested}건</span></div>
        <div><span className="l">정산 완료</span><span className="v tnum">{t.settled}건</span></div>
        <div><span className="l">실제 지출</span><span className="v tnum">{fmtUsdc(t.spentUsdc)} USDC</span></div>
        <div><span className="l">열람 결제(x402)</span><span className="v tnum">{fmtUsdc(t.x402Usdc)} USDC</span></div>
        <div><span className="l">셀러 잔고</span><span className="v tnum">{t.sellerUsdc ?? '—'} USDC</span></div>
      </div>

      {receipt.purchases.map((p) => {
        const v = verdictInfo(p.verdict);
        const o = OUTCOME[p.outcome] ?? { cls: 'pending', label: p.outcome };
        return (
          <div className="buy" key={p.requestId}>
            <div className="buy-h">
              <div>
                <div className="t">{p.request.title}</div>
                <div className="s">{p.listing.title} · {p.listing.seller} · {fmtUsdc(p.amountUsdc)} USDC</div>
              </div>
              <div className="rc-badges">
                <span className={`pill ${v.cls}`}><span className="d" />{v.label}</span>
                <span className={`pill ${o.cls}`}><span className="d" />{o.label}</span>
              </div>
            </div>

            <div className="buy-why">{p.decision.reason}</div>
            {p.error && <div className="buy-rej">오류: {p.error}</div>}

            <div className="rc-grid">
              <div><span className="k">auction</span><span className="tx">#{p.auctionId ?? '—'}</span></div>
              <div><span className="k">commit</span><span className="tx">{short(p.tx.commit)}</span></div>
              <div><span className="k">deposit</span><span className="tx">{short(p.tx.deposit)}</span></div>
              <div><span className="k">reveal</span><span className="tx">{short(p.tx.reveal)}</span></div>
              <div><span className="k">settle</span><span className="tx">{short(p.tx.settle)}</span></div>
              <div><span className="k">결과물 hash</span><span className="tx">{short(p.result?.hash, 20)}</span></div>
              {p.x402 && (
                <div><span className="k">x402 서명</span><span className="tx">{short(p.x402.onchainSignature, 20)}</span></div>
              )}
              {p.approvedAt && (
                <div><span className="k">승인 시각</span><span className="tx">{p.approvedAt.slice(11, 19)}</span></div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

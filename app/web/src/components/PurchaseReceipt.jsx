import { useEffect, useState } from 'react';
import { fetchPurchaseReceipt } from '../api.js';
import { verdictInfo, fmtUsdc } from '../lib/derive.js';
import { navigate } from '../lib/router.js';
import Stepper from './Stepper.jsx';
import TxLink from './TxLink.jsx';
import { ClusterContext } from '../lib/explorer.js';

/**
 * 구매 라운드 영수증 (콘티 v3 컷 8). "모든 판단과 정산이 기록으로 남는다".
 *
 * 각 건마다 **판정(무엇으로 갈렸나)과 결말(그래서 어떻게 됐나)을 함께** 보여준다. 티어만
 * 적으면 대기 중인 건과 끝난 건이 같아 보이고, 결말만 적으면 정책이 왜 그렇게 갈랐는지가
 * 사라진다.
 *
 * 금액은 실제로 나간 것만 합산한다 — 대기·거부 건을 합계에 넣으면 영수증이 거짓을 말한다.
 *
 * **목록과 상세를 나눈다(8/20 리허설).** 전에는 건마다 온체인 해시 7칸을 모두 펼쳐 놓아,
 * 거부된 건(해시가 애초에 없다)까지 빈 칸 `—`로 자리를 차지했다. 화면의 절반이 "없음"을
 * 표시하는 데 쓰였고, 실제로 산 건이 거부된 건에 묻혔다. 맡긴 일과 같은 목록 → 상세
 * 패턴으로 맞춘다 — 심사위원이 한 번 익힌 조작이 두 화면에서 그대로 통한다.
 *
 * 펼치기(아코디언) 대신 페이지를 나눈 이유는 상태를 컴포넌트가 들지 않아도 되기 때문이다.
 * 열림 상태를 `useState` 초기값으로 잡았다가 파생 상태가 굳어 버린 전례가 있다(8/20
 * PurchaseList). URL이 상태면 그 함정 자체가 없고 새로고침·뒤로가기가 공짜로 따라온다.
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

const outcomeOf = (p) => OUTCOME[p.outcome] ?? { cls: 'pending', label: p.outcome };

/**
 * @param {Function} [fetcher] - 영수증 소스. 기본은 공용 데모 라운드이고, 사용자 화면은
 *   자기 라운드(`/api/u/...`)를 넘긴다 — 같은 조립 형식이라 표시부는 하나로 쓴다.
 * @param {string|null} [requestId] - 있으면 그 건의 상세, 없으면 목록.
 */
export default function PurchaseReceipt({ onBack, fetcher = fetchPurchaseReceipt, requestId = null }) {
  const [receipt, setReceipt] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    const tick = () => {
      fetcher()
        .then((d) => { if (alive) { setReceipt(d); setError(null); } })
        .catch((e) => { if (alive) setError(e.message); });
    };
    tick();
    const id = setInterval(tick, 2000);
    return () => { alive = false; clearInterval(id); };
  }, [fetcher]);

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

  const picked = requestId ? receipt.purchases.find((p) => p.requestId === requestId) : null;

  // ── 상세: 한 건만 놓고 그 건의 증거를 전부 편다 ──────────────────────────
  if (requestId) {
    return (
      <ClusterContext.Provider value={receipt.network || 'devnet'}>
        <div className="stage">
          <div className="sec-h">
            <h2>{picked ? picked.request.title : '영수증'}</h2>
            <button className="cta ghost" onClick={onBack}>← 영수증으로</button>
          </div>
          {picked
            ? <ReceiptDetail p={picked} />
            : <p className="pol">그 건의 기록을 찾지 못했습니다. 목록에서 다시 골라 주세요.</p>}
        </div>
      </ClusterContext.Provider>
    );
  }

  // ── 목록: 합계와 시간순 원장. 건별 증거는 상세로 넘긴다 ──────────────────
  const t = receipt.totals;

  return (
    <ClusterContext.Provider value={receipt.network || 'devnet'}>
    <div className="stage">
      <div className="sec-h">
        <h2>구매 영수증</h2>
        <button className="cta ghost" onClick={onBack}>← 돌아가기</button>
      </div>

      {/* 영수증이 스테퍼의 마지막 칸이다. 여기서 렌더하지 않으면 그 칸은 어떤 경로로도
          도달하지 않는 장식이 된다(감사 발견 5). */}
      <Stepper current="receipt" />

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

      {/* 순서는 시간순 그대로 둔다. 목록(맡긴 일)은 최신이 위지만 원장은 벌어진 순서가
          곧 기록이다 — 둘이 다른 것은 의도다(8/20 결정). */}
      {receipt.purchases.map((p) => (
        <ReceiptRow key={p.requestId} p={p} />
      ))}
    </div>
    </ClusterContext.Provider>
  );
}

/** 목록 한 줄. 맡긴 일 목록(`TaskRow`)과 같은 모양이라 조작을 다시 익힐 필요가 없다. */
function ReceiptRow({ p }) {
  const v = verdictInfo(p.verdict);
  const o = outcomeOf(p);
  const open = () => navigate(`#/receipt/${p.requestId}`);

  return (
    <article
      className="buy buy-row"
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => e.key === 'Enter' && open()}
    >
      <div className="buy-h">
        <div className="t">{p.request.title}</div>
        <span className="buy-mini">{p.listing.title}</span>
        <span className="buy-mini tnum">{fmtUsdc(p.amountUsdc)} USDC</span>
        <span className={`pill ${v.cls}`}><span className="d" />{v.label}</span>
        <span className={`pill ${o.cls}`}><span className="d" />{o.label}</span>
        {/* 거래 기록만 있고 품질 기록이 없으면 "무엇을 샀는지"의 절반이 빠진다. */}
        {p.grade && <span className="pill gold"><span className="d" />채점 {p.grade.score}</span>}
        <span className="buy-caret" aria-hidden="true">›</span>
      </div>
    </article>
  );
}

/** 상세. 이 건에 실제로 있는 것만 편다 — 없는 단계는 자리도 만들지 않는다. */
function ReceiptDetail({ p }) {
  const v = verdictInfo(p.verdict);
  const o = outcomeOf(p);
  // 거부된 건은 commit 이후 트랜잭션이 아예 존재하지 않는다. 전에는 그 자리를 `—`로 채워
  // 화면의 절반이 "없음"을 표시하는 데 쓰였다.
  const rows = [
    ['auction', <span className="tx">#{p.auctionId ?? '—'}</span>, p.auctionId != null],
    // 온체인 5단계 중 createAuction만 빠져 있었다. 진행 화면은 5단계를 보여주는데
    // 영수증이 4개만 남기면 "전부 온체인에 있다"는 주장에 구멍이 생긴다.
    ['거래 개설', <TxLink sig={p.tx?.createAuction} />, !!p.tx?.createAuction],
    ['commit', <TxLink sig={p.tx?.commit} />, !!p.tx?.commit],
    ['deposit', <TxLink sig={p.tx?.deposit} />, !!p.tx?.deposit],
    ['reveal', <TxLink sig={p.tx?.reveal} />, !!p.tx?.reveal],
    ['settle', <TxLink sig={p.tx?.settle} />, !!p.tx?.settle],
    ['결과물 hash', <span className="tx">{short(p.result?.hash, 14)}</span>, !!p.result?.hash],
    ['x402 서명', <TxLink sig={p.x402?.onchainSignature} />, !!p.x402],
    ['승인 시각', <span className="tx">{p.approvedAt?.slice(11, 19)}</span>, !!p.approvedAt],
  ].filter(([, , has]) => has);

  return (
    <div className="buy">
      <div className="buy-h">
        <div>
          <div className="t">{p.listing.title}</div>
          <div className="s">{p.listing.seller} · {fmtUsdc(p.amountUsdc)} USDC</div>
        </div>
        <div className="rc-badges">
          <span className={`pill ${v.cls}`}><span className="d" />{v.label}</span>
          <span className={`pill ${o.cls}`}><span className="d" />{o.label}</span>
          {p.grade && <span className="pill gold"><span className="d" />채점 {p.grade.score}</span>}
        </div>
      </div>

      <div className="buy-why">{p.decision.reason}</div>
      {p.grade?.ratingAfter != null && (
        <div className="buy-rej">
          이 결과물 채점 {p.grade.score}점 · {p.listing.seller} 평점 {p.grade.ratingBefore} → {p.grade.ratingAfter}
        </div>
      )}
      {p.error && <div className="buy-rej">오류: {p.error}</div>}

      {p.onchain?.sellerBefore != null && p.onchain?.sellerUsdc != null && (
        <div className="rc-move">
          <span className="mv-k">셀러 잔액 · 온체인 실측</span>
          <span className="mv-v">
            <b className="tnum">{fmtUsdc(p.onchain.sellerBefore)}</b>
            <span className="mv-ar">→</span>
            <b className="tnum">{fmtUsdc(p.onchain.sellerUsdc)}</b>
            <span className="mv-u">USDC</span>
            <span className="mv-d">+{fmtUsdc(p.onchain.sellerUsdc - p.onchain.sellerBefore)}</span>
          </span>
        </div>
      )}

      <div className="rc-grid">
        {rows.map(([k, node]) => (
          <div key={k}><span className="k">{k}</span>{node}</div>
        ))}
      </div>
      {rows.length <= 1 && (
        <p className="svc-hint">이 건은 거부되어 정산 트랜잭션이 남지 않았습니다.</p>
      )}
    </div>
  );
}

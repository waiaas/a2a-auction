import { useEffect, useState } from 'react';
import { fetchReceipt, fetchResult } from '../api.js';
import { orderedBuyers, truncTx, fmtUsdc, verdictShort, friendlyDenyReason } from '../lib/derive.js';

/** commit·deposit 행에 쓰는 짧은 라벨(receipt는 role만 담고 이모지는 안 담음). */
const SHORT = { 'buyer-a': '📊 A', 'buyer-b': '🚀 B', 'buyer-c': '🧪 C' };
const short = (role) => SHORT[role] || role;

/**
 * 화면 2: Receipt / Audit 뷰 (스펙 6장). 정산된 라운드의 증거 체인을 한 화면에서 연결하고,
 * 온체인 정산이 확인된 뒤에만 열리는 결과물을 seller(:4100)에서 받아 노출한다.
 * receipt는 오케스트레이터가 계산한 값을 그대로 쓰고, mandate 요약만 폴링 state에서 가져온다.
 */
export default function Receipt({ state, onBack }) {
  const settled = state.phase === 'settled';
  const [receipt, setReceipt] = useState(null);
  const [result, setResult] = useState(null);
  const [loadErr, setLoadErr] = useState(null);

  // receipt(오케스트레이터)와 result(seller)를 독립 로드한다 — seller가 잠깐 블립해도 증거 체인은 떠야 한다.
  useEffect(() => {
    if (!settled || state.auctionId == null) return;
    let alive = true;
    fetchReceipt()
      .then((rc) => { if (alive) setReceipt(rc); })
      .catch((e) => { if (alive) setLoadErr(e.message); });
    fetchResult(state.auctionId)
      .then((rs) => { if (alive) setResult(rs); })
      .catch((e) => { if (alive) setResult({ unreachable: true, reason: e.message }); });
    return () => { alive = false; };
  }, [settled, state.auctionId]);

  if (!settled) return <NotSettled onBack={onBack} phase={state.phase} />;

  const buyers = orderedBuyers(state.buyers);
  const decisions = receipt?.depositDecisions || [];
  const depA = decisions.find((d) => d.buyer === 'buyer-a');

  return (
    <div className="rcpt">
      <div className="rcpt-top">
        <button className="back" onClick={onBack}>← Live 경매로</button>
        <div className="rtitle">Settlement Receipt</div>
        <span className="pill gold"><span className="d" />
          Auction {receipt ? `#${receipt.auctionId}` : '—'} · Settled
        </span>
      </div>

      {!receipt && !loadErr && <div className="panel glass empty-rcpt"><div className="er-s">증거 체인 불러오는 중…</div></div>}
      {loadErr && <div className="errbar">Receipt 로드 오류: {loadErr}</div>}

      {receipt && (
        <div className="rcpt-main">
          {/* ---- 좌: 증거 체인 ---- */}
          <div className="panel glass chain">
            <div className="ph">🔗 증거 체인 · commit → 판정 → 예치 → settle → result</div>

            <Step n="1" title="Mandate · 위임 지침">
              <div className="mtask">위임 태스크: {state.item?.task || receipt.item?.task || '—'}</div>
              {buyers.map((b) => (
                <div className="mrow" key={b.role}>
                  <span className="me">{b.emoji}</span><b>{b.name}</b>
                  <span className="mchip">{b.mandateChip}</span>
                </div>
              ))}
            </Step>

            <Step n="2" title="Commit · 입찰 해시 온체인 기록 (금액 은닉)">
              {receipt.commitTxSignatures.map((c) => (
                <div className="trow" key={c.buyer}>
                  <span className="who">{short(c.buyer)}</span><Tx sig={c.txHash} />
                </div>
              ))}
            </Step>

            <Step n="3" title="Policy Decision · 예치 정책 판정 3건">
              {decisions.map((d) => {
                const v = verdictShort(d.decision);
                return (
                  <div className="drow" key={d.buyer}>
                    <span className="who">{short(d.buyer)}</span>
                    <span className={`pill ${v.cls}`}><span className="d" />{v.label}</span>
                    <span className="req" title={d.txId || ''}>req {truncTx(d.txId, 5, 4) || '—'}</span>
                    {d.txHash
                      ? <Tx sig={d.txHash} />
                      : <span className="tx dim">{d.decision === 'DENY' ? '거부' : d.status || '—'}</span>}
                    {d.inPending && <span className="tag warn">승인 큐</span>}
                  </div>
                );
              })}
            </Step>

            <Step n="4" title="Escrow Deposit · 낙찰자 A 온체인 예치">
              <div className="trow">
                <Tx sig={depA?.txHash} label="deposit" />
                <span className="amt">{fmtUsdc(receipt.bidAmountUsdc)} USDC → vault</span>
              </div>
            </Step>

            <Step n="5" title="Settlement · create → reveal → settle">
              <div className="trow"><span className="who">create</span><Tx sig={receipt.createAuctionTx} /></div>
              <div className="trow"><span className="who">reveal A</span><Tx sig={receipt.revealTx} /></div>
              <div className="trow"><span className="who">settle</span><Tx sig={receipt.settleTx} /></div>
              <div className="samt">
                vault → seller <b>{fmtUsdc(receipt.settlement?.sellerUsdc)}</b> USDC · vault 잔액 {fmtUsdc(receipt.settlement?.vaultUsdc)}
              </div>
            </Step>

            <Step n="6" title="Result Hash · seller가 정산 확인 후 unlock">
              <div className="trow">
                <span className="tx tap" title={receipt.resultHash || ''} onClick={() => copy(receipt.resultHash)}>
                  {truncTx(receipt.resultHash, 10, 8) || '—'}
                </span>
                <span className="src">{receipt.resultSource === 'live' ? 'Gemini live' : '캐시 폴백'}</span>
              </div>
            </Step>

            {receipt.budget && (
              <Step n="7" title="Budget · 낙찰자 A 위임 한도">
                <div className="budget">
                  <span>건당 위임 한도 <b>{fmtUsdc(receipt.budget.delegatedLimitUsdc)}</b></span>
                  <span>이번 지출 <b>{fmtUsdc(receipt.budget.spentUsdc)}</b></span>
                  <span className="rem">잔여 <b>{fmtUsdc(receipt.budget.remainingUsdc)}</b></span>
                </div>
              </Step>
            )}
          </div>

          {/* ---- 우: Result unlock ---- */}
          <div className="panel glass unlock">
            <div className="ph">🔓 Result Unlock · 온체인 정산 후 공개</div>
            <div className="ubody"><Unlock result={result} resultHash={receipt.resultHash} /></div>
          </div>
        </div>
      )}

      {/* ---- 하단: 데몬별 감사 로그 원본 ---- */}
      {receipt && (
        <div className="panel glass audit">
          <div className="ph">🗂️ 데몬별 감사 로그 원본 · 각자의 지갑, 각자의 기록</div>
          <div className="audgrid">
            {buyers.map((b) => {
              const d = decisions.find((x) => x.buyer === b.role);
              const c = receipt.commitTxSignatures.find((x) => x.buyer === b.role);
              const v = verdictShort(b.ui ?? d?.decision);
              return (
                <div className="audcard" key={b.role}>
                  <div className="ah"><span className="me">{b.emoji}</span><b>{b.name}</b>
                    <span className={`pill ${v.cls}`}><span className="d" />{v.label}</span></div>
                  <div className="arow"><span>waiaas req</span><span className="mono">{truncTx(d?.txId, 6, 5) || '—'}</span></div>
                  <div className="arow"><span>commit</span><Tx sig={c?.txHash} /></div>
                  <div className="arow"><span>deposit</span>{d?.txHash ? <Tx sig={d.txHash} /> : <span className="tx dim">{d?.status || '—'}</span>}</div>
                  <div className="arow"><span>tier · status</span><span className="mono">{(d?.tier || '-')} · {(d?.status || '-')}</span></div>
                  {d?.error && <div className="aerr" title={d.error}>{friendlyDenyReason(d.error)}</div>}
                  {d?.inPending && <div className="apend">📱 owner 승인 큐 등재</div>}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/** 증거 체인 스텝 하나(번호 배지 + 제목 + 내용). */
function Step({ n, title, children }) {
  return (
    <div className="cstep">
      <div className="cn">{n}</div>
      <div className="cbody">
        <div className="ct">{title}</div>
        <div className="cc">{children}</div>
      </div>
    </div>
  );
}

/** 서명 칩(클릭 시 클립보드 복사). 값 없으면 dim 대시. */
function Tx({ sig, label }) {
  if (!sig) return <span className="tx dim">—</span>;
  return (
    <span className="tx tap" title={sig} onClick={() => copy(sig)}>
      {label ? `${label} ` : ''}{truncTx(sig)}
    </span>
  );
}

function copy(text) {
  if (text) navigator.clipboard?.writeText(text).catch(() => {});
}

/** result unlock 본문: 로딩 / 연결 실패 / 잠김(403 정책) / unlock(200 + 마크다운). */
function Unlock({ result, resultHash }) {
  if (!result) return <div className="er-s">결과물 불러오는 중…</div>;
  if (result.unreachable) {
    // seller 도달 불가(502/503) — 정책 잠금과 구분한다. 정산 자체는 완료됐으므로 접근권 실패가 아니다.
    return (
      <div className="locked">
        <div className="lk-ic">🔌</div>
        <div className="lk-t">결과 서비스에 연결할 수 없음</div>
        <div className="lk-s">seller(:4100) 응답 없음: {result.reason}. 정산은 완료됐으나 결과물 조회에 일시 실패했습니다.</div>
      </div>
    );
  }
  if (result.locked) {
    return (
      <div className="locked">
        <div className="lk-ic">🔒</div>
        <div className="lk-t">정산 전 잠김</div>
        <div className="lk-s">사유: {result.reason || 'not_settled'} · 온체인 정산 증명 없이는 결과물이 열리지 않습니다.</div>
      </div>
    );
  }
  const hashMatch = resultHash && result.result?.hash === resultHash;
  return (
    <div className="unlocked">
      <div className="uhead">
        <span className="pill ok"><span className="d" />🔓 unlock · 낙찰자 {result.unlockedForBuyerId}</span>
        <span className="uwin mono" title={result.winner}>winner {truncTx(result.winner, 5, 4)}</span>
      </div>
      <div className="uhash">
        <span className="mono">{truncTx(result.result?.hash, 8, 6)}</span>
        <span className={`tag ${hashMatch ? 'ok' : 'warn'}`}>{hashMatch ? 'hash ✓ receipt 일치' : 'hash 대조'}</span>
        <span className="src">{result.result?.source === 'live' ? 'Gemini live' : '캐시 폴백'}</span>
      </div>
      <div className="unote">정산 전에는 누구에게도 열리지 않습니다. seller는 온체인 Settled·winner를 직접 확인한 뒤에만 응답합니다.</div>
      <div className="md">{renderMarkdown(result.result?.contentMarkdown || '')}</div>
    </div>
  );
}

/** 의존성 없는 경량 마크다운 → React 엘리먼트. 헤딩(#/##)·인용(>)·불릿(-/*)·굵게(**)·문단만 처리. */
function renderMarkdown(md) {
  const out = [];
  let list = null;
  const flush = (key) => { if (list) { out.push(<ul key={`ul-${key}`}>{list}</ul>); list = null; } };
  md.split('\n').forEach((line, i) => {
    if (/^##\s/.test(line)) { flush(i); out.push(<h4 key={i}>{inline(line.replace(/^##\s/, ''))}</h4>); }
    else if (/^#\s/.test(line)) { flush(i); out.push(<h3 key={i}>{inline(line.replace(/^#\s/, ''))}</h3>); }
    else if (/^>\s/.test(line)) { flush(i); out.push(<blockquote key={i}>{inline(line.replace(/^>\s/, ''))}</blockquote>); }
    else if (/^[-*]\s/.test(line)) { if (!list) list = []; list.push(<li key={i}>{inline(line.replace(/^[-*]\s/, ''))}</li>); }
    else if (line.trim() === '') { flush(i); }
    else { flush(i); out.push(<p key={i}>{inline(line)}</p>); }
  });
  flush('end');
  return out;
}

/** 인라인 **굵게**만 React 조각으로. 나머지는 평문(XSS 안전). */
function inline(text) {
  return text.split(/(\*\*[^*]+\*\*)/g).map((p, i) =>
    /^\*\*[^*]+\*\*$/.test(p) ? <strong key={i}>{p.slice(2, -2)}</strong> : p);
}

/** 아직 정산 안 됨: Live로 유도. */
function NotSettled({ onBack, phase }) {
  return (
    <div className="rcpt">
      <div className="rcpt-top">
        <button className="back" onClick={onBack}>← Live 경매로</button>
        <div className="rtitle">Settlement Receipt</div>
      </div>
      <div className="panel glass empty-rcpt">
        <div className="er-ic">🧾</div>
        <div className="er-t">아직 정산된 라운드가 없습니다</div>
        <div className="er-s">현재 상태: {phase}. Live 경매에서 <b>Start Round</b>로 완주하면 증거 체인이 여기 조립됩니다.</div>
        <button className="cta" onClick={onBack}>Live 경매로 가기 ▶</button>
      </div>
    </div>
  );
}

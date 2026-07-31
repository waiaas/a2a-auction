import { useCallback, useEffect, useState } from 'react';
import { fetchOwnerPending, rejectOwnerTx } from '../api.js';
import Icon from './Icon.jsx';
import { fmtUsdc, truncTx } from '../lib/derive.js';

const POLL_MS = 2000;

/**
 * 화면 4: Owner 콘솔 (Growth Agent의 owner 시점). 에이전트가 위임 한도를 넘겨 승인 대기에
 * 걸린 지출을 사람이 직접 거부하는 화면 — "사람의 통제" 절반을 담당한다.
 *
 * 원래 이 기능은 WAIaaS 어드민 UI(:3101/admin)에 있다. 영상에서 오리진을 오가며 재로그인하지
 * 않도록 오케스트레이터가 어드민 API를 relay하며, 마켓플레이스가 남의 지갑을 통제하는 것처럼
 * 보이지 않게 화면에 owner 시점임과 인증 경로를 명시한다.
 */
export default function OwnerConsole({ onBack }) {
  const [data, setData] = useState(null);
  const [loadErr, setLoadErr] = useState(null);
  const [rejected, setRejected] = useState({}); // txId → true (폴링에서 사라진 뒤에도 결과 표시)
  const [busy, setBusy] = useState(null); // 거부 요청 중인 txId

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const d = await fetchOwnerPending();
        if (alive) { setData(d); setLoadErr(null); }
      } catch (e) {
        if (alive) setLoadErr(e.message);
      }
    };
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => { alive = false; clearInterval(id); };
  }, []);

  const onReject = useCallback(async (txId) => {
    setBusy(txId);
    try {
      await rejectOwnerTx(txId);
      setRejected((m) => ({ ...m, [txId]: true }));
    } catch { /* 폴링이 실제 상태를 보여준다 */ }
    finally { setBusy(null); }
  }, []);

  const pending = data?.pending || [];
  const hasQueue = pending.length > 0 || Object.keys(rejected).length > 0;

  return (
    <div className="rcpt">
      <div className="rcpt-top">
        <button className="back" onClick={onBack}><Icon name="back" size={14} />Live 경매로</button>
        <div className="rtitle">Owner Console</div>
        <span className={`pill ${pending.length ? 'warn' : 'pending'}`}><span className="d" />
          {data ? `${data.name}의 owner 시점` : '—'}
        </span>
      </div>

      {loadErr && <div className="errbar">데몬 연결 오류: {loadErr}</div>}

      <div className="sell-main">
        <div className="panel glass">
          <div className="ph"><Icon name="shield" size={14} />내 에이전트 · 위임한 권한</div>
          <div className="sell-body">
            <div className="own-agent">
              <div className="av"><Icon name="buyer-b" size={17} /></div>
              <div>
                <div className="nm">{data?.name || 'Growth Agent'}</div>
                <div className="md">{data?.mandateChip || '—'}</div>
              </div>
            </div>

            <div className="sell-h">지출 정책 (WAIaaS 데몬에 등록됨)</div>
            <div className="sell-meta">
              <div><span>건당 위임 한도</span><b>{data ? `${fmtUsdc(data.limitUsdc)} USDC` : '—'}</b></div>
              <div><span>한도 초과 시</span><b>owner 승인 필요 (자동 실행 금지)</b></div>
              <div><span>승인 없이 방치 시</span><b>만료 → 실행되지 않음</b></div>
            </div>

            <div className="unote own-note">
              단일 화면 데모를 위해 오케스트레이터가 owner의 마스터 인증을 대행해
              {data?.name || 'B'}의 WAIaaS 데몬에 접근합니다. 실제 운영에서는 owner가 자신의
              데몬 콘솔에서 직접 수행하며, 온체인 경매 프로그램과 seller는 이 권한을 갖지 않습니다.
            </div>
          </div>
        </div>

        <div className="panel glass">
          <div className="ph"><Icon name="clipboard" size={14} />승인 대기 큐</div>
          <div className="sell-body">
            {!hasQueue ? (
              <div className="sell-open">
                <div className="lk-ic"><Icon name="clipboard" size={34} /></div>
                <div className="lk-t">대기 중인 승인 요청이 없습니다</div>
                <div className="lk-s">
                  에이전트가 위임 한도를 넘는 지출을 시도하면 여기 등재됩니다.
                  Live 경매에서 라운드를 시작해 보세요.
                </div>
              </div>
            ) : (
              <>
                {pending.map((t) => (
                  <div className="own-item" key={t.id}>
                    <div className="own-row">
                      <span className="a tnum">{fmtUsdc(t.amountUsdc)}<u>USDC</u></span>
                      <span className={`pill ${rejected[t.id] ? 'bad' : 'warn'}`}><span className="d" />
                        {rejected[t.id] ? 'CANCELLED' : t.tier || t.status}
                      </span>
                    </div>
                    <div className="own-sub">
                      수신처 <span className="mono" title={t.toAddress || ''}>{truncTx(t.toAddress, 5, 4) || '—'}</span>
                      {' · '}위임 한도 {data ? fmtUsdc(data.limitUsdc) : '—'} USDC 초과
                    </div>
                    {!rejected[t.id] && (
                      <button className="cta bad" onClick={() => onReject(t.id)} disabled={busy === t.id}>
                        {busy === t.id ? '거부 중…' : '거부 (실행 금지)'}
                      </button>
                    )}
                  </div>
                ))}
                {Object.keys(rejected).filter((id) => !pending.some((t) => t.id === id)).map((id) => (
                  <div className="own-item done" key={id}>
                    <div className="own-row">
                      <span className="own-done"><Icon name="locked" size={13} />거부됨 · 실행되지 않음</span>
                      <span className="pill bad"><span className="d" />CANCELLED</span>
                    </div>
                    <div className="own-sub">req <span className="mono">{truncTx(id, 6, 5)}</span> · 에이전트는 이 지출을 집행할 수 없습니다</div>
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

import { useCallback, useState } from 'react';
import { openAuction, resetAuction } from '../api.js';
import Icon from './Icon.jsx';
import { executableWinner, fmtUsdc, phaseLabel, statusPill, truncTx } from '../lib/derive.js';

/**
 * 화면 3: 판매자 콘솔 (스펙 7장 장면 2). 판매자 에이전트가 등록해 둔 작업을 확인하고 경매를 연다.
 * 개설 이후의 입찰·판정·정산은 Live 경매 화면이 담당하고, 여기서는 낙찰 결과만 되돌려 받는다.
 *
 * 온체인 Auction 계정에는 마감 시각도 낙찰자 지정 기능도 없다 — 입찰 마감은 운영자가 진행하고
 * 낙찰자는 reveal된 최고 유효 입찰가로 결정된다. 화면이 그 이상을 약속하지 않게 한다.
 */
export default function SellerConsole({ state, onBack }) {
  const [opening, setOpening] = useState(false);
  const item = state.item;
  const sp = statusPill(state.phase);
  const isOpened = state.auctionId != null && state.phase !== 'idle' && state.phase !== 'opening';
  const isSettled = state.phase === 'settled';
  // 라운드가 끝났거나(settled) 죽었으면(error) reset 없이는 새 경매를 못 연다 —
  // /api/auction/open이 idle 외 상태를 409로 거절하기 때문(감사 F3: 버튼이 무반응으로 죽음).
  const canPrepareNext = state.phase === 'settled' || state.phase === 'error';
  const winner = executableWinner(state);

  const onOpen = useCallback(async () => {
    setOpening(true);
    try { await openAuction(); } catch { /* 폴링이 상태를 갱신한다 */ }
    finally { setOpening(false); }
  }, []);

  const onPrepareNext = useCallback(async () => {
    try { await resetAuction(); } catch { /* 폴링이 상태를 갱신한다 */ }
  }, []);

  return (
    <div className="rcpt">
      <div className="rcpt-top">
        <button className="back" onClick={onBack}><Icon name="back" size={14} />Live 경매로</button>
        <div className="rtitle">Seller Console</div>
        <span className={`pill ${sp.cls}`}><span className="d" />{sp.label}</span>
      </div>

      <div className="sell-main">
        <div className="panel glass">
          <div className="ph"><Icon name="seller" size={14} />등록한 작업 · {item?.seller || 'Research Specialist Agent'}</div>
          <div className="sell-body">
            <h3 className="sell-title">{item?.title || '—'}</h3>
            <div className="sell-task">위임 태스크: {item?.task || '—'}</div>

            <div className="sell-h">제공 가능한 능력</div>
            <ul className="sell-cap">
              {(item?.capabilities || []).map((c) => (
                <li key={c}><Icon name="shield" size={13} />{c}</li>
              ))}
            </ul>

            <div className="sell-h">경매 조건</div>
            <div className="sell-meta">
              <div><span>결제 토큰</span><b>USDC</b></div>
              <div><span>입찰 방식</span><b>{item?.biddingWindow || '—'}</b></div>
              <div><span>정산</span><b>온체인 에스크로 · vault → seller</b></div>
            </div>
          </div>
        </div>

        <div className="panel glass">
          <div className="ph"><Icon name="chain" size={14} />경매 개설 · 낙찰 확인</div>
          <div className="sell-body">
            {!isOpened ? (
              <div className="sell-open">
                <div className="lk-ic"><Icon name="clipboard" size={34} /></div>
                <div className="lk-t">{canPrepareNext ? '경매 개설에 실패했습니다' : '아직 열린 경매가 없습니다'}</div>
                <div className="lk-s">
                  {canPrepareNext
                    ? `오류: ${state.error || '알 수 없는 오류'} · 환경 확인 후 정리하고 다시 열 수 있습니다.`
                    : '경매를 열면 작업이 플랫폼에 공개되고, 정책을 위임받은 구매자 에이전트들이 입찰할 수 있습니다.'}
                </div>
                {canPrepareNext ? (
                  <button className="cta ghost" onClick={onPrepareNext}>이전 라운드 정리 후 다시 열기</button>
                ) : (
                  <button className="cta" onClick={onOpen} disabled={opening || state.phase === 'opening'}>
                    {opening || state.phase === 'opening' ? '개설 중…' : <>경매 오픈<Icon name="play" size={15} /></>}
                  </button>
                )}
              </div>
            ) : (
              <>
                <div className="sell-open-head">
                  <span className="pill ok"><span className="d" />Auction #{state.auctionId} 개설됨</span>
                  <span className="src">{phaseLabel(state.phase)}</span>
                </div>
                <div className="sell-meta">
                  <div><span>경매 계정</span><b className="mono">{truncTx(state.addresses?.auctionPda) || '—'}</b></div>
                  <div><span>에스크로 vault</span><b className="mono">{truncTx(state.addresses?.vault) || '—'}</b></div>
                  <div><span>create tx</span><b className="mono">{truncTx(state.steps?.createAuction?.txHash) || '—'}</b></div>
                </div>

                {isSettled ? (
                  <div className="sell-win">
                    <div className="sell-h">낙찰 결과</div>
                    <div className="sell-wrow">
                      <span className="wname">
                        <Icon name="trophy" size={15} />{winner ? winner.name : '낙찰자 없음'}
                      </span>
                      <span className="a tnum">{winner ? fmtUsdc(winner.highestUsdc) : '—'}<u>USDC</u></span>
                    </div>
                    <div className="lk-s">
                      최고 입찰가가 아니라 정책을 통과한 최고 입찰가가 낙찰됐습니다. 상세 증거는 Receipt에서 확인합니다.
                    </div>
                    <button className="cta ghost" onClick={onPrepareNext}>다음 경매 준비 (새 라운드)</button>
                  </div>
                ) : canPrepareNext ? (
                  <div className="sell-wait">
                    <div className="lk-s">라운드가 오류로 종료됐습니다. 정리 후 새 경매를 열 수 있습니다.</div>
                    <button className="cta ghost" onClick={onPrepareNext}>이전 라운드 정리 후 다시 열기</button>
                  </div>
                ) : (
                  <div className="sell-wait">
                    <div className="lk-s">
                      Live 경매 화면에서 <b>Start Round</b>를 누르면 구매자 에이전트들의 입찰이 시작됩니다.
                      입찰 마감은 운영자가 진행합니다.
                    </div>
                    <button className="cta ghost" onClick={onBack}>Live 경매로 가기<Icon name="next" size={15} /></button>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

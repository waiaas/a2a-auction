import { executableWinner, rawHighest, fmtUsdc, isRunning } from '../lib/derive.js';

/** 좌측 가격 블록: 낙찰가 · RAW→EXECUTABLE · Start Round · 반전 문구. */
export default function PriceBlock({ state, onStart, starting }) {
  const winner = executableWinner(state);
  const raw = rawHighest(state.buyers);
  const running = isRunning(state.phase) || starting;
  const showNote = winner && raw && raw.bidUsdc > winner.highestUsdc;

  return (
    <div className="price">
      <div className="l">Executable Winner ★</div>
      <div className={`big tnum ${winner ? '' : 'pending'}`}>
        {winner ? fmtUsdc(winner.highestUsdc) : '—'}<u>USDC</u>
      </div>
      <div className="reveal">
        <span>Raw Highest <b className="raw">{raw ? fmtUsdc(raw.bidUsdc) : '—'}</b></span>
        <span>→</span>
        <span className="ex">Executable {winner ? fmtUsdc(winner.highestUsdc) : '—'}</span>
      </div>
      <div className="actions">
        <button className="cta" onClick={onStart} disabled={running}>
          {running ? '진행 중…' : 'Start Round ▶'}
        </button>
        <div className="icirc" aria-hidden="true">🧾</div>
        <div className="icirc" aria-hidden="true">⛓️</div>
      </div>
      <div className="note">
        {showNote && `최고가 ${fmtUsdc(raw.bidUsdc)} USDC는 예치조차 못 했습니다. 권한 있는 bid만 실행됩니다.`}
      </div>
    </div>
  );
}

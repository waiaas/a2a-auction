import Icon from './Icon.jsx';
import { executableWinner, rawHighest, fmtUsdc, truncTx } from '../lib/derive.js';

/** 하단 온체인 스펙 타일 6개(CARBIDDE 스펙 타일 대응). settled 전엔 대기 표시. */
export default function SpecTiles({ state }) {
  const winner = executableWinner(state);
  const raw = rawHighest(state.buyers);
  const settled = state.phase === 'settled';
  const program = truncTx(state.addresses?.programId) || '—';
  const winnerName = winner
    ? <span className="wname"><Icon name={winner.role} size={14} />{winner.name.split(' ')[0]}</span>
    : '—';

  return (
    <div className="specs">
      <Spec ic="trophy" l="Winner" v={winnerName} dim={!winner} />
      <Spec ic="coins" l="Winning Bid" v={winner ? fmtUsdc(winner.highestUsdc) : '—'} acc={!!winner} dim={!winner} />
      <Spec ic="trend" l="Raw Highest" v={raw ? fmtUsdc(raw.bidUsdc) : '—'} dim={!raw} />
      <Spec ic="bank" l="Settlement" v={settled ? 'vault→seller' : '대기'} dim={!settled} />
      <Spec ic="chain" l="Program" v={program} mn dim={program === '—'} />
      <Spec ic="globe" l="Network" v="localnet" />
    </div>
  );
}

function Spec({ ic, l, v, acc, mn, dim }) {
  const cls = ['sv', acc && 'acc', mn && 'mn', dim && 'dim'].filter(Boolean).join(' ');
  return (
    <div className="spec">
      <div className="ic"><Icon name={ic} size={18} /></div>
      <div className="sl">{l}</div>
      <div className={cls}>{v}</div>
    </div>
  );
}

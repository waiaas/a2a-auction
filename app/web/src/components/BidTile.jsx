import { fmtUsdc, verdictShort } from '../lib/derive.js';

/** 입찰 타일 하나: 에이전트 · mandate · 입찰가 · 판정 pill · (B) owner 알림. */
export default function BidTile({ buyer }) {
  const highlight = buyer.deposit?.inPending || buyer.ui === 'APPROVAL_REQUIRED';
  const v = verdictShort(buyer.ui);
  return (
    <div className={`bid ${highlight ? 'hl' : ''}`}>
      <div className="bidder">
        <div className="av">{buyer.emoji}</div>
        <div>
          <div className="nm">{buyer.name}</div>
          <div className="md">{buyer.mandateChip}</div>
        </div>
      </div>
      <div className="bidr">
        <div className="a tnum">{fmtUsdc(buyer.bidUsdc)}<u>USDC</u></div>
        <div className="vv"><span className={`pill ${v.cls}`}><span className="d" />{v.label}</span></div>
        {buyer.ui === 'APPROVAL_REQUIRED' && <div className="ow"><span className="i">📱</span>owner 알림</div>}
      </div>
    </div>
  );
}

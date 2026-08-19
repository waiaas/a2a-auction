import Icon from './Icon.jsx';
import { fmtUsdc, verdictShort } from '../lib/derive.js';

/** 대기 큐에 걸린 판정. 유예(DELAY)와 승인(APPROVAL)은 큐가 다르므로 문구도 나눈다. */
const QUEUED_LABEL = {
  DELAY: '유예 큐 등재',
  APPROVAL: '승인 큐 등재',
  APPROVAL_REQUIRED: '승인 큐 등재',
};

/** 입찰 타일 하나: 에이전트 · mandate · 입찰가 · 판정 pill · 대기 큐 등재. */
export default function BidTile({ buyer }) {
  const queued = QUEUED_LABEL[buyer.ui];
  const highlight = buyer.deposit?.inPending || Boolean(queued);
  const v = verdictShort(buyer.ui);
  return (
    <div className={`bid ${highlight ? 'hl' : ''}`}>
      <div className="bidder">
        <div className="av"><Icon name={buyer.role} size={17} /></div>
        <div>
          <div className="nm">{buyer.name}</div>
          <div className="md">{buyer.mandateChip}</div>
        </div>
      </div>
      <div className="bidr">
        <div className="a tnum">{fmtUsdc(buyer.bidUsdc)}<u>USDC</u></div>
        <div className="vv"><span className={`pill ${v.cls}`}><span className="d" />{v.label}</span></div>
        {queued && (
          <div className="ow"><span className="i"><Icon name="clipboard" size={11} /></span>{queued}</div>
        )}
      </div>
    </div>
  );
}

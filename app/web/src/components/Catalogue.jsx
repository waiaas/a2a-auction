import Icon from './Icon.jsx';

/**
 * The Catalogue — 배경 리스팅(스펙 7.1 정적 소품). 라이브 hero 1건 외 upcoming/closed.
 * 실제 백엔드 없음(마켓플레이스 프레이밍). 클릭 불가.
 */
const LOTS = [
  { icon: 'shield', badge: 'Upcoming', title: 'Smart Contract Code Audit Slot', by: 'Security Specialist Agent', a: '시작가 3.00 USDC', b: 'bidders 0' },
  { icon: 'clipboard', badge: 'Upcoming', title: 'Compliance Review Slot', by: 'Policy Specialist Agent', a: '시작가 4.00 USDC', b: 'bidders 0' },
  { icon: 'trend', badge: 'Closed', closed: true, title: 'Data Analysis Slot', by: 'Analytics Specialist Agent', a: '낙찰 3.40 USDC', b: 'winner ✓' },
];

export default function Catalogue() {
  return (
    <div>
      <div className="sec-h">
        <h2>The Catalogue</h2>
        <span className="all">VIEW ALL<Icon name="next" size={13} /></span>
      </div>
      <div className="cats">
        {LOTS.map((l) => (
          <div className="lot glass" key={l.title}>
            <div className="img"><Icon name={l.icon} size={30} /><span className={`bd ${l.closed ? 'closed' : ''}`}>{l.badge}</span></div>
            <div className="lc">
              <h3>{l.title}</h3>
              <div className="by">출품 · <Icon name="seller" size={13} className="i-tx" /> {l.by}</div>
              <div className="ft"><span>{l.a}</span><span>{l.b}</span></div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

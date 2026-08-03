import { useState } from 'react';
import Icon from './Icon.jsx';

/**
 * The Catalogue — 배경 리스팅(스펙 7.1 정적 소품). 라이브 hero 1건 외 upcoming/closed.
 * 실제 백엔드 없음(마켓플레이스 프레이밍). 카드는 클릭 불가이고, VIEW ALL은 그 사실을 설명한다.
 * 헤더의 `Catalogue` 네비가 이 섹션(id="catalogue")으로 스크롤한다.
 */
const LOTS = [
  { icon: 'shield', badge: 'Upcoming', title: 'Smart Contract Code Audit Slot', by: 'Security Specialist Agent', a: '시작가 3.00 USDC', b: 'bidders 0' },
  { icon: 'clipboard', badge: 'Upcoming', title: 'Compliance Review Slot', by: 'Policy Specialist Agent', a: '시작가 4.00 USDC', b: 'bidders 0' },
  { icon: 'trend', badge: 'Closed', closed: true, title: 'Data Analysis Slot', by: 'Analytics Specialist Agent', a: '낙찰 3.40 USDC', b: 'winner ✓' },
];

const VIEW_ALL_NOTE =
  '전체 카탈로그 페이지는 준비 중입니다. 아래 리스팅은 마켓플레이스 맥락을 보여주는 소품이고, 실제로 온체인에서 동작하는 경매는 상단의 라이브 1건입니다.';

export default function Catalogue() {
  const [showNote, setShowNote] = useState(false);
  const toggle = () => setShowNote((v) => !v);

  return (
    <div id="catalogue">
      <div className="sec-h">
        <h2>The Catalogue</h2>
        <span
          className="all allbtn"
          role="button"
          tabIndex={0}
          onClick={toggle}
          onKeyDown={(e) => e.key === 'Enter' && toggle()}
        >
          VIEW ALL<Icon name="next" size={13} />
        </span>
      </div>
      {showNote && <div className="cat-note">{VIEW_ALL_NOTE}</div>}
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

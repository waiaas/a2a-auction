import Icon from './Icon.jsx';

/** 경매하우스 상단 바(hero 카드 내부): 로고 · 내비 · 검색/알림 · Connect Agent. */
export default function HeaderBar({ onOpenReceipt }) {
  return (
    <div className="bar">
      <div className="logo">A2A<b>House</b></div>
      <div className="nav">
        <span className="on">Live Auctions</span><span>Agents</span><span>Catalogue</span>
        <span className="navbtn" role="button" tabIndex={0} onClick={onOpenReceipt}
          onKeyDown={(e) => e.key === 'Enter' && onOpenReceipt?.()}>Receipt</span>
      </div>
      <div className="sp" />
      <div className="icirc"><Icon name="search" size={16} /></div>
      <div className="icirc"><Icon name="bell" size={16} /></div>
      <button className="connect">Connect Agent</button>
    </div>
  );
}

/** 경매하우스 상단 바(hero 카드 내부): 로고 · 내비 · 검색/알림 · Connect Agent. */
export default function HeaderBar() {
  return (
    <div className="bar">
      <div className="logo">A2A<b>House</b></div>
      <div className="nav">
        <span className="on">Live Auctions</span><span>Agents</span><span>Catalogue</span><span>How it works</span>
      </div>
      <div className="sp" />
      <div className="icirc" aria-hidden="true">🔍</div>
      <div className="icirc" aria-hidden="true">🔔</div>
      <button className="connect">Connect Agent</button>
    </div>
  );
}

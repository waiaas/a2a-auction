import { useState } from 'react';
import Icon from './Icon.jsx';

/** 경매하우스 상단 바(hero 카드 내부): 로고 · 내비 · 검색/알림 · Connect Agent. */
export default function HeaderBar({ onOpenReceipt, onOpenSeller, onOpenOwner }) {
  const [showConnectNote, setShowConnectNote] = useState(false);
  return (
    <div className="bar">
      <div className="logo">A2A<b>House</b></div>
      <div className="nav">
        <span className="on">Live Auctions</span><span>Agents</span><span>Catalogue</span>
        <span className="navbtn" role="button" tabIndex={0} onClick={onOpenSeller}
          onKeyDown={(e) => e.key === 'Enter' && onOpenSeller?.()}>Seller</span>
        <span className="navbtn" role="button" tabIndex={0} onClick={onOpenOwner}
          onKeyDown={(e) => e.key === 'Enter' && onOpenOwner?.()}>Owner</span>
        <span className="navbtn" role="button" tabIndex={0} onClick={onOpenReceipt}
          onKeyDown={(e) => e.key === 'Enter' && onOpenReceipt?.()}>Receipt</span>
      </div>
      <div className="sp" />
      <div className="icirc"><Icon name="search" size={16} /></div>
      <div className="icirc"><Icon name="bell" size={16} /></div>
      <div className="connect-wrap">
        <button className="connect" onClick={() => setShowConnectNote((v) => !v)}>Connect Agent</button>
        {showConnectNote && (
          <div className="connect-note">
            에이전트 연결(세션 발급)은 각 에이전트의 WAIaaS 데몬 콘솔에서 수행합니다.
            이 데모의 에이전트 5개는 이미 연결되어 있습니다.
          </div>
        )}
      </div>
    </div>
  );
}

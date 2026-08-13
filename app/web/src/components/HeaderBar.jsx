import { useState } from 'react';
import Icon from './Icon.jsx';

/**
 * 네비 항목별 안내. 미구현 화면을 숨기지 않고 **그 자리에서 설명한다** —
 * 공개 배포본은 심사자가 아무 데나 누르므로, 반응 없는 항목이 남으면 버그로 읽힌다.
 */
const NOTES = {
  agents:
    '에이전트 목록 페이지는 준비 중입니다. 이 데모의 에이전트 5개(구매자 3 · 판매자 · 마켓플레이스)는 Live 경매 화면 우측 패널에서 확인할 수 있습니다.',
  search: '검색은 준비 중입니다. 이 데모는 라이브 경매 1건과 카탈로그 소품으로 구성돼 있습니다.',
  bell:
    '알림 센터는 준비 중입니다. 위임 한도를 넘은 지출의 승인 대기는 Owner 콘솔의 "승인 대기 큐"에서 확인합니다.',
};

/** 경매하우스 상단 바(hero 카드 내부): 로고 · 내비 · 검색/알림 · 지갑 연결. */
export default function HeaderBar({ onOpenReceipt, onOpenSeller, onOpenOwner, onOpenPurchase, onOpenService }) {
  const [note, setNote] = useState(null);
  const toggle = (key) => setNote((v) => (v === key ? null : key));

  // 이 헤더는 Live 화면에서만 렌더된다(콘솔 3종은 각자 전체 화면이다). 그래서 "현재 화면"을
  // 가리키는 항목은 뷰 전환이 아니라 스크롤로 응답한다 — 클릭에 반응이 없으면 버그로 보인다.
  const scrollTop = () => window.scrollTo({ top: 0, behavior: 'smooth' });
  const scrollToCatalogue = () =>
    document.getElementById('catalogue')?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  /** 클릭과 Enter를 함께 받는 span 버튼(헤더 디자인상 button 태그를 쓰지 않는다). */
  const btn = (onAct, className, children) => (
    <span
      className={className}
      role="button"
      tabIndex={0}
      onClick={() => onAct?.()}
      onKeyDown={(e) => e.key === 'Enter' && onAct?.()}
    >
      {children}
    </span>
  );

  return (
    <div className="bar">
      {btn(scrollTop, 'logo logobtn', <>A2A<b>House</b></>)}
      <div className="nav">
        {btn(scrollTop, 'on navbtn', 'Live Auctions')}
        {/* 콘티 v3의 주무대. 심사위원이 루트로 들어와도 구매 라운드에 닿을 수 있어야 한다 —
            해시 URL만으로는 링크를 받은 사람만 들어온다. */}
        {/* 실제 서비스 진입점. 위 항목들이 발표용 고정 화면이라면 이쪽은 접속자 본인의 지갑과
            에이전트로 도는 곳이라, 나란히 두되 이름으로 구분한다. */}
        {btn(onOpenService, 'navbtn', '내 에이전트')}
        {btn(onOpenPurchase, 'navbtn', '구매 라운드')}
        {btn(() => toggle('agents'), 'navbtn', 'Agents')}
        {btn(scrollToCatalogue, 'navbtn', 'Catalogue')}
        {btn(onOpenSeller, 'navbtn', 'Seller')}
        {btn(onOpenOwner, 'navbtn', 'Owner')}
        {btn(onOpenReceipt, 'navbtn', 'Receipt')}
      </div>
      <div className="sp" />
      {btn(() => toggle('search'), 'icirc ib', <Icon name="search" size={16} />)}
      {btn(() => toggle('bell'), 'icirc ib', <Icon name="bell" size={16} />)}
      <button className="connect" onClick={() => onOpenService?.()}>지갑 연결</button>
      {note && (
        <div className={`bar-note ${note === 'agents' ? 'left' : 'right'}`}>{NOTES[note]}</div>
      )}
    </div>
  );
}

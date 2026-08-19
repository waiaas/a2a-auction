import { useEffect, useState, useCallback } from 'react';
import { fetchState, startAuction } from './api.js';
import Hero from './components/Hero.jsx';
import Catalogue from './components/Catalogue.jsx';
import Rail from './components/Rail.jsx';
import Receipt from './components/Receipt.jsx';
import SellerConsole from './components/SellerConsole.jsx';
import OwnerConsole from './components/OwnerConsole.jsx';
import PurchaseView from './components/PurchaseView.jsx';
import PurchaseReceipt from './components/PurchaseReceipt.jsx';
import ServiceView from './components/ServiceView.jsx';
import { fetchReceipt as fetchMyReceipt } from './lib/user-api.js';

const POLL_MS = 1000;
const INITIAL = { phase: 'idle', auctionId: null, buyers: {}, steps: {}, item: null, addresses: {} };

/**
 * 해시 → 화면. `#me`가 **실제 서비스**(내 지갑·내 에이전트)이고 `#purchase`는 발표용 고정
 * 라운드다. 둘을 같은 주소에 두면 심사위원이 어느 쪽을 보고 있는지 구분하지 못한다.
 */
function viewFromHash(hash) {
  if (hash === '#me') return 'service';
  if (hash === '#purchase') return 'purchase';
  return 'live';
}

export default function App() {
  const [state, setState] = useState(INITIAL);
  const [starting, setStarting] = useState(false);
  // 'live' | 'receipt' | 'seller' | 'owner' | 'purchase' | 'service' | 'my-receipt'
  const [view, setView] = useState(() =>
    typeof window !== 'undefined' ? viewFromHash(window.location.hash) : 'live',
  );

  // 1초 폴링. 실패해도 마지막 상태 유지(밸리데이터 블립 대비).
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const s = await fetchState();
        if (alive) setState(s);
      } catch { /* keep last state */ }
    };
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => { alive = false; clearInterval(id); };
  }, []);

  const onStart = useCallback(async () => {
    setStarting(true);
    try { await startAuction(); } catch { /* 폴링이 상태를 갱신 */ }
    finally { setStarting(false); }
  }, []);

  // 해시로 들어온 뒤 뒤로가기·주소 수정으로 해시가 바뀌는 경우까지 따라간다. 최초 로드만
  // 보면 링크를 다시 눌러도 화면이 그대로라 "링크가 죽었다"로 읽힌다.
  useEffect(() => {
    const onHash = () => setView(viewFromHash(window.location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const openReceipt = useCallback(() => setView('receipt'), []);
  const openSeller = useCallback(() => setView('seller'), []);
  const openOwner = useCallback(() => setView('owner'), []);
  const openPurchase = useCallback(() => {
    window.location.hash = '#purchase'; // 주소를 실제로 바꿔 공유·새로고침이 같은 화면을 연다
    setView('purchase');
  }, []);
  const openPurchaseReceipt = useCallback(() => setView('purchase-receipt'), []);
  const openService = useCallback(() => {
    window.location.hash = '#me'; // 주소를 실제로 바꿔 공유·새로고침이 같은 화면을 연다
    setView('service');
  }, []);
  const openMyReceipt = useCallback(() => setView('my-receipt'), []);
  const openLive = useCallback(() => {
    if (window.location.hash) window.history.replaceState({}, '', window.location.pathname);
    setView('live');
  }, []);

  if (view === 'receipt') {
    return (
      <div className="app">
        <Receipt state={state} onBack={openLive} />
      </div>
    );
  }

  if (view === 'seller') {
    return (
      <div className="app">
        <SellerConsole state={state} onBack={openLive} />
      </div>
    );
  }

  if (view === 'owner') {
    return (
      <div className="app">
        <OwnerConsole onBack={openLive} />
      </div>
    );
  }

  if (view === 'purchase') {
    return (
      <div className="app">
        <PurchaseView onBack={openLive} onOpenReceipt={openPurchaseReceipt} />
      </div>
    );
  }

  if (view === 'purchase-receipt') {
    return (
      <div className="app">
        <PurchaseReceipt onBack={openPurchase} />
      </div>
    );
  }

  if (view === 'service') {
    return (
      <div className="app">
        <ServiceView onBack={openLive} onOpenReceipt={openMyReceipt} />
      </div>
    );
  }

  if (view === 'my-receipt') {
    return (
      <div className="app">
        <PurchaseReceipt onBack={openService} fetcher={fetchMyReceipt} />
      </div>
    );
  }

  return (
    <div className="app">
      {state.phase === 'error' && (
        <div className="errbar">라운드 실행 오류: {state.error || '알 수 없는 오류'}</div>
      )}
      <Hero state={state} onStart={onStart} starting={starting} onOpenReceipt={openReceipt} onOpenSeller={openSeller} onOpenOwner={openOwner} onOpenPurchase={openPurchase} onOpenService={openService} />
      <div className="lower">
        <Catalogue />
        <Rail state={state} />
      </div>
    </div>
  );
}

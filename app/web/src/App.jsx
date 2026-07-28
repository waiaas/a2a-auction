import { useEffect, useState, useCallback } from 'react';
import { fetchState, startAuction } from './api.js';
import Hero from './components/Hero.jsx';
import Catalogue from './components/Catalogue.jsx';
import Rail from './components/Rail.jsx';
import Receipt from './components/Receipt.jsx';

const POLL_MS = 1000;
const INITIAL = { phase: 'idle', auctionId: null, buyers: {}, steps: {}, item: null, addresses: {} };

export default function App() {
  const [state, setState] = useState(INITIAL);
  const [starting, setStarting] = useState(false);
  const [view, setView] = useState('live'); // 'live' | 'receipt'

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

  const openReceipt = useCallback(() => setView('receipt'), []);
  const openLive = useCallback(() => setView('live'), []);

  if (view === 'receipt') {
    return (
      <div className="app">
        <Receipt state={state} onBack={openLive} />
      </div>
    );
  }

  return (
    <div className="app">
      {state.phase === 'error' && (
        <div className="errbar">라운드 실행 오류: {state.error || '알 수 없는 오류'}</div>
      )}
      <Hero state={state} onStart={onStart} starting={starting} onOpenReceipt={openReceipt} />
      <div className="lower">
        <Catalogue />
        <Rail state={state} />
      </div>
    </div>
  );
}

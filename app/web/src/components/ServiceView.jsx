import { useCallback, useEffect, useRef, useState } from 'react';
import WalletGate from './WalletGate.jsx';
import WalletCards from './WalletCards.jsx';
import PolicyCard from './PolicyCard.jsx';
import RequestBox from './RequestBox.jsx';
import PurchaseList from './PurchaseList.jsx';
import { connectStandard, connectLocal } from '../lib/wallet.js';
import * as api from '../lib/user-api.js';

/**
 * 서비스 화면. 지갑을 연결한 사람이 자기 에이전트에게 일을 맡기는 전 과정을 한 화면에 둔다.
 *
 * 순서가 곧 설명이다. **연결 → 자금 → 한도 → 요청 → 판정.** 앞 단계를 건너뛰면 뒤가 왜
 * 그렇게 되는지 알 수 없으므로, 각 카드가 다음에 무엇을 해야 하는지 스스로 말하게 했다.
 *
 * 지갑 객체는 상태가 아니라 ref에 둔다. 서명 함수는 렌더와 무관하고, 상태로 두면 서명 도중
 * 리렌더가 일어날 때 오래된 지갑 참조를 잡을 수 있다.
 */
export default function ServiceView({ onBack, onOpenReceipt }) {
  const wallet = useRef(null);
  const [connected, setConnected] = useState(() => Boolean(api.savedToken()));
  const [me, setMe] = useState(null);
  const [round, setRound] = useState({ purchases: [], phase: 'idle', running: false });
  const [catalog, setCatalog] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  // 토큰이 남아 있어도 지갑 객체는 새로고침에 사라진다. 서명이 필요한 동작에서만 다시 요구한다.
  const needsWallet = connected && !wallet.current;

  const refreshMe = useCallback(async () => {
    try {
      setMe(await api.fetchMe());
    } catch (e) {
      if (e.status === 401) setConnected(false);
      else setError(e.message);
    }
  }, []);

  useEffect(() => {
    api.fetchCatalog().then((d) => setCatalog(d.listings)).catch(() => {});
  }, []);

  useEffect(() => {
    if (!connected) return undefined;
    refreshMe();
    let alive = true;
    const tick = () => {
      api.fetchRoundState()
        .then((s) => { if (alive) setRound(s); })
        .catch((e) => { if (e.status === 401) setConnected(false); });
    };
    tick();
    const id = setInterval(tick, 1500);
    return () => { alive = false; clearInterval(id); };
  }, [connected, refreshMe]);

  /** 공통 실행 래퍼. 오류를 화면 한 곳에 모은다 — 실패가 조용히 사라지면 사용자가 멈춘다. */
  const run = useCallback(async (fn, successNote) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const out = await fn();
      if (successNote) setNotice(typeof successNote === 'function' ? successNote(out) : successNote);
      return out;
    } catch (e) {
      setError(e.message);
      throw e;
    } finally {
      setBusy(false);
    }
  }, []);

  // ---- 연결 ----
  const connect = useCallback(async (choice) => {
    await run(async () => {
      const w = choice.type === 'local' ? await connectLocal() : await connectStandard(choice.wallet);
      const { message } = await api.requestNonce(w.address);
      const signature = await w.signMessage(message);
      const out = await api.submitConnect(w.address, message, signature);
      api.saveToken(out.authToken);
      wallet.current = w;
      setConnected(true);
      await refreshMe();
      return out;
    }, (out) => (out.created ? '에이전트 지갑을 만들었습니다.' : '기존 에이전트 지갑을 이어서 씁니다.'));
  }, [run, refreshMe]);

  /** 새로고침 후 서명이 필요할 때 지갑만 다시 붙인다(서버 세션은 살아 있다). */
  const reattach = useCallback(async (choice) => {
    const w = choice.type === 'local' ? await connectLocal() : await connectStandard(choice.wallet);
    if (me && w.address !== me.ownerAddress) {
      throw new Error('연결된 계정과 다른 지갑입니다. 같은 지갑으로 열어 주세요.');
    }
    wallet.current = w;
    return w;
  }, [me]);

  // ---- 자금 ----
  const faucet = useCallback(() => run(async () => {
    const out = await api.claimFaucet();
    await refreshMe();
    return out;
  }, '체험 자산을 받았습니다. 이제 에이전트에게 얼마를 맡길지 정해 보세요.'), [run, refreshMe]);

  const deposit = useCallback((amountUsdc) => run(async () => {
    if (!wallet.current) throw new Error('서명할 지갑이 연결돼 있지 않습니다. 다시 연결해 주세요.');
    const { txBase64 } = await api.prepareDeposit(amountUsdc);
    const signedTx = await wallet.current.signTransaction(txBase64);
    const out = await api.submitDeposit(signedTx, amountUsdc);
    await refreshMe();
    return out;
  }, '에이전트에게 맡겼습니다. 이 금액 안에서만 스스로 쓸 수 있습니다.'), [run, refreshMe]);

  // ---- 정책 ----
  const savePolicy = useCallback(async (notifyMaxUsdc, delayMaxUsdc) => {
    const out = await api.savePolicy(notifyMaxUsdc, delayMaxUsdc);
    await refreshMe();
    return out;
  }, [refreshMe]);

  // ---- 구매 ----
  const submitRequest = useCallback((prompt) => run(
    () => api.submitRequest(prompt),
    '에이전트가 카탈로그를 살펴보고 있습니다…',
  ), [run]);

  const settle = useCallback(() => run(() => api.settleRound()), [run]);

  /** 승인·거부 모두 지갑 서명이 필요하다. 서버는 서명을 중계만 한다. */
  const ownerAction = useCallback((purchase, action) => run(async () => {
    if (!wallet.current) throw new Error('서명할 지갑이 연결돼 있지 않습니다. 상단에서 다시 연결해 주세요.');
    const { message } = await api.fetchActionMessage(purchase.requestId, action);
    const signature = await wallet.current.signMessage(message);
    const out = action === 'approve'
      ? await api.approveRequest(purchase.requestId, message, signature)
      : await api.cancelRequest(purchase.requestId, message, signature);
    await refreshMe();
    return out;
  }, action === 'approve' ? '승인했습니다. 에이전트가 이어서 진행합니다.' : '거부했습니다. 돈은 나가지 않았습니다.'),
  [run, refreshMe]);

  const disconnect = useCallback(() => {
    api.clearToken();
    wallet.current = null;
    setConnected(false);
    setMe(null);
    setRound({ purchases: [], phase: 'idle', running: false });
  }, []);

  if (!connected) {
    return (
      <div className="stage">
        <div className="sec-h">
          <h2>A2AHouse</h2>
          <button className="cta ghost" onClick={onBack}>← 돌아가기</button>
        </div>
        <WalletGate onConnect={connect} busy={busy} error={error} />
      </div>
    );
  }

  const running = busy || round.running;

  return (
    <div className="stage">
      <div className="sec-h">
        <h2>내 에이전트</h2>
        <div className="svc-top-actions">
          {round.purchases.length > 0 && (
            <button className="cta ghost" onClick={onOpenReceipt}>영수증</button>
          )}
          <button className="cta ghost" onClick={disconnect}>연결 해제</button>
          <button className="cta ghost" onClick={onBack}>← 돌아가기</button>
        </div>
      </div>

      {needsWallet && (
        <div className="svc-reattach">
          새로고침으로 지갑 연결이 끊겼습니다. 승인·입금에는 서명이 필요합니다.
          <WalletGate onConnect={(c) => run(() => reattach(c), '지갑을 다시 연결했습니다.')} busy={busy} error={null} reconnect />
        </div>
      )}

      {notice && <div className="svc-notice">{notice}</div>}
      {error && <div className="errbar">{error}</div>}
      {round.error && <div className="errbar">{round.error}</div>}

      <WalletCards me={me} onFaucet={faucet} onDeposit={deposit} busy={running} />
      <PolicyCard policy={me?.policy} agentUsdc={me?.agent?.usdc} onSave={savePolicy} busy={running} />
      <RequestBox onSubmit={submitRequest} busy={running} catalog={catalog} />
      <PurchaseList
        purchases={round.purchases}
        busy={running}
        onApprove={(p) => ownerAction(p, 'approve')}
        onCancel={(p) => ownerAction(p, 'reject')}
        onSettle={settle}
      />
    </div>
  );
}

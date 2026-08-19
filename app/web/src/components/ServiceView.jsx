import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import WalletGate from './WalletGate.jsx';
import WalletCards from './WalletCards.jsx';
import PolicyCard from './PolicyCard.jsx';
import McpCard from './McpCard.jsx';
import RequestBox from './RequestBox.jsx';
import PurchaseList from './PurchaseList.jsx';
import CandidateList from './CandidateList.jsx';
import AgentCard from './AgentCard.jsx';
import SampleModal from './SampleModal.jsx';
import ResultView from './ResultView.jsx';
import Stepper from './Stepper.jsx';
import { connectStandard, connectLocal } from '../lib/wallet.js';
import * as api from '../lib/user-api.js';
import { ClusterContext } from '../lib/explorer.js';
import { rankCandidates, DEFAULT_PRICE_WEIGHT } from '../../../lib/ranking.js';

/**
 * 서비스 화면. 지갑을 연결한 사람이 자기 에이전트에게 일을 맡기는 전 과정을 담는다.
 *
 * 순서가 곧 설명이다. **연결 → 자금 → 한도 → 요청 → 후보 → 판정 → 결과물.** 앞 단계를
 * 건너뛰면 뒤가 왜 그렇게 되는지 알 수 없으므로, 각 카드가 다음에 무엇을 해야 하는지
 * 스스로 말하게 했다.
 *
 * 요청 이후는 한 화면에 쌓지 않고 단계로 나눈다(8/19 퀵싱크). 전 과정을 한 페이지에 늘어
 * 놓으면 지금 무엇이 일어나는지 설명할 수 없다는 지적을 받았고, 라우팅 대신 단계 표시로
 * 같은 효과를 낸다 — 새로고침이나 뒤로가기로 진행 중인 구매가 끊기지 않는다.
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
  const [criteria, setCriteria] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  // 요청을 넣으면 바로 사지 않고 후보를 먼저 보여준다. 그 사이 상태가 여기 머문다.
  const [draft, setDraft] = useState(null);
  const [priceWeight, setPriceWeight] = useState(DEFAULT_PRICE_WEIGHT);
  const [sampleOf, setSampleOf] = useState(null);
  const [result, setResult] = useState(null);

  // 토큰이 남아 있어도 지갑 객체는 새로고침에 사라진다. 서명이 필요한 동작에서만 다시 요구한다.
  const needsWallet = connected && !wallet.current;

  const candidates = useMemo(() => rankCandidates(catalog, priceWeight), [catalog, priceWeight]);

  const refreshMe = useCallback(async () => {
    try {
      setMe(await api.fetchMe());
    } catch (e) {
      if (e.status === 401) setConnected(false);
      else setError(e.message);
    }
  }, []);

  // 정산이 하나 끝날 때마다 카탈로그를 다시 읽는다. 채점이 평점을 바꾸는데 화면이 로드
  // 시점 스냅샷을 계속 쓰면 두 가지가 어긋난다. ① "평점은 채점이 쌓여 만들어진다"를
  // 보여주는 카드가 정작 갱신되지 않는다 ② 서버는 구매 시점의 평점으로 순위를 매기므로,
  // 굳은 화면과 서버의 1위가 갈릴 수 있다.
  // **`steps.settle`이 아니라 `grade`를 센다.** 서버는 정산을 먼저 세우고 그 뒤에 채점하는데,
  // 그 사이(폴백 채점 기준 약 600ms)에 폴링이 걸리면 채점 전 평점을 읽고 굳는다. 라이브
  // 채점이 살아나면 창이 수 초로 넓어져 거의 항상 걸린다.
  const gradedCount = round.purchases.filter((p) => p.grade).length;
  useEffect(() => {
    api.fetchCatalog()
      .then((d) => { setCatalog(d.listings); setCriteria(d.criteria ?? []); })
      .catch(() => {});
  }, [gradedCount]);

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
      // 다시 던지지 않는다. 오류는 이미 화면에 실렸고 호출부는 전부 onClick 핸들러라
      // 받아 주는 곳이 없다 — 던지면 미처리 rejection이 콘솔에 그대로 남는다.
      return undefined;
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
  /** 요청은 후보 화면을 거친다. 여기서 바로 사면 "왜 이걸 골랐나"를 말할 자리가 없어진다. */
  const openCandidates = useCallback((prompt) => {
    setError(null);
    setNotice(null);
    setDraft(prompt);
  }, []);

  const submitDraft = useCallback((weight) => run(async () => {
    const out = await api.submitRequest(draft, weight);
    setDraft(null);
    return out;
  }, '에이전트가 진행합니다. 한도를 넘으면 승인을 요청합니다.'), [run, draft]);

  const settle = useCallback(() => run(() => api.settleRound()), [run]);

  const openResult = useCallback((purchase) => run(async () => {
    const out = await api.fetchResult(purchase.requestId);
    setResult(out);
    return out;
  }), [run]);

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
    setDraft(null);
    setResult(null);
  }, []);

  if (!connected) {
    return (
      <div className="stage">
        <div className="sec-h">
          <h2>A2AHouse</h2>
          {onBack && <button className="cta ghost" onClick={onBack}>← 돌아가기</button>}
        </div>
        <WalletGate onConnect={connect} busy={busy} error={error} />
      </div>
    );
  }

  const running = busy || round.running;
  const step = currentStep({ draft, purchases: round.purchases, result });

  if (result) {
    return (
      <ClusterContext.Provider value={round.network || 'devnet'}>
        <div className="stage">
          <Stepper current="result" />
          <ResultView result={result} onBack={() => setResult(null)} onOpenReceipt={onOpenReceipt} />
        </div>
      </ClusterContext.Provider>
    );
  }

  return (
    <ClusterContext.Provider value={round.network || 'devnet'}>
    <div className="stage">
      <div className="sec-h">
        <h2>내 에이전트</h2>
        <div className="svc-top-actions">
          {round.purchases.length > 0 && (
            <button className="cta ghost" onClick={onOpenReceipt}>영수증</button>
          )}
          <button className="cta ghost" onClick={disconnect}>연결 해제</button>
          {onBack && <button className="cta ghost" onClick={onBack}>← 돌아가기</button>}
        </div>
      </div>

      <Stepper current={step} />

      {needsWallet && (
        <div className="svc-reattach">
          새로고침으로 지갑 연결이 끊겼습니다. 승인·입금에는 서명이 필요합니다.
          <WalletGate onConnect={(c) => run(() => reattach(c), '지갑을 다시 연결했습니다.')} busy={busy} error={null} reconnect />
        </div>
      )}

      {notice && <div className="svc-notice">{notice}</div>}
      {error && <div className="errbar">{error}</div>}
      {round.error && <div className="errbar">{round.error}</div>}

      {draft ? (
        <CandidateList
          prompt={draft}
          candidates={candidates}
          priceWeight={priceWeight}
          onWeight={setPriceWeight}
          onSubmit={submitDraft}
          onOpenSample={setSampleOf}
          onCancel={() => setDraft(null)}
          busy={running}
        />
      ) : (
        <>
          <WalletCards me={me} onFaucet={faucet} onDeposit={deposit} busy={running} />
          <PolicyCard policy={me?.policy} agentUsdc={me?.agent?.usdc} onSave={savePolicy} busy={running} />

          {/* 결정 ⑲. 주소만 치고 들어온 사람은 TRY-IT.md를 보지 않는다. 밝히지 않으면
              "self-hosted라며 왜 서버가 키를 갖고 있냐"를 상대가 먼저 발견하게 된다. */}
          <p className="svc-trial">
            이 체험판은 저희가 데몬을 대신 띄운 것입니다. 실제 제품(WAIaaS)은 자기 기계에 데몬을
            띄우고 키가 그 기계를 떠나지 않습니다.
          </p>
          {/* 정식 경로(MCP)를 보조 입력창보다 먼저 놓는다. 순서가 곧 어느 쪽이 주인지를 말한다. */}
          <McpCard agentAddress={me?.agentAddress} />

          {/* 무엇을 살 수 있는지 먼저 보여야 무엇을 시킬지 정할 수 있다. 셀러 등록 화면은
              두지 않는다(8/19 퀵싱크) — 이미 등록된 것만 놓는다. */}
          {candidates.length > 0 && (
            <section className="svc-catalog">
              <header className="svc-catalog-h">
                <span className="svc-role">등록된 에이전트</span>
                <span className="svc-sub">{candidates.length}건 · 평점과 샘플을 보고 고릅니다</span>
              </header>
              <div className="cand-grid">
                {candidates.map((l) => (
                  <AgentCard key={l.id} listing={l} onOpenSample={setSampleOf} busy={running} />
                ))}
              </div>
            </section>
          )}

          {/* 건수·가격대는 실제로 고를 수 있는 후보 기준이어야 한다. 샘플이 없어 후보에서
              빠지는 리스팅까지 세면 화면이 아래 카드 수와 다른 숫자를 말한다. */}
          <RequestBox onSubmit={openCandidates} busy={running} catalog={candidates} />
          <PurchaseList
            purchases={round.purchases}
            busy={running}
            running={running}
            onApprove={(p) => ownerAction(p, 'approve')}
            onCancel={(p) => ownerAction(p, 'reject')}
            onSettle={settle}
            onOpenResult={openResult}
            x402Enabled={round.x402Enabled}
          />
        </>
      )}

      {sampleOf && (
        <SampleModal listing={sampleOf} criteria={criteria} onClose={() => setSampleOf(null)} />
      )}
    </div>
    </ClusterContext.Provider>
  );
}

/**
 * 지금 어느 단계인가. 스테퍼는 진행 상태를 읽어 표시할 뿐이므로 별도 상태를 두지 않는다 —
 * 화면 상태와 실제 진행이 어긋나면 스테퍼가 거짓말을 하게 된다.
 */
function currentStep({ draft, purchases, result }) {
  if (draft) return 'choose';
  if (!purchases.length) return 'request';

  // **사람이 개입해야 하는 건이 가장 앞선다.** 마지막 건만 보면 앞 건의 승인 대기가
  // 사라지고, 결과물을 여는 동안에도 같은 일이 일어난다 — 그래서 결과물 화면보다 먼저 본다.
  if (purchases.some((p) => p.ui === 'APPROVAL' || p.ui === 'DELAY')) return 'approve';
  if (result) return 'result';

  const last = purchases[purchases.length - 1];
  // 거부·정책거부로 끝난 건은 결제 단계가 아니다. 돈이 나가지 않았는데 "승인 완료 후
  // 결제 중"으로 칠하면 화면이 사실과 반대를 말한다.
  // 다만 앞서 받아 둔 결과물이 있으면 맨 앞으로 되돌리지 않는다. 거부 한 번에 그때까지의
  // 진행이 화면에서 지워지면, 이번에는 반대 방향으로 사실과 어긋난다.
  if (last.ui === 'REJECTED' || last.ui === 'DENY') {
    return purchases.some((p) => p.steps?.settle) ? 'result' : 'request';
  }
  if (!last.steps?.settle) return 'settle';
  return 'result';
}

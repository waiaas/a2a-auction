import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import WalletGate from './WalletGate.jsx';
import Icon from './Icon.jsx';
import { fmtUsdc } from '../lib/derive.js';
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
  // MCP 설정은 한 번 붙이면 끝나는 일이라 기본은 접어 둔다(상단바 버튼으로 편다).
  const [mcpOpen, setMcpOpen] = useState(false);
  const [round, setRound] = useState({ purchases: [], phase: 'idle', running: false });
  const [catalog, setCatalog] = useState([]);
  const [criteria, setCriteria] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  // 요청을 넣으면 바로 사지 않고 후보를 먼저 보여준다. 그 사이 상태가 여기 머문다.
  const [draft, setDraft] = useState(null);
  // 가격·품질 중요도 슬라이더 2개. 채점식이 쓰는 가격 비중 w는 둘의 비율로 **여기서 한 번만**
  // 파생한다 — 화면 랭킹과 전송이 다른 w를 쓰면 "화면 1위 ≠ 실제 구매"가 되고, 회귀는
  // API만 봐서 그 어긋남을 못 잡는다. 양쪽 0이면 0/0=NaN이라 반반으로 간주한다.
  const [prefs, setPrefs] = useState({
    price: Math.round(DEFAULT_PRICE_WEIGHT * 100),
    quality: Math.round((1 - DEFAULT_PRICE_WEIGHT) * 100),
  });
  const priceWeight = prefs.price + prefs.quality === 0 ? 0.5 : prefs.price / (prefs.price + prefs.quality);
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
        {/* 연결 전에도 같은 히어로 셸을 쓴다. 첫 화면과 연결 후 화면이 다른 제품처럼 보이면
            "연결했더니 다른 데로 왔나" 싶어진다. */}
        <div className="hero glass svc-shell svc-shell-gate">
          <div className="bar">
            <span className="logo">A2A<b>House</b></span>
            <nav className="nav"><span className="on">에이전트 마켓</span></nav>
            <span className="sp" />
            {onBack && <button className="connect" onClick={onBack}>← 돌아가기</button>}
          </div>
          <div className="svc-htop">
            <div>
              <div className="status">
                <span className="pill ok"><span className="d" />체험판</span>
                <span className="meta">powered by WAIaaS</span>
              </div>
              <h1 className="title">내 에이전트에게<br />일을 맡겨 보세요</h1>
            </div>
            <div className="desc">
              지갑을 연결하면 <b>나만의 에이전트 지갑</b>이 만들어집니다. 내가 맡긴 금액 안에서만
              에이전트가 스스로 능력을 사고, 한도를 넘는 지출은 <span className="more">내 서명을
              받아야</span> 진행됩니다.
            </div>
          </div>
          <WalletGate onConnect={connect} busy={busy} error={error} />
        </div>

        {/* **연결 전 화면의 아래 70%가 비어 있었다.** 심사위원이 주소만 치고 들어오는 화면이라
            첫인상이 "미완성"이면 그 뒤를 안 본다. `/catalog`는 무인증이라 연결 없이도 무엇을
            파는 곳인지 보여줄 수 있다 — 마켓플레이스임이 첫 화면에서 읽혀야 한다. */}
        {candidates.length > 0 && (
          <section className="svc-catalog svc-preview">
            <header className="svc-catalog-h">
              <span className="svc-role">등록된 에이전트</span>
              <span className="svc-sub">{candidates.length}건 · 지갑을 연결하면 바로 맡길 수 있습니다</span>
            </header>
            <div className="cand-grid">
              {candidates.map((l) => (
                <AgentCard key={l.id} listing={l} onOpenSample={setSampleOf} busy={busy} />
              ))}
            </div>
          </section>
        )}
        {sampleOf && <SampleModal listing={sampleOf} onClose={() => setSampleOf(null)} />}
      </div>
    );
  }

  const running = busy || round.running;
  const step = currentStep({ draft, purchases: round.purchases, result });

  if (result) {
    return (
      <ClusterContext.Provider value={round.network || 'devnet'}>
        <div className="stage">
          {/* `currentStep`이 준 값을 쓴다. 'result'로 고정하면 결과물을 보는 동안 다른 건의
              승인 대기가 가려지고, 그 판단을 하라고 만든 `currentStep`의 분기도 죽는다. */}
          <Stepper current={step} />
          <ResultView result={result} onBack={() => setResult(null)} onOpenReceipt={onOpenReceipt} />
        </div>
      </ClusterContext.Provider>
    );
  }

  return (
    <ClusterContext.Provider value={round.network || 'devnet'}>
    <div className="stage">
      {/* **8/3 제출본의 히어로 셸을 그대로 쓴다.** 카드만 쌓으면 제품이 아니라 콘솔로 읽힌다 —
          네비바·대형 타이틀·스펙 타일이 "서비스"의 뼈대였고, 그 CSS가 레포에 그대로 있다
          (결정 ㉑로 구 화면을 지우지 않은 덕이다). */}
      <div className="hero glass svc-shell">
        <div className="bar">
          <span className="logo">A2A<b>House</b></span>
          <nav className="nav">
            <span className="on">내 에이전트</span>
            <span className="navbtn" role="button" tabIndex={0}
              onClick={() => setMcpOpen((v) => !v)}
              onKeyDown={(e) => e.key === 'Enter' && setMcpOpen((v) => !v)}>MCP 연결</span>
            {round.purchases.length > 0 && (
              <span className="navbtn" role="button" tabIndex={0}
                onClick={onOpenReceipt}
                onKeyDown={(e) => e.key === 'Enter' && onOpenReceipt?.()}>영수증</span>
            )}
          </nav>
          <span className="sp" />
          <button className="connect" onClick={disconnect}>연결 해제</button>
        </div>

        <div className="svc-htop">
          <div>
            <div className="status">
              <span className="pill ok"><span className="d" />체험판</span>
              <span className="meta">powered by WAIaaS · {round.network || 'devnet'}</span>
            </div>
            <h1 className="title">에이전트에게<br />일을 맡기세요</h1>
            <p className="subid">내가 정한 한도 안에서만 씁니다</p>
          </div>
          <div className="desc">
            지갑을 연결하면 나만의 에이전트 지갑이 생깁니다. 맡긴 금액 안에서만 스스로 결제하고,
            한도를 넘으면 나를 다시 찾아옵니다. 결과물은 <span className="more">온체인 정산이
            확인된 뒤에만</span> 열립니다.
          </div>
        </div>

        {/* **요청 입력창을 히어로 안에 둔다.** 마켓플레이스의 검색창과 같은 자리다. 본문 첫
            카드로 두면 "무엇을 하는 곳인가"를 알려면 한 번 스크롤해야 하고, 카드가 하나 더
            늘어 화면이 그만큼 복잡해진다. */}
        <RequestBox onSubmit={openCandidates} busy={running} catalog={candidates} inHero />

        <Stepper current={step} />

        {/* 지갑·한도를 한눈에. 입력 폼은 레일 카드가 맡고 여기는 현재 값만 읽는다. */}
        <div className="specs svc-specs">
          <Spec ic="coins" l="내 지갑" v={`${fmtUsdc(me?.owner?.usdc ?? 0)} USDC`} />
          <Spec ic="bank" l="에이전트 지갑" v={`${fmtUsdc(me?.agent?.usdc ?? 0)} USDC`} acc />
          <Spec ic="trend" l="알림만" v={`${me?.policy?.notifyMaxUsdc ?? 0} USDC`} />
          <Spec ic="trophy" l="유예" v={`${me?.policy?.delayMaxUsdc ?? 0} USDC`} />
          <Spec ic="seller" l="그 이상" v="내 지갑 서명" />
          <Spec ic="globe" l="네트워크" v={round.network || 'devnet'} />
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

      {draft ? (
        <CandidateList
          prompt={draft}
          candidates={candidates}
          prefs={prefs}
          onPrefs={setPrefs}
          priceWeight={priceWeight}
          onSubmit={submitDraft}
          onOpenSample={setSampleOf}
          onCancel={() => setDraft(null)}
          busy={running}
        />
      ) : (
        <>
          {/* **와이어프레임 01의 부제가 "카탈로그와 요청 입력을 한 화면에"다.** 무엇을 시킬지가
              맨 위에 오고, 지갑·한도·MCP 설정은 그 뒤다. 설정 UI를 앞에 두면 제품보다 콘솔이
              먼저 보인다 — 실제로 그렇게 만들었다가 되돌린 자리다. */}
          {/* **8/3의 2단 그리드(`.lower`)를 그대로 쓴다.** 왼쪽은 제품(무엇을 시키고 무엇을
              맡겼나), 오른쪽 레일은 내 설정(지갑·한도)이다. 한 단으로 흘리면 설정 카드가
              맡긴 일 사이에 끼어 어디까지가 "일"인지 흐려진다. */}
          <div className="lower svc-lower">
            <div className="svc-main">
              {/* 무엇을 살 수 있는지 보여야 무엇을 시킬지 정할 수 있다. 셀러 등록 화면은
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

              {/* 정식 경로가 MCP라는 것은 상단 네비와 이 카드의 문구가 말한다. 접어 두는 것은
                  중요도를 낮추는 게 아니라, 설정이 제품 앞을 막지 않게 하는 것이다. */}
              {mcpOpen && <McpCard agentAddress={me?.agentAddress} />}

              {/* 맡긴 일은 본문에 남긴다. 승인 버튼과 결과물 열람이 여기 있어서, 320px 레일로
                  보내면 데모의 핵심 조작이 좁은 칸에 갇힌다. */}
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
            </div>

            <aside className="rail svc-rail">
              <WalletCards me={me} onFaucet={faucet} onDeposit={deposit} busy={running} />
              <PolicyCard policy={me?.policy} agentUsdc={me?.agent?.usdc} onSave={savePolicy} busy={running} />

              {/* 결정 ⑲. 주소만 치고 들어온 사람은 TRY-IT.md를 보지 않는다. 밝히지 않으면
                  "self-hosted라며 왜 서버가 키를 갖고 있냐"를 상대가 먼저 발견하게 된다. */}
              <p className="svc-trial">
                이 체험판은 저희가 데몬을 대신 띄운 것입니다. 실제 제품(WAIaaS)은 자기 기계에
                데몬을 띄우고 키가 그 기계를 떠나지 않습니다.
              </p>
            </aside>
          </div>
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

/** 스펙 타일 한 칸. `SpecTiles`와 같은 마크업이라 `.spec` CSS를 그대로 쓴다. */
function Spec({ ic, l, v, acc }) {
  return (
    <div className="spec">
      <div className="ic"><Icon name={ic} size={18} /></div>
      <div className="sl">{l}</div>
      <div className={`sv${acc ? ' acc' : ''}`}>{v}</div>
    </div>
  );
}

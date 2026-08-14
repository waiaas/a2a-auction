/**
 * 사용자 API (`/api/u/*`) — 지갑을 연결한 사람이 자기 에이전트로 사는 경로.
 *
 * 기존 `/api/purchase/*`는 **공용 데모 지갑**으로 도는 고정 라운드다(MCP 서버와 회귀 스크립트가
 * 그 경로를 쓴다). 여기를 따로 두는 이유는 두 경로의 신원 모델이 다르기 때문이다. 이쪽은
 * 요청마다 "누구인가"가 정해지고, 그 사람의 에이전트 지갑·정책·이력만 보인다.
 *
 * 인증은 연결 시점 서명으로 발급한 토큰 하나다. 토큰이 없으면 어떤 라우트도 사용자 자원에
 * 닿지 못한다 — 주소만 받던 이전 구조에서는 남의 주소를 적어 넣으면 그 사람의 에이전트를
 * 조작할 수 있었다.
 */
import express from 'express';
import { MAIN_BUYER, NETWORK_LABEL } from './config.js';
import { buildDeps } from './auction-flow.js';
import {
  purchaseFromRequest,
  purchaseOne,
  refreshPurchases,
  settlePurchases,
  approvePurchase,
  cancelPurchase,
  assemblePurchaseReceipt,
} from './purchase-flow.js';
import { loadListings } from './lib/decision.js';
import { ensureUser } from './lib/onboarding.js';
import { grantToOwner, checkBudget, CAN_GRANT_SOL, PUBLIC_FAUCET_URL } from './lib/faucet.js';
import { buildDepositTx, submitSignedTx } from './lib/deposit.js';
import { issueNonce, verifyConnect, verifySignature, assertAddress, newAuthToken } from './lib/auth.js';
import { buildUserDeps, readPolicyLimits, writePolicyLimits, readBalances } from './lib/user-context.js';
import { getRound, persistRound, dropRound } from './lib/user-rounds.js';
import { findUserByToken, setAuthToken, touchUser, recordDeposit, clearPurchases } from './lib/store.js';
import { loadEnv, masterPasswordFor } from './lib/state.js';
import { UserError } from './lib/user-error.js';

/**
 * 서명 문구의 첫 줄. 승인과 거부가 같은 문구면 한쪽 서명을 다른 쪽에 재사용할 수 있다.
 * ASCII만 쓰는 이유는 데몬이 원문을 HTTP 헤더로 받기 때문이다(아래 approve-message 주석).
 */
const ACTION_HEADING = {
  approve: 'A2AHouse spending approval',
  reject: 'A2AHouse spending rejection',
};

export function createUserApi() {
  const router = express.Router();
  router.use(express.json({ limit: '256kb' }));

  /** 매 요청 config를 새로 읽는다(시드 재실행으로 값이 바뀌어도 안전). */
  function deps() {
    try {
      return buildDeps();
    } catch (e) {
      throw new UserError('서비스가 아직 준비되지 않았습니다. 잠시 후 다시 시도해 주세요.', 503);
    }
  }

  /** 인증 미들웨어. 토큰 → 사용자 → 그 사용자의 에이전트 지갑으로 도는 deps. */
  function auth(req, res, next) {
    const token = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '')
      || String(req.get('x-a2a-token') || '');
    const user = findUserByToken(token);
    if (!user) return res.status(401).json({ error: 'unauthorized', message: '지갑을 다시 연결해 주세요.' });
    req.user = user;
    try {
      req.deps = buildUserDeps(deps(), user);
    } catch (e) {
      return fail(res, e);
    }
    touchUser(user.owner_address);
    return next();
  }

  /** 오류 응답 한 곳. 사용자 문구와 개발자 로그를 분리한다. */
  function fail(res, e) {
    if (e instanceof UserError) return res.status(e.status).json({ error: 'user_error', message: e.message });
    console.error('[user-api]', e.message);
    return res.status(502).json({ error: 'internal', message: e.message });
  }

  // ---- 연결 (nonce 챌린지 → 서명 검증 → 토큰) ----

  router.post('/nonce', (req, res) => {
    try {
      const ownerAddress = String(req.body?.ownerAddress || '').trim();
      assertAddress(ownerAddress);
      res.json(issueNonce(ownerAddress));
    } catch (e) {
      res.status(400).json({ error: 'bad_request', message: e.message });
    }
  });

  /**
   * 연결 완료. 서명을 검증한 뒤에야 에이전트 지갑을 발급한다.
   *
   * 지갑 발급과 가스 지급을 함께 한다. 사용자 입장에서 "연결했더니 내 에이전트가 생겼다"가
   * 한 동작이어야 하고, 가스가 없으면 첫 구매가 이유 없이 실패한다.
   */
  router.post('/connect', async (req, res) => {
    try {
      const ownerAddress = String(req.body?.ownerAddress || '').trim();
      const message = String(req.body?.message || '');
      const signature = String(req.body?.signature || '');
      assertAddress(ownerAddress);
      if (!message || !signature) throw new UserError('서명 정보가 없습니다.');
      verifyConnect(ownerAddress, message, signature);

      const d = deps();
      const { user, created } = await ensureUser(ownerAddress, {
        daemonUrl: d.byRole[MAIN_BUYER].daemonUrl,
        masterPassword: masterPasswordFor(loadEnv(), MAIN_BUYER),
        config: d.config,
      });
      const token = newAuthToken();
      setAuthToken(ownerAddress, token);

      res.json({
        authToken: token,
        ownerAddress,
        agentAddress: user.agent_address,
        created,
        network: NETWORK_LABEL,
        note: created ? '에이전트 지갑을 발급했습니다.' : '기존 에이전트 지갑을 이어서 씁니다.',
      });
    } catch (e) {
      if (e instanceof UserError || /코드|서명|주소/.test(e.message)) {
        return res.status(400).json({ error: 'connect_failed', message: e.message });
      }
      return fail(res, e);
    }
  });

  // ---- 내 상태 ----

  /**
   * 화면 상단이 계속 보여주는 것: 두 지갑의 잔고와 지금 걸려 있는 한도.
   * **한도는 데몬에서 읽는다** — 상수를 돌려주면 사용자가 값을 바꾼 뒤에도 옛 숫자가 남는다.
   */
  router.get('/me', auth, async (req, res) => {
    try {
      const { user, deps: d } = req;
      const [owner, agent, policy] = await Promise.all([
        readBalances(user.owner_address, d.config.mint),
        readBalances(user.agent_address, d.config.mint),
        readPolicyLimits(d),
      ]);
      res.json({
        ownerAddress: user.owner_address,
        agentAddress: user.agent_address,
        owner,
        agent,
        policy,
        depositedUsdc: Number(user.deposited_usdc || 0),
        faucet: checkBudget(),
        network: NETWORK_LABEL,
      });
    } catch (e) {
      fail(res, e);
    }
  });

  /** 체험 자산. **오너 지갑에만** 준다 — 에이전트에 직접 넣으면 위임이 사라진다. */
  router.post('/faucet', auth, async (req, res) => {
    try {
      const out = await grantToOwner(req.user.owner_address, req.deps.config);
      res.status(out.granted ? 200 : 429).json(out);
    } catch (e) {
      fail(res, e);
    }
  });

  // ---- 에이전트 지갑 입금 (= 위임) ----

  /** 서명 없는 트랜잭션을 조립해 돌려준다. 서명은 사용자의 지갑에서만 일어난다. */
  router.post('/deposit/prepare', auth, async (req, res) => {
    try {
      const amountUsdc = Number(req.body?.amountUsdc);
      if (!Number.isFinite(amountUsdc) || amountUsdc <= 0) throw new UserError('입금액을 확인해 주세요.');
      const owner = await readBalances(req.user.owner_address, req.deps.config.mint);
      if (owner.usdc < amountUsdc) {
        throw new UserError(`오너 지갑 잔고가 부족합니다. 보유 ${owner.usdc} USDC, 요청 ${amountUsdc} USDC.`);
      }
      if (owner.sol <= 0) {
        throw new UserError(
          CAN_GRANT_SOL
            ? '지갑에 수수료용 SOL이 없습니다. 체험 자산을 먼저 받아 주세요.'
            : `지갑에 devnet SOL이 없어 트랜잭션을 보낼 수 없습니다. ${PUBLIC_FAUCET_URL} 에서 받아 주세요.`,
        );
      }
      const out = await buildDepositTx({
        ownerAddress: req.user.owner_address,
        agentAddress: req.user.agent_address,
        mint: req.deps.config.mint,
        amountUsdc,
      });
      res.json(out);
    } catch (e) {
      fail(res, e);
    }
  });

  /** 지갑이 서명한 것을 전송한다. 확정까지 기다린 뒤 잔고를 함께 돌려준다. */
  router.post('/deposit/submit', auth, async (req, res) => {
    try {
      const signedTx = String(req.body?.signedTx || '');
      const amountUsdc = Number(req.body?.amountUsdc || 0);
      if (!signedTx) throw new UserError('서명된 트랜잭션이 없습니다.');
      const signature = await submitSignedTx(signedTx);
      if (amountUsdc > 0) recordDeposit(req.user.owner_address, amountUsdc);
      const agent = await readBalances(req.user.agent_address, req.deps.config.mint);
      res.json({ signature, agent, note: '에이전트가 쓸 수 있는 자금이 늘었습니다.' });
    } catch (e) {
      fail(res, e);
    }
  });

  // ---- 정책 ----

  router.get('/policy', auth, async (req, res) => {
    try {
      res.json(await readPolicyLimits(req.deps));
    } catch (e) {
      fail(res, e);
    }
  });

  /**
   * 한도 변경. **입금액이 상한이다** — 맡기지 않은 돈까지 한도로 열어 두면 정책이 실제로는
   * 아무것도 제한하지 않는 장식이 된다. 위임의 크기는 사용자가 실제로 보낸 만큼이다.
   */
  router.put('/policy', auth, async (req, res) => {
    try {
      const agent = await readBalances(req.user.agent_address, req.deps.config.mint);
      const delayMaxUsdc = Number(req.body?.delayMaxUsdc);
      const notifyMaxUsdc = Number(req.body?.notifyMaxUsdc);
      if (delayMaxUsdc > agent.usdc) {
        throw new UserError(
          `한도는 에이전트에게 맡긴 금액을 넘을 수 없습니다. 현재 맡긴 금액 ${agent.usdc} USDC.`,
        );
      }
      const out = await writePolicyLimits(req.deps, { notifyMaxUsdc, delayMaxUsdc });
      const round = getRound(req.user.owner_address);
      round.state.buyer = { ...round.state.buyer, policy: out };
      res.json(out);
    } catch (e) {
      fail(res, e);
    }
  });

  // ---- 구매 ----

  router.get('/catalog', (_req, res) => res.json({ listings: loadListings() }));

  /**
   * 자유 요청 구매. 사용자가 필요한 것을 쓰면 에이전트가 카탈로그에서 고르고 산다.
   *
   * 오래 걸리는 작업이라(모델 선택 + 온체인 3단계) 즉시 202로 돌려주고 폴링이 진행을 잡는다.
   * 실패는 상태에 실어 화면이 이유를 설명하게 한다 — 원인 불명의 실패는 서비스 고장으로 읽힌다.
   */
  router.post('/purchase', auth, async (req, res) => {
    const owner = req.user.owner_address;
    const round = getRound(owner, await buyerInfo(req));
    if (round.running) {
      return res.status(409).json({ error: 'busy', message: '앞선 요청이 아직 진행 중입니다.' });
    }
    // 두 가지 방식이 있다. 자연어를 주면 우리 에이전트가 고르고(컷 3), 리스팅을 지정하면
    // 호출자가 이미 골랐다는 뜻이다(MCP 클라이언트의 LLM이 list_skills로 판단한 경우).
    const listingId = String(req.body?.listingId || '').trim();
    const prompt = String(req.body?.prompt || '').trim();
    if (!prompt && !listingId) {
      return res.status(400).json({ error: 'bad_request', message: '무엇이 필요한지 적어 주세요.' });
    }

    // 잔고를 미리 본다. 정책이 아니라 잔고 때문에 실패하는 것을 정책 거부로 오해하면
    // 이 데모가 설명하려는 것이 통째로 뒤집힌다.
    try {
      const agent = await readBalances(req.user.agent_address, req.deps.config.mint);
      const cheapest = Math.min(...loadListings().map((l) => l.priceUsdc));
      if (agent.usdc < cheapest) {
        return res.status(400).json({
          error: 'insufficient_funds',
          message:
            `에이전트 지갑에 USDC가 부족합니다(현재 ${agent.usdc} USDC). ` +
            `가장 싼 능력이 ${cheapest} USDC이므로 먼저 입금해 주세요.`,
        });
      }
      // 가스는 입금 트랜잭션에 함께 실려 온다. 그래도 바닥나면 온체인 단계에서 이유를
      // 알 수 없는 실패가 나므로, 실행 전에 잡아 무엇을 해야 하는지 말해 준다.
      if (agent.sol < 0.002) {
        return res.status(400).json({
          error: 'insufficient_gas',
          message:
            `에이전트 지갑의 가스(SOL)가 부족합니다(현재 ${agent.sol.toFixed(4)} SOL). ` +
            '입금을 한 번 더 하시면 가스도 함께 채워집니다.',
        });
      }
    } catch (e) {
      return fail(res, e);
    }

    // id를 여기서 발급해 즉시 돌려준다. 이 요청은 오래 걸려 202로 끊기는데, 호출자가 id를
    // 모르면 무엇을 폴링해야 할지 알 수 없다(MCP가 판정을 응답으로 싣기 위해 필요하다).
    const requestId = `req-${Date.now().toString(36)}-${round.state.purchases.length + 1}`;

    round.running = true;
    round.state.error = null;
    round.state.phase = 'choosing';
    const run = listingId
      ? purchaseOne(round.state, req.deps, { listingId, title: req.body?.title, need: req.body?.need, requestId })
      : purchaseFromRequest(round.state, req.deps, {
          prompt,
          title: req.body?.title,
          need: req.body?.need,
          requestId,
        });
    run
      .then(() => persistRound(owner, round.state))
      .catch((e) => {
        round.state.phase = 'error';
        round.state.error = friendly(e.message);
        console.error('[user-api] 구매 실패:', e.message);
      })
      .finally(() => {
        round.running = false;
      });

    res.status(202).json({ accepted: true, requestId });
  });

  router.get('/purchase/state', auth, async (req, res) => {
    const owner = req.user.owner_address;
    const round = getRound(owner);
    // 유예는 시간이 지나면 스스로 풀린다. 폴링이 그 변화를 잡는 유일한 경로다.
    if (!round.running && round.state.purchases.length) {
      try {
        if (await refreshPurchases(round.state, req.deps)) persistRound(owner, round.state);
      } catch (e) {
        console.error('[user-api] 상태 갱신 실패:', e.message);
      }
    }
    res.json({ ...round.state, running: round.running, network: NETWORK_LABEL });
  });

  router.post('/purchase/settle', auth, (req, res) => {
    const owner = req.user.owner_address;
    const round = getRound(owner);
    if (round.running) return res.status(409).json({ error: 'busy', message: '진행 중입니다.' });
    round.running = true;
    settlePurchases(round.state, req.deps)
      .then(() => persistRound(owner, round.state))
      .catch((e) => {
        round.state.error = friendly(e.message);
        console.error('[user-api] 정산 실패:', e.message);
      })
      .finally(() => {
        round.running = false;
      });
    res.status(202).json({ settling: true });
  });

  /**
   * 승인(컷 5). **서명은 사용자의 지갑에서 온다.**
   *
   * 사용자별 에이전트 지갑은 오너가 접속자 본인이라 서버가 대신 서명할 수 없다. 서버는 받은
   * 서명이 ⓐ 이 사용자의 주소로 검증되고 ⓑ 그 tx를 가리키는지만 확인해 데몬에 중계한다.
   */
  router.post('/purchase/approve/:requestId', auth, async (req, res) => {
    try {
      const { round, purchase, ownerSig } = checkOwnerAction(req, 'approve');
      round.running = true;
      try {
        await approvePurchase(round.state, req.deps, purchase.requestId, ownerSig);
        persistRound(req.user.owner_address, round.state);
      } finally {
        round.running = false;
      }
      res.json({ requestId: purchase.requestId, verdict: purchase.ui });
    } catch (e) {
      fail(res, e);
    }
  });

  /**
   * 거부·취소. **승인만 있고 이게 없으면 대기 큐가 영원히 쌓인다** — 남은 대기 건이 이후
   * 판정을 전부 APPROVAL로 밀어올려 정책 대조가 조용히 무너진다(리허설에서 실측된 함정).
   * 사용자 입장에서도 "맡긴 걸 거둘 수 없는" 위임은 위임이 아니다.
   */
  router.post('/purchase/cancel/:requestId', auth, async (req, res) => {
    try {
      const round = getRound(req.user.owner_address);
      const purchase = round.state.purchases.find((p) => p.requestId === req.params.requestId);
      if (!purchase) throw new UserError('그 구매 건을 찾을 수 없습니다.', 404);
      // 유예 취소는 세션 권한으로 되고, 승인 대기 거부만 오너 서명을 요구한다(데몬 규약).
      const ownerSig = purchase.ui === 'APPROVAL' ? checkOwnerAction(req, 'reject').ownerSig : null;

      round.running = true;
      try {
        await cancelPurchase(round.state, req.deps, purchase.requestId, ownerSig);
        persistRound(req.user.owner_address, round.state);
      } finally {
        round.running = false;
      }
      res.json({ requestId: purchase.requestId, verdict: purchase.ui });
    } catch (e) {
      fail(res, e);
    }
  });

  /**
   * 오너 서명 검증 공통부. 세 가지를 본다 — 대기 중인 건인가, 그 건에 대한 서명인가,
   * 연결된 지갑에서 나온 서명인가. 하나라도 빠지면 남의 건을 승인하거나 재사용이 열린다.
   */
  function checkOwnerAction(req, action) {
    const owner = req.user.owner_address;
    const round = getRound(owner);
    if (round.running) throw new UserError('진행 중입니다. 잠시 후 다시 시도해 주세요.', 409);

    const purchase = round.state.purchases.find((p) => p.requestId === req.params.requestId);
    if (!purchase) throw new UserError('그 구매 건을 찾을 수 없습니다.', 404);

    const message = String(req.body?.message || '');
    const signature = String(req.body?.signature || '');
    if (!message || !signature) throw new UserError('지갑 서명이 필요합니다.');
    if (!message.includes(String(purchase.txId))) throw new UserError('다른 건에 대한 서명입니다.');
    if (!message.startsWith(ACTION_HEADING[action])) {
      throw new UserError('승인과 거부의 서명 문구가 다릅니다. 다시 시도해 주세요.');
    }
    if (!verifySignature(owner, message, signature)) {
      throw new UserError('서명이 연결된 지갑과 맞지 않습니다.');
    }
    return { round, purchase, ownerSig: { address: owner, message, signature } };
  }

  /**
   * 승인 서명에 쓸 문구.
   *
   * **한 줄 ASCII만 쓴다.** 데몬이 서명 원문을 `X-Owner-Message` 헤더로 받는데(Solana 경로는
   * 헤더 값을 UTF-8 raw로 읽는다 — EVM SIWE만 base64를 디코딩한다), HTTP 헤더 값은 latin1
   * 범위이고 개행을 담을 수 없다. 한글이나 줄바꿈을 넣으면 요청 자체가 만들어지지 않는다.
   * 무엇을 승인하는지에 대한 한국어 설명은 화면이 맡고, 서명 문구에는 지갑 팝업에서 대조할
   * 수 있는 금액·거래·시각만 싣는다.
   */
  router.get('/purchase/approve-message/:requestId', auth, (req, res) => {
    const round = getRound(req.user.owner_address);
    const purchase = round.state.purchases.find((p) => p.requestId === req.params.requestId);
    if (!purchase?.txId) return res.status(404).json({ error: 'not_found', message: '승인할 건이 없습니다.' });
    const action = req.query.action === 'reject' ? 'reject' : 'approve';
    res.json({
      action,
      message:
        `${ACTION_HEADING[action]} | amount: ${purchase.amountUsdc} USDC` +
        ` | tx: ${purchase.txId} | time: ${new Date().toISOString()}`,
      // 화면이 사람에게 보여줄 설명. 서명 원문과 다른 층이다.
      summary: `${purchase.listing.title} · ${purchase.amountUsdc} USDC`,
    });
  });

  router.get('/purchase/receipt', auth, (req, res) => {
    const receipt = assemblePurchaseReceipt(getRound(req.user.owner_address).state);
    if (!receipt) return res.status(404).json({ error: 'no_round', message: '아직 구매 기록이 없습니다.' });
    res.json({ ...receipt, network: NETWORK_LABEL });
  });

  /** 화면 초기화. 이력(DB)까지 지울지는 명시적으로 받는다. */
  router.post('/purchase/reset', auth, (req, res) => {
    const owner = req.user.owner_address;
    const round = getRound(owner);
    if (round.running) return res.status(409).json({ error: 'busy', message: '진행 중입니다.' });
    if (req.body?.purgeHistory) clearPurchases(owner);
    dropRound(owner);
    res.json({ reset: true });
  });

  /** 라운드 상태에 실을 사용자 정보(표시용 + 실제 정책값). */
  async function buyerInfo(req) {
    const policy = await readPolicyLimits(req.deps);
    return {
      role: 'me',
      name: '내 에이전트',
      emoji: '🤖',
      agentAddress: req.user.agent_address,
      policy,
    };
  }

  return router;
}

/**
 * 내부 오류 문구를 사용자가 행동할 수 있는 말로 바꾼다.
 * 원문은 로그에 남고, 화면에는 다음에 할 일이 보여야 한다.
 */
function friendly(message) {
  if (/insufficient|InsufficientFunds|0x1$/i.test(message)) {
    return '에이전트 지갑의 잔고가 부족합니다. 오너 지갑에서 USDC를 더 입금해 주세요.';
  }
  if (/POLICY_DENIED|denied/i.test(message)) {
    return '정책이 이 거래를 막았습니다. 허용 목록이나 한도를 확인해 주세요.';
  }
  if (/AlreadyRevealed|already/i.test(message)) {
    return '이미 처리된 건입니다. 화면을 새로 고쳐 주세요.';
  }
  if (/quota|429|RESOURCE_EXHAUSTED/i.test(message)) {
    return '판단 모델의 호출 한도에 걸려 규칙 기반으로 골랐습니다.';
  }
  return `요청을 끝내지 못했습니다: ${message}`;
}

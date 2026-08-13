/**
 * 사용자 온보딩: 지갑 연결 → 에이전트 지갑 발급.
 *
 * **사용자마다 자기 에이전트 지갑을 갖는다.** 고정 지갑을 모두가 공유하던 구조에서는
 * 오너가 한 명뿐이라 누구도 자기 것으로 승인할 수 없었고, 동시 접속자의 대기 큐가
 * 서로를 오염시켰다. 지갑을 나누면 그 둘이 함께 사라진다.
 *
 * 신원은 **연결한 지갑 주소**다. 서버가 계정을 발급하지 않는다.
 *
 * 자금 모델(중요): faucet은 **오너 지갑에만** 준다. 에이전트 지갑에 직접 넣으면 위임
 * 관계를 건너뛰게 되고, 그러면 "얼마까지 맡겼는가"라는 이 데모의 주제가 사라진다.
 * 오너가 자기 서명으로 에이전트 지갑에 입금하는 것이 곧 위임 행위다.
 */
import { TOKEN_LIMITS, DELAY_SECONDS, MAIN_BUYER, PROGRAM_ID, X402_ALLOWED_DOMAIN, NETWORK } from '../config.js';
import { findUser, upsertUser } from './store.js';

/** 신규 사용자에게 부여할 정책. 주인공 바이어와 같은 값에서 출발하고, 이후 본인이 조정한다. */
const DEFAULT_LIMITS = TOKEN_LIMITS[MAIN_BUYER];

async function daemonFetch(daemonUrl, method, path, headers, body) {
  const res = await fetch(`${daemonUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (res.status >= 300) {
    throw new Error(`${path} 실패 ${res.status}: ${json.message || json.error || text.slice(0, 200)}`);
  }
  return json;
}

/**
 * 에이전트 지갑을 만들고 오너를 등록한다.
 *
 * 신규 지갑은 오너가 비어 있어(NONE) 연결한 주소를 그대로 등록할 수 있다 —
 * 기존 지갑을 재사용하면 `OWNER_ALREADY_CONNECTED`로 막힌다. 이것이 지갑을 나누는
 * 실질적 이유 중 하나다.
 */
async function createAgentWallet(daemonUrl, masterPassword, ownerAddress, config) {
  const mpw = { 'X-Master-Password': masterPassword };

  const created = await daemonFetch(daemonUrl, 'POST', '/v1/wallets', mpw, {
    name: `agent-${ownerAddress.slice(0, 8)}`,
    chain: 'solana',
    createSession: true,
  });
  const walletId = created.id ?? created.walletId;
  const sessionToken = created.sessionToken ?? created.session?.token;
  if (!walletId || !sessionToken) {
    throw new Error(`지갑 생성 응답에 id/sessionToken이 없다: ${JSON.stringify(created).slice(0, 200)}`);
  }

  await daemonFetch(daemonUrl, 'PUT', `/v1/wallets/${walletId}/owner`, mpw, {
    owner_address: ownerAddress,
    approval_method: 'rest',
  });

  const policyIds = await createPolicies(daemonUrl, mpw, walletId, config);
  return { walletId, sessionToken, address: created.address ?? created.publicKey, policyIds };
}

/**
 * 정책 5종. 시드가 고정 지갑에 하던 것과 같은 세트다.
 * SPENDING_LIMIT의 세 값을 벌리는 것이 이 데모의 핵심이라 여기서도 그대로 적용한다.
 */
async function createPolicies(daemonUrl, mpw, walletId, config) {
  const mk = async (type, rules) => {
    const r = await daemonFetch(daemonUrl, 'POST', '/v1/policies', mpw, {
      walletId, type, rules, priority: 0, enabled: true,
    });
    return r.id;
  };

  return {
    contractWhitelist: await mk('CONTRACT_WHITELIST', {
      contracts: [{ address: PROGRAM_ID, name: 'a2a-auction' }],
    }),
    // 라운드마다 오케스트레이터가 auction_pda를 더한다. 셀러는 정산·x402 수신처라 미리 연다.
    whitelist: await mk('WHITELIST', { allowed_addresses: [PROGRAM_ID, config.seller] }),
    allowedTokens: await mk('ALLOWED_TOKENS', {
      tokens: [{ address: config.mint, symbol: 'USDC', assetId: config.assetId }],
    }),
    spendingLimit: await mk('SPENDING_LIMIT', {
      token_limits: { [config.assetId]: { ...DEFAULT_LIMITS } },
      delay_seconds: DELAY_SECONDS,
    }),
    x402Domains: await mk('X402_ALLOWED_DOMAINS', { domains: [X402_ALLOWED_DOMAIN] }),
  };
}

/**
 * 연결한 지갑으로 사용자를 확보한다(멱등).
 *
 * 이미 있으면 기존 에이전트 지갑을 그대로 돌려준다 — 재접속마다 새 지갑을 만들면
 * 자금과 이력이 흩어지고, 사용자는 어제 산 것을 못 찾는다.
 *
 * @param {string} ownerAddress - 연결한 지갑 주소 (Phantom·D'CENT 등)
 * @param {{daemonUrl:string, masterPassword:string, config:object}} deps
 */
export async function ensureUser(ownerAddress, { daemonUrl, masterPassword, config }) {
  const existing = findUser(ownerAddress);
  if (existing) return { user: existing, created: false };

  const agent = await createAgentWallet(daemonUrl, masterPassword, ownerAddress, config);
  const user = upsertUser({
    ownerAddress,
    agentWalletId: agent.walletId,
    agentAddress: agent.address,
    sessionToken: agent.sessionToken,
    policyIds: agent.policyIds,
  });
  return { user, created: true };
}

/** 저장된 사용자로 데몬 클라이언트 인자를 만든다(daemonClient가 기대하는 모양). */
export function walletRefOf(user, daemonUrl) {
  return {
    daemonUrl,
    walletId: user.agent_wallet_id,
    address: user.agent_address,
    network: NETWORK,
    sessionToken: user.session_token,
  };
}

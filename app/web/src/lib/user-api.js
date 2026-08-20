/**
 * 사용자 API(`/api/u/*`) 클라이언트.
 *
 * 토큰 하나가 신원의 전부다. 연결 시 서명으로 받아 두고 이후 모든 요청에 싣는다.
 * 서버가 401을 돌려주면 그 자리에서 토큰을 버린다 — 죽은 토큰을 들고 계속 두드리면
 * 화면이 "왜 안 되는지 모르는 상태"에 머문다.
 */
const TOKEN_KEY = 'a2a.authToken';

export function savedToken() {
  try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
}

export function saveToken(token) {
  try { localStorage.setItem(TOKEN_KEY, token); } catch { /* 저장 차단 환경 */ }
}

export function clearToken() {
  try { localStorage.removeItem(TOKEN_KEY); } catch { /* noop */ }
}

/** 서버가 준 사용자용 문구를 그대로 띄우기 위한 오류. */
export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function call(method, path, body) {
  const token = savedToken();
  const res = await fetch(`/api/u${path}`, {
    method,
    cache: 'no-store',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = {}; }
  if (res.status === 401) {
    clearToken();
    throw new ApiError(json.message || '지갑을 다시 연결해 주세요.', 401);
  }
  if (res.status >= 300) {
    throw new ApiError(json.message || `요청이 실패했습니다 (${res.status})`, res.status);
  }
  return json;
}

// ---- 연결 ----
export const requestNonce = (ownerAddress) => call('POST', '/nonce', { ownerAddress });
export const submitConnect = (ownerAddress, message, signature) =>
  call('POST', '/connect', { ownerAddress, message, signature });

// ---- 내 상태 ----
export const fetchMe = () => call('GET', '/me');
export const claimFaucet = () => call('POST', '/faucet');

// ---- 입금 ----
export const prepareDeposit = (amountUsdc) => call('POST', '/deposit/prepare', { amountUsdc });
export const submitDeposit = (signedTx, amountUsdc) => call('POST', '/deposit/submit', { signedTx, amountUsdc });

// ---- 정책 ----
export const savePolicy = (notifyMaxUsdc, delayMaxUsdc) => call('PUT', '/policy', { notifyMaxUsdc, delayMaxUsdc });

// ---- 구매 ----
export const fetchCatalog = () => call('GET', '/catalog');

/**
 * 요청을 맡긴다. `priceWeight`는 후보 화면에서 사용자가 정한 가격 비중(0~1)이고,
 * 서버는 그 가중치로 매긴 1위를 그대로 산다 — 화면이 보여준 1위와 실제 구매가 어긋나면
 * 이 데모에서 가장 중요한 장면이 무너진다.
 */
export const submitRequest = (prompt, priceWeight) =>
  call('POST', '/purchase', { prompt, ...(priceWeight != null ? { priceWeight } : {}) });

/** 결과물 본문과 채점. 정산 전에는 409가 온다(x402 열람 게이트). */
export const fetchResult = (requestId) => call('GET', `/purchase/result/${requestId}`);
export const fetchRoundState = () => call('GET', '/purchase/state');
export const settleRound = () => call('POST', '/purchase/settle');
export const fetchReceipt = () => call('GET', '/purchase/receipt');
export const resetRound = (purgeHistory = false) => call('POST', '/purchase/reset', { purgeHistory });

/** 승인·거부에 쓸 서명 문구. action에 따라 첫 줄이 다르다(서명 재사용 차단). */
export const fetchActionMessage = (requestId, action) =>
  call('GET', `/purchase/approve-message/${requestId}?action=${action}`);

export const approveRequest = (requestId, message, signature) =>
  call('POST', `/purchase/approve/${requestId}`, { message, signature });

export const cancelRequest = (requestId, message, signature) =>
  call('POST', `/purchase/cancel/${requestId}`, { message, signature });

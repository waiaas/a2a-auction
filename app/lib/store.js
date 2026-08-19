/**
 * A2AHouse 영속 저장소 (JSON 파일).
 *
 * **실 사용자 기준으로 설계한다.** 서버가 재시작해도 사용자의 에이전트 지갑과 구매 이력이
 * 남아야 하고, 어제 산 것을 오늘 영수증에서 볼 수 있어야 한다. 데모용 메모리 상태로는
 * 그 둘 다 안 된다.
 *
 * 키는 **오너 지갑 주소**다. 사용자가 Phantom·D'CENT 등으로 연결한 그 주소이고,
 * 서버가 계정을 발급하지 않는다 — 지갑이 곧 신원이다.
 *
 * **SQLite가 아니라 JSON인 이유**: 처음에는 `better-sqlite3`를 썼는데 배포 VM에서
 * 프리빌트도 소스 빌드도 segfault로 죽었다(Node 20 / Ubuntu, exit 139). 저장하는 것은
 * 사용자 수십 명과 그들의 구매 목록뿐이고 프로세스도 하나라, 네이티브 확장을 쓸 이유가
 * 없다. 배포 환경마다 컴파일이 필요한 의존성은 이 규모에서 순수한 비용이다.
 *
 * 쓰기는 임시 파일에 쓰고 rename한다 — 중간에 죽어도 반쯤 쓰인 파일이 남지 않는다.
 * 파일에 세션 토큰이 들어가므로 0600으로 만들고 gitignore한다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../config.js';

const DB_PATH = process.env.A2A_DB_PATH || path.join(ROOT, 'app', 'a2ahouse.json');

/** { users: {addr: row}, purchases: {id: {ownerAddress, payload, createdAt}} } */
let cache = null;

function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    cache.users ??= {};
    cache.purchases ??= {};
  } catch {
    cache = { users: {}, purchases: {} }; // 파일이 없거나 깨졌으면 빈 상태로 시작한다
  }
  return cache;
}

/** 임시 파일 → rename. 중간에 죽어도 기존 파일이 온전히 남는다. */
function flush() {
  const tmp = `${DB_PATH}.tmp`;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(cache), { mode: 0o600 });
  fs.renameSync(tmp, DB_PATH);
}

const nowIso = () => new Date().toISOString();

/** 오너 주소로 사용자 조회. 없으면 null. */
export function findUser(ownerAddress) {
  const row = load().users[ownerAddress];
  return row ? { ...row, policyIds: row.policy_ids } : null;
}

/**
 * 사용자 등록. 이미 있으면 에이전트 지갑을 새로 만들지 않고 기존 것을 돌려준다 —
 * 재접속마다 지갑이 늘어나면 자금과 이력이 흩어진다.
 */
export function upsertUser({ ownerAddress, agentWalletId, agentAddress, sessionToken, policyIds }) {
  const db = load();
  const prev = db.users[ownerAddress];
  db.users[ownerAddress] = {
    owner_address: ownerAddress,
    agent_wallet_id: prev?.agent_wallet_id ?? agentWalletId,
    agent_address: prev?.agent_address ?? agentAddress,
    session_token: sessionToken,
    policy_ids: policyIds,
    auth_token: prev?.auth_token ?? null,
    funded_sol: prev?.funded_sol ?? 0,
    funded_usdc: prev?.funded_usdc ?? 0,
    deposited_usdc: prev?.deposited_usdc ?? 0,
    created_at: prev?.created_at ?? nowIso(),
    last_seen_at: nowIso(),
  };
  flush();
  return findUser(ownerAddress);
}

export function touchUser(ownerAddress) {
  const u = load().users[ownerAddress];
  if (!u) return;
  u.last_seen_at = nowIso();
  flush();
}

/**
 * 연결 서명 검증에 성공한 사용자에게 인증 토큰을 발급한다.
 *
 * 이 토큰이 "이 브라우저가 그 지갑의 주인임을 증명했다"는 사실의 유일한 근거다. 이게 없으면
 * 주소만 보내도 남의 에이전트 지갑을 조작할 수 있다.
 */
export function setAuthToken(ownerAddress, token) {
  const u = load().users[ownerAddress];
  if (!u) return;
  u.auth_token = token;
  u.last_seen_at = nowIso();
  flush();
}

/** 인증 토큰으로 사용자 조회. 모든 사용자 API가 이 경로로 신원을 정한다. */
export function findUserByToken(token) {
  if (!token) return null;
  const row = Object.values(load().users).find((u) => u.auth_token === token);
  return row ? { ...row, policyIds: row.policy_ids } : null;
}

/** faucet 지급량 누적. 상한 판정의 근거가 되므로 지급 직후에 기록한다. */
export function recordFunding(ownerAddress, { sol = 0, usdc = 0 }) {
  const u = load().users[ownerAddress];
  if (!u) return;
  u.funded_sol += sol;
  u.funded_usdc += usdc;
  flush();
}

/** 오너가 에이전트 지갑에 입금한 누적액. */
export function recordDeposit(ownerAddress, usdc) {
  const u = load().users[ownerAddress];
  if (!u) return;
  u.deposited_usdc += usdc;
  flush();
}

/** 지금까지 faucet이 내보낸 SOL 총합. 전체 상한 판정에 쓴다. */
export function totalFundedSol() {
  return Object.values(load().users).reduce((s, u) => s + (u.funded_sol || 0), 0);
}

export function countUsers() {
  return Object.keys(load().users).length;
}

/**
 * 구매 1건 저장. 진행 중 여러 번 갱신되므로 id 기준 덮어쓰기다.
 * payload는 구매 객체 전체를 넣는다 — 필드를 잘게 나누면 흐름이 바뀔 때마다 마이그레이션이
 * 필요한데, 이 데이터의 소비자는 화면과 영수증뿐이라 통짜가 맞다.
 */
export function savePurchase(ownerAddress, purchase) {
  const db = load();
  const id = `${ownerAddress}:${purchase.requestId}`;
  db.purchases[id] = {
    ownerAddress,
    payload: purchase,
    createdAt: db.purchases[id]?.createdAt ?? nowIso(),
  };
  flush();
}

/** 사용자의 구매 이력. 최신순. */
export function listPurchases(ownerAddress, limit = 50) {
  return Object.values(load().purchases)
    .filter((p) => p.ownerAddress === ownerAddress)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, limit)
    .map((p) => p.payload);
}

/**
 * 구매 이력만 지운다. 사용자 행은 남기므로 **연결 상태와 에이전트 지갑이 유지된다** —
 * 화면 초기화 때 사용자까지 지우면 인증 토큰이 죽어 그 자리에서 로그아웃된다.
 */
export function clearPurchases(ownerAddress) {
  const db = load();
  for (const [id, p] of Object.entries(db.purchases)) {
    if (p.ownerAddress === ownerAddress) delete db.purchases[id];
  }
  flush();
}

/** 테스트·리허설 초기화용. 사용자와 이력을 함께 지운다. */
export function clearUser(ownerAddress) {
  const db = load();
  clearPurchases(ownerAddress);
  delete db.users[ownerAddress];
  flush();
}

export const DB_FILE = DB_PATH;

/**
 * A2AHouse 영속 저장소.
 *
 * **실 사용자 기준으로 설계한다.** 서버가 재시작해도 사용자의 에이전트 지갑과 구매 이력이
 * 남아야 하고, 어제 산 것을 오늘 영수증에서 볼 수 있어야 한다. 데모용 메모리 상태로는
 * 그 둘 다 안 된다.
 *
 * 키는 **오너 지갑 주소**다. 사용자가 Phantom·D'CENT 등으로 연결한 그 주소이고,
 * 서버가 계정을 발급하지 않는다 — 지갑이 곧 신원이다.
 *
 * 파일에 세션 토큰이 들어가므로 0600으로 만들고 gitignore한다.
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { ROOT } from '../config.js';

const DB_PATH = process.env.A2A_DB_PATH || path.join(ROOT, 'app', 'a2ahouse.db');

let db;

/** 최초 접근 시 파일을 만들고 스키마를 세운다. 이후 호출은 같은 연결을 쓴다. */
function conn() {
  if (db) return db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH);
  // 동시 읽기 중 쓰기가 막히지 않게. 폴링이 잦은 화면이라 읽기가 많다.
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      owner_address     TEXT PRIMARY KEY,
      agent_wallet_id   TEXT NOT NULL,
      agent_address     TEXT NOT NULL,
      session_token     TEXT NOT NULL,
      policy_ids        TEXT NOT NULL,
      funded_sol        REAL NOT NULL DEFAULT 0,
      funded_usdc       REAL NOT NULL DEFAULT 0,
      created_at        TEXT NOT NULL,
      last_seen_at      TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS purchases (
      id             TEXT PRIMARY KEY,
      owner_address  TEXT NOT NULL REFERENCES users(owner_address),
      payload        TEXT NOT NULL,
      created_at     TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_purchases_owner ON purchases(owner_address, created_at DESC);
  `);
  try {
    fs.chmodSync(DB_PATH, 0o600); // 세션 토큰이 들어 있다
  } catch { /* 파일시스템이 권한을 무시하는 환경 */ }
  return db;
}

const nowIso = () => new Date().toISOString();

/** 오너 주소로 사용자 조회. 없으면 null. */
export function findUser(ownerAddress) {
  const row = conn().prepare('SELECT * FROM users WHERE owner_address = ?').get(ownerAddress);
  return row ? { ...row, policyIds: JSON.parse(row.policy_ids) } : null;
}

/**
 * 사용자 등록. 이미 있으면 에이전트 지갑을 새로 만들지 않고 기존 것을 돌려준다 —
 * 재접속마다 지갑이 늘어나면 자금과 이력이 흩어진다.
 */
export function upsertUser({ ownerAddress, agentWalletId, agentAddress, sessionToken, policyIds }) {
  conn()
    .prepare(
      `INSERT INTO users (owner_address, agent_wallet_id, agent_address, session_token, policy_ids, created_at, last_seen_at)
       VALUES (@ownerAddress, @agentWalletId, @agentAddress, @sessionToken, @policyIds, @now, @now)
       ON CONFLICT(owner_address) DO UPDATE SET
         session_token = excluded.session_token,
         policy_ids    = excluded.policy_ids,
         last_seen_at  = excluded.last_seen_at`,
    )
    .run({
      ownerAddress,
      agentWalletId,
      agentAddress,
      sessionToken,
      policyIds: JSON.stringify(policyIds),
      now: nowIso(),
    });
  return findUser(ownerAddress);
}

export function touchUser(ownerAddress) {
  conn().prepare('UPDATE users SET last_seen_at = ? WHERE owner_address = ?').run(nowIso(), ownerAddress);
}

/** faucet 지급량 누적. 상한 판정의 근거가 되므로 지급 직후에 기록한다. */
export function recordFunding(ownerAddress, { sol = 0, usdc = 0 }) {
  conn()
    .prepare('UPDATE users SET funded_sol = funded_sol + ?, funded_usdc = funded_usdc + ? WHERE owner_address = ?')
    .run(sol, usdc, ownerAddress);
}

/** 지금까지 faucet이 내보낸 SOL 총합. 전체 상한 판정에 쓴다. */
export function totalFundedSol() {
  return conn().prepare('SELECT COALESCE(SUM(funded_sol), 0) AS total FROM users').get().total;
}

export function countUsers() {
  return conn().prepare('SELECT COUNT(*) AS n FROM users').get().n;
}

/**
 * 구매 1건 저장. 진행 중 여러 번 갱신되므로 id 기준 덮어쓰기다.
 * payload는 구매 객체 전체를 JSON으로 넣는다 — 컬럼을 잘게 나누면 흐름이 바뀔 때마다
 * 마이그레이션이 필요한데, 이 데이터의 소비자는 화면과 영수증뿐이라 통짜가 맞다.
 */
export function savePurchase(ownerAddress, purchase) {
  conn()
    .prepare(
      `INSERT INTO purchases (id, owner_address, payload, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET payload = excluded.payload`,
    )
    .run(`${ownerAddress}:${purchase.requestId}`, ownerAddress, JSON.stringify(purchase), nowIso());
}

/** 사용자의 구매 이력. 최신순. */
export function listPurchases(ownerAddress, limit = 50) {
  return conn()
    .prepare('SELECT payload FROM purchases WHERE owner_address = ? ORDER BY created_at DESC LIMIT ?')
    .all(ownerAddress, limit)
    .map((r) => JSON.parse(r.payload));
}

/** 테스트·리허설 초기화용. 사용자와 이력을 함께 지운다. */
export function clearUser(ownerAddress) {
  conn().prepare('DELETE FROM purchases WHERE owner_address = ?').run(ownerAddress);
  conn().prepare('DELETE FROM users WHERE owner_address = ?').run(ownerAddress);
}

export const DB_FILE = DB_PATH;

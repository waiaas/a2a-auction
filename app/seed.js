/**
 * 멱등 시드 (스펙 7.4). 어떤 시작 상태에서도 데모가 돌 수 있는 알려진 상태로 수렴시킨다.
 *
 * 하는 일:
 *  1) 데몬 5개 health + localnet 확인
 *  2) 온체인: SOL airdrop / USDC mint(재사용) / seller ATA / buyer USDC top-up
 *  3) 정책: buyer별 전부 삭제 후 결정론적 재등록 (WHITELIST 베이스라인 = [programId])
 *  4) B owner: Ed25519 서명으로 verify (이미 verified면 스킵)
 *  5) demo-config.json 기록 (mint·assetId·sellerAta·policyIds·nextAuctionId)
 *
 * 실행: node seed.js   ← Bash 도구는 dangerouslyDisableSandbox:true (루프백·LAN RPC 차단 회피)
 * 시크릿(마스터PW·owner키)은 화면·config에 출력하지 않는다.
 */
import {
  CAIP2,
  PROGRAM_ID,
  FUND_TARGET,
  TOKEN_LIMITS,
  AMOUNTS,
} from './config.js';
import {
  loadStateByRole,
  loadEnv,
  masterPasswordFor,
  loadDeployer,
  loadConfig,
  saveConfig,
} from './lib/state.js';
import { connection, Keypair, signEd25519 } from './lib/solana.js';
import { daemonClient } from './lib/daemon.js';
import {
  ensureSol,
  ensureMint,
  ensureAta,
  ensureTokenBalance,
} from './lib/onchain-setup.js';

const ROLES = ['buyer-a', 'buyer-b', 'buyer-c', 'seller', 'marketplace'];
const BUYERS = ['buyer-a', 'buyer-b', 'buyer-c'];

function clientFor(role, byRole, env) {
  return daemonClient(byRole[role], masterPasswordFor(env, role));
}

/** buyer 정책을 전부 삭제하고 원하는 세트를 재등록. WHITELIST id를 돌려준다(오케스트레이터가 라운드별 PUT). */
async function reseedPolicies(role, client, { mint, assetId }) {
  const existing = await client.listPolicies();
  for (const p of existing) {
    if (p.id) await client.deletePolicy(p.id);
  }

  const ids = {};
  ids.contractWhitelist = await client.createPolicy('CONTRACT_WHITELIST', {
    contracts: [{ address: PROGRAM_ID, name: 'a2a-auction' }],
  });
  // 베이스라인: commit(CONTRACT_CALL to=programId)만 통과. deposit용 auction_pda는 라운드마다 오케스트레이터가 추가.
  ids.whitelist = await client.createPolicy('WHITELIST', {
    allowed_addresses: [PROGRAM_ID],
  });
  ids.allowedTokens = await client.createPolicy('ALLOWED_TOKENS', {
    tokens: [{ address: mint, symbol: 'USDC', assetId }],
  });
  if (TOKEN_LIMITS[role]) {
    ids.spendingLimit = await client.createPolicy('SPENDING_LIMIT', {
      token_limits: { [assetId]: TOKEN_LIMITS[role] },
    });
  }
  return ids;
}

/** B owner를 verified 상태로 보장(멱등). 이미 verified면 스킵. */
async function ensureOwnerVerified(client) {
  const wallet = await client.getWallet();
  if (wallet.ownerVerified === true) {
    return { ownerAddress: wallet.ownerAddress, ownerState: 'LOCKED', skipped: true };
  }
  const ownerKp = Keypair.generate(); // 인메모리, 파일·로그 미출력
  const ownerAddr = ownerKp.publicKey.toBase58();
  await client.registerOwner(ownerAddr);
  // verify 메시지는 재현 불필요(즉시 소비). Date.now로 유일성만 확보.
  const msg = `verify-owner:${client.walletId}:${Date.now()}`;
  const sigB64 = signEd25519(ownerKp.secretKey, msg).toString('base64');
  const res = await client.verifyOwner(ownerAddr, msg, sigB64);
  return { ownerAddress: ownerAddr, ownerState: res.ownerState, ownerVerified: res.ownerVerified };
}

async function main() {
  const byRole = loadStateByRole();
  const env = loadEnv();
  const deployer = loadDeployer();
  const conn = connection();
  const prev = loadConfig();

  console.log('=== a2a-auction 시드 (멱등) ===');

  // 1) 데몬 health
  for (const role of ROLES) {
    const ok = await clientFor(role, byRole, env).health();
    if (!ok) throw new Error(`[${role}] 데몬 health 실패 (${byRole[role].daemonUrl})`);
  }
  const slot = await conn.getSlot().catch(() => null);
  if (slot == null) throw new Error(`localnet RPC 응답 없음`);
  console.log(`데몬 5개 health OK, localnet slot=${slot}`);

  // 2) 온체인 셋업
  for (const role of ROLES) {
    const sol = await ensureSol(conn, byRole[role].address);
    console.log(`  SOL ${role}: ${sol}`);
  }
  const mint = await ensureMint(conn, deployer, prev?.mint);
  const mintStr = mint.toBase58();
  const assetId = `${CAIP2}/token:${mintStr}`;
  console.log(`  USDC mint = ${mintStr} ${prev?.mint === mintStr ? '(재사용)' : '(신규)'}`);

  const sellerAta = (await ensureAta(conn, deployer, mint, byRole['seller'].address)).toBase58();
  console.log(`  seller ATA = ${sellerAta}`);

  for (const role of BUYERS) {
    const { balanceBase } = await ensureTokenBalance(
      conn,
      deployer,
      mint,
      byRole[role].address,
      FUND_TARGET[role],
    );
    const need = AMOUNTS[role];
    console.log(`  ${role} USDC = ${Number(balanceBase) / 1e6} (bid ${Number(need) / 1e6})`);
  }

  // 3) 정책 재등록 (결정론적)
  const policies = {};
  for (const role of BUYERS) {
    policies[role] = await reseedPolicies(role, clientFor(role, byRole, env), { mint: mintStr, assetId });
    console.log(`  ${role} 정책 재등록: ${Object.keys(policies[role]).join(', ')}`);
  }

  // 4) B owner verify
  const bOwner = await ensureOwnerVerified(clientFor('buyer-b', byRole, env));
  console.log(`  buyer-b owner: ${bOwner.ownerState}${bOwner.skipped ? ' (이미 verified)' : ' (신규 verify)'}`);
  if (bOwner.ownerState !== 'LOCKED') {
    throw new Error(`buyer-b owner가 LOCKED가 아님(APPROVAL이 DELAY로 강등됨): ${JSON.stringify(bOwner)}`);
  }

  // 5) config 기록 (nextAuctionId는 보존; 스파이크가 auction 1을 이미 씀 → 신규 시작은 2)
  const cfg = {
    mint: mintStr,
    assetId,
    sellerTokenAccount: sellerAta,
    marketplace: byRole['marketplace'].address,
    seller: byRole['seller'].address,
    addresses: Object.fromEntries(ROLES.map((r) => [r, byRole[r].address])),
    policies,
    bOwnerAddress: bOwner.ownerAddress,
    nextAuctionId: prev?.nextAuctionId ?? 2,
  };
  saveConfig(cfg);
  console.log(`\n시드 완료 → app/demo-config.json (nextAuctionId=${cfg.nextAuctionId})`);
}

main().catch((e) => {
  console.error('\nSEED FATAL:', e.message);
  process.exit(1);
});

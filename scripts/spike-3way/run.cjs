/**
 * Policy-Bound A2A Auction — 3분기 온체인 실측 오케스트레이터 (localnet).
 *
 * 한 프로세스에서 수행:
 *  1) 온체인 셋업: SOL airdrop, USDC mint(6dec), buyer/seller ATA, USDC 지급
 *  2) 주소 유도: auction PDA, vault ATA, bid PDA(A/B/C), commit_hash
 *  3) 정책 등록(각 buyer, X-Master-Password) + B owner 등록/verify(Ed25519)
 *  4) create_auction(marketplace CONTRACT_CALL)
 *  5) 3분기 측정: commit x3 / deposit x3(단독 TOKEN_TRANSFER) / reveal A / settle
 *
 * 시크릿(마스터PW·세션토큰·owner키)은 화면/결과파일에 절대 출력하지 않는다.
 * 결과 요약은 spike-3way-result.json 으로 저장(주소·txHash·status·tier만).
 *
 * 실행: NODE_PATH=<spl-token nm dir> node run.cjs   (Bash dangerouslyDisableSandbox:true 필수)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  Connection, Keypair, PublicKey, LAMPORTS_PER_SOL,
} = require('@solana/web3.js');
const {
  createMint, getOrCreateAssociatedTokenAccount, mintTo,
  getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
} = require('@solana/spl-token');

// ---------------------------------------------------------------------------
// 설정
// ---------------------------------------------------------------------------
const ROOT = path.resolve(__dirname, '../..');            // a2a-auction/
const RPC = process.env.RPC_URL || 'http://192.168.0.113:8899';
const PROGRAM_ID = new PublicKey('9nUhQbyNxmeZWpfxTmfP3U3fQ9GYtVnyP5WW1CVCYctV');
const SYS_PROGRAM = new PublicKey('11111111111111111111111111111111');
const CAIP2 = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'; // solana-devnet
const NETWORK = 'solana-devnet';
const DECIMALS = 6;
const AUCTION_ID = BigInt(process.env.AUCTION_ID || '1');

// 입찰/예치 금액 (base units, 6dec)
const AMOUNTS = { 'buyer-a': 2800000n, 'buyer-b': 6500000n, 'buyer-c': 2200000n };
// USDC 지급 (base units): A>=3, B>=7, C>=3
const FUND = { 'buyer-a': 3000000n, 'buyer-b': 7000000n, 'buyer-c': 3000000n };
// token_limits (human-readable)
const TOKEN_LIMITS = {
  'buyer-a': { instant_max: '3', notify_max: '3', delay_max: '3' },
  'buyer-b': { instant_max: '5', notify_max: '5', delay_max: '5' },
};

const DISC = {
  create_auction: [234, 6, 201, 246, 47, 219, 176, 107],
  commit_bid: [149, 237, 198, 113, 53, 66, 70, 76],
  reveal_bid: [48, 73, 28, 255, 202, 126, 236, 196],
  settle: [175, 42, 185, 87, 144, 131, 102, 212],
};

// ---------------------------------------------------------------------------
// 유틸
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const u64le = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest();
const b64disc = (name, ...tail) => Buffer.concat([Buffer.from(DISC[name]), ...tail]).toString('base64');
function saltFor(role) { return sha256(Buffer.from(`a2a-salt|${role}|${AUCTION_ID}`)); }
function acc(pubkey, isSigner, isWritable) { return { pubkey: pubkey.toBase58 ? pubkey.toBase58() : String(pubkey), isSigner, isWritable }; }

function loadJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function loadEnv(p) {
  const out = {};
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

// Ed25519 detached sign (Node crypto, no external nacl)
function signEd25519(secretKey64, message) {
  const seed = Buffer.from(secretKey64.slice(0, 32));
  const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
  const key = crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  return crypto.sign(null, Buffer.from(message, 'utf8'), key); // 64 bytes
}

async function http(method, url, headers, body) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  return { status: res.status, json };
}

// ---------------------------------------------------------------------------
// 메인
// ---------------------------------------------------------------------------
(async () => {
  const result = { auctionId: AUCTION_ID.toString(), network: NETWORK, rpc: RPC, addresses: {}, policies: {}, steps: {}, quadrant: {} };

  // 상태/시크릿 로드
  const state = loadJson(path.join(ROOT, 'demo-state.json'));
  const env = loadEnv(path.join(ROOT, 'infra/.env'));
  const byRole = Object.fromEntries(state.map((s) => [s.role, s]));
  const pwVar = (role) => env[role.toUpperCase().replace(/-/g, '_') + '_MASTER_PASSWORD'];

  const deployer = Keypair.fromSecretKey(Uint8Array.from(loadJson(path.join(ROOT, 'onchain/deployer.json'))));
  const conn = new Connection(RPC, 'confirmed');

  const mktPk = new PublicKey(byRole['marketplace'].address);
  const sellerPk = new PublicKey(byRole['seller'].address);

  console.log(`\n=== 3-WAY SPIKE (auction_id=${AUCTION_ID}, program=${PROGRAM_ID.toBase58()}) ===`);
  console.log(`deployer=${deployer.publicKey.toBase58()}  rpc=${RPC}`);

  // ---- Phase 1: 온체인 셋업 ----
  console.log('\n[1] 온체인 셋업 (airdrop / mint / ATA / fund)');
  // 1a. SOL airdrop
  for (const role of ['buyer-a', 'buyer-b', 'buyer-c', 'seller', 'marketplace']) {
    const pk = new PublicKey(byRole[role].address);
    const bal = await conn.getBalance(pk);
    if (bal < 1 * LAMPORTS_PER_SOL) {
      const sig = await conn.requestAirdrop(pk, 2 * LAMPORTS_PER_SOL);
      await conn.confirmTransaction(sig, 'confirmed');
    }
    console.log(`   airdrop ${role}: ${(await conn.getBalance(pk)) / LAMPORTS_PER_SOL} SOL`);
  }

  // 1b. USDC mint (deployer = mint authority + payer)
  const mint = await createMint(conn, deployer, deployer.publicKey, null, DECIMALS);
  console.log(`   USDC mint = ${mint.toBase58()} (decimals=${DECIMALS})`);
  const ASSET_ID = `${CAIP2}/token:${mint.toBase58()}`;
  result.addresses.usdcMint = mint.toBase58();
  result.addresses.assetId = ASSET_ID;

  // 1c. buyer ATA + USDC 지급
  const buyerAta = {};
  for (const role of ['buyer-a', 'buyer-b', 'buyer-c']) {
    const owner = new PublicKey(byRole[role].address);
    const ata = await getOrCreateAssociatedTokenAccount(conn, deployer, mint, owner);
    buyerAta[role] = ata.address;
    await mintTo(conn, deployer, mint, ata.address, deployer, FUND[role]);
    const b = await conn.getTokenAccountBalance(ata.address);
    console.log(`   ${role} ATA=${ata.address.toBase58()} balance=${b.value.uiAmount} USDC`);
  }

  // 1d. seller ATA (정산 수령처, 0 USDC)
  const sellerAtaAcc = await getOrCreateAssociatedTokenAccount(conn, deployer, mint, sellerPk);
  const sellerAta = sellerAtaAcc.address;
  console.log(`   seller ATA=${sellerAta.toBase58()} balance=0 USDC`);
  result.addresses.sellerTokenAccount = sellerAta.toBase58();

  // ---- Phase 2: 주소 유도 ----
  console.log('\n[2] 주소 유도 (auction PDA / vault / bid PDA)');
  const [auctionPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('auction'), mktPk.toBuffer(), u64le(AUCTION_ID)], PROGRAM_ID);
  const vault = getAssociatedTokenAddressSync(mint, auctionPda, true); // allowOwnerOffCurve
  const bidPda = {};
  for (const role of ['buyer-a', 'buyer-b', 'buyer-c']) {
    const bidder = new PublicKey(byRole[role].address);
    [bidPda[role]] = PublicKey.findProgramAddressSync(
      [Buffer.from('bid'), auctionPda.toBuffer(), bidder.toBuffer()], PROGRAM_ID);
  }
  console.log(`   auction PDA = ${auctionPda.toBase58()}`);
  console.log(`   vault ATA   = ${vault.toBase58()}`);
  Object.assign(result.addresses, {
    auctionPda: auctionPda.toBase58(), vault: vault.toBase58(),
    marketplace: mktPk.toBase58(), seller: sellerPk.toBase58(),
    bidA: bidPda['buyer-a'].toBase58(), bidB: bidPda['buyer-b'].toBase58(), bidC: bidPda['buyer-c'].toBase58(),
  });

  // ---- Phase 3: 정책 등록 + B owner ----
  console.log('\n[3] 정책 등록 (X-Master-Password) + B owner verify');
  const WHITELIST = {
    'buyer-a': [PROGRAM_ID.toBase58(), auctionPda.toBase58()],
    'buyer-b': [PROGRAM_ID.toBase58(), auctionPda.toBase58()],
    'buyer-c': [PROGRAM_ID.toBase58()], // auction_pda 미포함 → deposit 거부
  };
  async function ensurePolicies(role) {
    const s = byRole[role];
    const hdr = { 'X-Master-Password': pwVar(role) };
    // 기존 정책 조회(멱등)
    const existing = await http('GET', `${s.daemonUrl}/v1/policies?walletId=${s.walletId}`, hdr);
    const have = new Set((existing.json.data || existing.json.policies || existing.json || [])
      .map((p) => p.type).filter(Boolean));
    const specs = [];
    specs.push(['CONTRACT_WHITELIST', { contracts: [{ address: PROGRAM_ID.toBase58(), name: 'a2a-auction' }] }]);
    specs.push(['WHITELIST', { allowed_addresses: WHITELIST[role] }]);
    specs.push(['ALLOWED_TOKENS', { tokens: [{ address: mint.toBase58(), symbol: 'USDC', assetId: ASSET_ID }] }]);
    if (TOKEN_LIMITS[role]) {
      specs.push(['SPENDING_LIMIT', { token_limits: { [ASSET_ID]: TOKEN_LIMITS[role] } }]);
    }
    const registered = [];
    for (const [type, rules] of specs) {
      if (have.has(type)) { registered.push({ type, skipped: true }); continue; }
      const r = await http('POST', `${s.daemonUrl}/v1/policies`, hdr,
        { walletId: s.walletId, type, rules, priority: 0, enabled: true });
      if (r.status >= 300) throw new Error(`[${role}] policy ${type} 실패 ${r.status}: ${JSON.stringify(r.json)}`);
      registered.push({ type, id: r.json.id });
    }
    result.policies[role] = specs.map(([type, rules]) => ({ type, rules }));
    console.log(`   ${role}: ${specs.map((x) => x[0]).join(', ')}  (신규 ${registered.filter((x) => !x.skipped).length})`);
  }
  await ensurePolicies('buyer-a');
  await ensurePolicies('buyer-b');
  await ensurePolicies('buyer-c');

  // B owner 등록 + verify (Ed25519). owner 키페어는 인메모리 생성(파일/로그 미출력).
  {
    const s = byRole['buyer-b'];
    const hdr = { 'X-Master-Password': pwVar('buyer-b') };
    const ownerKp = Keypair.generate();
    const ownerAddr = ownerKp.publicKey.toBase58();
    const put = await http('PUT', `${s.daemonUrl}/v1/wallets/${s.walletId}/owner`, hdr,
      { owner_address: ownerAddr, approval_method: 'rest' });
    if (put.status >= 300) throw new Error(`[buyer-b] owner 등록 실패 ${put.status}: ${JSON.stringify(put.json)}`);
    const msg = `verify-owner:${s.walletId}:${Date.now()}`;
    const sig = signEd25519(ownerKp.secretKey, msg).toString('base64');
    const ver = await http('POST', `${s.daemonUrl}/v1/wallets/${s.walletId}/owner/verify`, {
      'X-Owner-Signature': sig, 'X-Owner-Message': msg, 'X-Owner-Address': ownerAddr,
    });
    if (ver.status >= 300) throw new Error(`[buyer-b] owner verify 실패 ${ver.status}: ${JSON.stringify(ver.json)}`);
    console.log(`   buyer-b owner = ${ownerAddr}  state=${ver.json.ownerState} verified=${ver.json.ownerVerified}`);
    result.steps.buyerB_owner = { ownerAddress: ownerAddr, ownerState: ver.json.ownerState, ownerVerified: ver.json.ownerVerified };
  }

  // ---- 트랜잭션 헬퍼 ----
  async function sendTx(role, body) {
    const s = byRole[role];
    const r = await http('POST', `${s.daemonUrl}/v1/transactions/send`,
      { Authorization: `Bearer ${s.sessionToken}` }, { walletId: s.walletId, network: NETWORK, ...body });
    if (r.status >= 300) throw new Error(`[${role}] send 실패 ${r.status}: ${JSON.stringify(r.json)}`);
    return r.json.id;
  }
  async function pollTx(role, id, stopStatuses, timeoutMs = 40000) {
    const s = byRole[role];
    const deadline = Date.now() + timeoutMs;
    let last = {};
    while (Date.now() < deadline) {
      const r = await http('GET', `${s.daemonUrl}/v1/transactions/${id}`, { Authorization: `Bearer ${s.sessionToken}` });
      last = r.json;
      if (last && stopStatuses.includes(last.status)) return last;
      await sleep(1500);
    }
    return last;
  }
  async function confirmSig(txHash) {
    if (!txHash) return 'no-sig';
    try {
      const st = await conn.getSignatureStatuses([txHash]);
      const v = st.value[0];
      return v ? (v.confirmationStatus || (v.confirmations === null ? 'finalized' : 'confirmed')) : 'unknown';
    } catch { return 'err'; }
  }
  const contractCall = (to, dataB64, accounts) => ({ type: 'CONTRACT_CALL', to, programId: PROGRAM_ID.toBase58(), instructionData: dataB64, accounts });

  // ---- Phase 4: create_auction ----
  console.log('\n[4] create_auction (marketplace)');
  {
    const data = b64disc('create_auction', u64le(AUCTION_ID));
    const accounts = [
      acc(mktPk, true, true),               // authority (signer, w)
      acc(sellerPk, false, false),          // seller (ro)
      acc(mint, false, false),              // usdc_mint (ro)
      acc(auctionPda, false, true),         // auction (w, pda)
      acc(vault, false, true),              // vault (w)
      acc(TOKEN_PROGRAM_ID, false, false),
      acc(ASSOCIATED_TOKEN_PROGRAM_ID, false, false),
      acc(SYS_PROGRAM, false, false),
    ];
    const id = await sendTx('marketplace', contractCall(PROGRAM_ID.toBase58(), data, accounts));
    const fin = await pollTx('marketplace', id, ['CONFIRMED', 'SUBMITTED', 'FAILED', 'CANCELLED']);
    const cs = await confirmSig(fin.txHash);
    console.log(`   create_auction status=${fin.status} txHash=${fin.txHash || '-'} onchain=${cs}`);
    if (!['CONFIRMED', 'SUBMITTED'].includes(fin.status)) throw new Error(`create_auction 실패: ${JSON.stringify(fin)}`);
    // 온체인 확인
    const aInfo = await conn.getAccountInfo(auctionPda);
    const vBal = await conn.getTokenAccountBalance(vault).catch(() => ({ value: { uiAmount: null } }));
    console.log(`   onchain auction acct=${aInfo ? 'OK(' + aInfo.data.length + 'B)' : 'MISSING'} vault=${vBal.value.uiAmount} USDC`);
    result.steps.createAuction = { status: fin.status, txHash: fin.txHash, onchain: cs, auctionExists: !!aInfo };
  }

  // ---- Phase 5: commit x3 ----
  console.log('\n[5] commit_bid x3 (정책 무관, 3자 모두 성공)');
  const commitInfo = {};
  for (const role of ['buyer-a', 'buyer-b', 'buyer-c']) {
    const bidder = new PublicKey(byRole[role].address);
    const commitHash = sha256(Buffer.concat([u64le(AMOUNTS[role]), saltFor(role)]));
    const data = b64disc('commit_bid', commitHash);
    const accounts = [
      acc(bidder, true, true),         // bidder (signer, w)
      acc(auctionPda, false, false),   // auction (ro)
      acc(bidPda[role], false, true),  // bid (w, pda)
      acc(SYS_PROGRAM, false, false),
    ];
    const id = await sendTx(role, contractCall(PROGRAM_ID.toBase58(), data, accounts));
    const fin = await pollTx(role, id, ['CONFIRMED', 'SUBMITTED', 'FAILED', 'CANCELLED']);
    const cs = await confirmSig(fin.txHash);
    console.log(`   ${role} commit status=${fin.status} tier=${fin.tier} txHash=${fin.txHash || '-'} onchain=${cs}`);
    commitInfo[role] = { status: fin.status, tier: fin.tier, txHash: fin.txHash, onchain: cs };
    if (!['CONFIRMED', 'SUBMITTED'].includes(fin.status)) throw new Error(`${role} commit 실패: ${JSON.stringify(fin)}`);
  }
  result.steps.commit = commitInfo;

  // ---- Phase 6: deposit x3 (단독 TOKEN_TRANSFER) ----
  console.log('\n[6] deposit x3 (단독 TOKEN_TRANSFER, to=auction_pda → vault)');
  const depositInfo = {};
  const token = { address: mint.toBase58(), decimals: DECIMALS, symbol: 'USDC', assetId: ASSET_ID };
  for (const role of ['buyer-a', 'buyer-b', 'buyer-c']) {
    const body = { type: 'TOKEN_TRANSFER', to: auctionPda.toBase58(), amount: AMOUNTS[role].toString(), token };
    const id = await sendTx(role, body);
    // A: 실행(CONFIRMED) / B: QUEUED / C: CANCELLED. 모든 정지상태를 포괄.
    const stop = ['CONFIRMED', 'SUBMITTED', 'QUEUED', 'DELAYED', 'CANCELLED', 'FAILED'];
    const fin = await pollTx(role, id, stop, role === 'buyer-a' ? 45000 : 20000);
    const cs = await confirmSig(fin.txHash);
    depositInfo[role] = { txId: id, status: fin.status, tier: fin.tier, txHash: fin.txHash || null, onchain: cs, error: fin.error || fin.errorMessage || null };
    console.log(`   ${role} deposit status=${fin.status} tier=${fin.tier} txHash=${fin.txHash || '-'} onchain=${cs} err=${depositInfo[role].error || '-'}`);
  }
  // B가 /pending 에 뜨는지 확인
  {
    const s = byRole['buyer-b'];
    const pend = await http('GET', `${s.daemonUrl}/v1/transactions/pending`, { Authorization: `Bearer ${s.sessionToken}` });
    const list = pend.json.items || pend.json.data || pend.json.transactions || pend.json || [];
    const found = Array.isArray(list) && list.some((t) => t.id === depositInfo['buyer-b'].txId);
    depositInfo['buyer-b'].inPending = found;
    console.log(`   buyer-b in /transactions/pending: ${found} (count=${Array.isArray(list) ? list.length : '?'})`);
  }
  const vAfterDeposit = await conn.getTokenAccountBalance(vault);
  console.log(`   vault balance after deposits = ${vAfterDeposit.value.uiAmount} USDC (A 예치만 반영 기대)`);
  result.steps.deposit = depositInfo;
  result.steps.vaultAfterDeposit = vAfterDeposit.value.uiAmount;

  // ---- Phase 7: reveal A ----
  console.log('\n[7] reveal_bid (A만)');
  {
    const role = 'buyer-a';
    const bidder = new PublicKey(byRole[role].address);
    const data = b64disc('reveal_bid', u64le(AMOUNTS[role]), saltFor(role));
    const accounts = [
      acc(bidder, true, false),       // bidder (signer, ro; feePayer로 승격됨)
      acc(auctionPda, false, true),   // auction (w)
      acc(bidPda[role], false, true), // bid (w)
      acc(vault, false, false),       // vault (ro)
    ];
    const id = await sendTx(role, contractCall(PROGRAM_ID.toBase58(), data, accounts));
    const fin = await pollTx(role, id, ['CONFIRMED', 'SUBMITTED', 'FAILED', 'CANCELLED']);
    const cs = await confirmSig(fin.txHash);
    console.log(`   reveal A status=${fin.status} tier=${fin.tier} txHash=${fin.txHash || '-'} onchain=${cs}`);
    result.steps.revealA = { status: fin.status, tier: fin.tier, txHash: fin.txHash, onchain: cs };
    if (!['CONFIRMED', 'SUBMITTED'].includes(fin.status)) throw new Error(`reveal A 실패: ${JSON.stringify(fin)}`);
  }

  // ---- Phase 8: settle ----
  console.log('\n[8] settle (marketplace → winner A, vault→seller)');
  {
    const data = b64disc('settle');
    const accounts = [
      acc(mktPk, true, false),        // authority (signer, ro; feePayer 승격)
      acc(auctionPda, false, true),   // auction (w)
      acc(vault, false, true),        // vault (w)
      acc(sellerAta, false, true),    // seller_token_account (w)
      acc(TOKEN_PROGRAM_ID, false, false),
    ];
    const id = await sendTx('marketplace', contractCall(PROGRAM_ID.toBase58(), data, accounts));
    const fin = await pollTx('marketplace', id, ['CONFIRMED', 'SUBMITTED', 'FAILED', 'CANCELLED']);
    const cs = await confirmSig(fin.txHash);
    console.log(`   settle status=${fin.status} txHash=${fin.txHash || '-'} onchain=${cs}`);
    result.steps.settle = { status: fin.status, txHash: fin.txHash, onchain: cs };
    if (!['CONFIRMED', 'SUBMITTED'].includes(fin.status)) throw new Error(`settle 실패: ${JSON.stringify(fin)}`);
  }

  // 최종 온체인 상태
  const sellerBal = await conn.getTokenAccountBalance(sellerAta);
  const vaultFinal = await conn.getTokenAccountBalance(vault);
  console.log(`\n[결과] seller USDC = ${sellerBal.value.uiAmount}  vault USDC = ${vaultFinal.value.uiAmount}`);
  result.steps.final = { sellerUsdc: sellerBal.value.uiAmount, vaultUsdc: vaultFinal.value.uiAmount };

  // 온체인 auction 계정 파싱(winner/highest/status)  — 수동 borsh 디코드
  {
    const info = await conn.getAccountInfo(auctionPda);
    if (info) {
      const d = info.data; let o = 8; // discriminator
      const authority = new PublicKey(d.subarray(o, o + 32)); o += 32;
      const seller = new PublicKey(d.subarray(o, o + 32)); o += 32;
      const usdcMint = new PublicKey(d.subarray(o, o + 32)); o += 32;
      const vaultAcc = new PublicKey(d.subarray(o, o + 32)); o += 32;
      const aId = d.readBigUInt64LE(o); o += 8;
      const status = d.readUInt8(o); o += 1; // 0 Committing,1 Revealing,2 Settled
      const highest = d.readBigUInt64LE(o); o += 8;
      const hasWinner = d.readUInt8(o); o += 1;
      let winner = null; if (hasWinner === 1) { winner = new PublicKey(d.subarray(o, o + 32)); o += 32; }
      const statusName = ['Committing', 'Revealing', 'Settled'][status];
      console.log(`   auction: status=${statusName} highest=${highest} winner=${winner ? winner.toBase58() : 'none'}`);
      result.steps.auctionState = {
        status: statusName, highest: highest.toString(),
        winner: winner ? winner.toBase58() : null,
        winnerIsA: winner ? winner.toBase58() === byRole['buyer-a'].address : false,
      };
    }
  }

  // 3분기 요약
  result.quadrant = {
    'buyer-a': { commit: commitInfo['buyer-a'].status, deposit: depositInfo['buyer-a'].status, tier: depositInfo['buyer-a'].tier, txHash: depositInfo['buyer-a'].txHash, verdict: '실행' },
    'buyer-b': { commit: commitInfo['buyer-b'].status, deposit: depositInfo['buyer-b'].status, tier: depositInfo['buyer-b'].tier, inPending: depositInfo['buyer-b'].inPending, verdict: 'QUEUED(승인대기)' },
    'buyer-c': { commit: commitInfo['buyer-c'].status, deposit: depositInfo['buyer-c'].status, error: depositInfo['buyer-c'].error, verdict: 'POLICY_DENIED' },
  };

  const outPath = path.join(ROOT, 'spike-3way-result.json');
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(`\n결과 요약 저장: ${outPath}`);
  console.log('\n=== 3분기 판정 ===');
  console.table({
    A: { commit: commitInfo['buyer-a'].status, deposit: depositInfo['buyer-a'].status, tier: depositInfo['buyer-a'].tier },
    B: { commit: commitInfo['buyer-b'].status, deposit: depositInfo['buyer-b'].status, tier: depositInfo['buyer-b'].tier },
    C: { commit: commitInfo['buyer-c'].status, deposit: depositInfo['buyer-c'].status, tier: depositInfo['buyer-c'].tier },
  });
})().catch((e) => { console.error('\nFATAL:', e.message); process.exit(1); });

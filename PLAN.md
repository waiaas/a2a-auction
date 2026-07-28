# Policy-Bound A2A Auction — 개발 체크리스트

> 팀 트래커 (Jira 미사용). 정본 스펙: `ai-agent-hackathon/2026-07-27-a2a-auction-spec-team-review.md` (v3).
> 결정 이력: `docs/DECISIONS.md`. **제출 마감: 8/3(일) 23:59 KST.**
> 빌드 순서 원칙: 코어 루프(3분기 + 정산 + receipt)가 돌기 전에는 주변 장치에 손대지 않는다.

## 게이트 (D-6 스파이크, 7/28)
- [x] **게이트 ①** 오라클 devnet USDC USD 환산 → 실패 확인 → **USDC 유지 + 예치 2-tx 분리 + token_limits**로 전환 (DECISIONS·스펙 기록)
- [x] **게이트 ②** Anchor 최소 프로그램(create/commit/reveal/settle) build + 로컬 e2e(litesvm) + **localnet 배포** (에스크로 폴백 불필요)
- [x] **3분기 온체인 실측** (A 실행 / B QUEUED / C POLICY_DENIED) — localnet 완주·독립 검증 ✅ (seller +2.8 USDC, vault 0, auction Settled·winner=A)

## 스파이크 마무리 (즉시)
- [x] a2a-auction 작업 브랜치 커밋(`feat/d6-risk-spike`) → **draft PR** 생성
- [x] 세션 노트 작성 (`docs/sessions/2026-07-28-hackathon-d6-spike.md`)
- [ ] 팀 채널에 스파이크 결과 공유 (게이트 2개 판정 + 3분기 tx) ← 사용자 몫

## D-5 (7/29 화) 컨트랙트·백엔드 ✅ (`feat/d5-contract-orchestrator`, curl 완주)
- [x] 경매 프로그램 데모 경로 완성 (`app/demo-path.js` — create→commit→예치→reveal→settle 통합 실행)
- [x] 경매 오케스트레이터 상태 머신 (`app/orchestrator.js` :4000 — start/state/receipt/reset)
- [x] seller 서비스 (`app/seller.js` :4100 — 온체인 Settled·winner 확인 후 200, 미정산 403)
- [x] Gemini 연동 (`app/lib/gemini.js` — 견적·rationale·result, 라이브 REST + `fixtures/` 폴백 캐시)
- [x] 시드 스크립트·픽스처 (`app/seed.js` 멱등, **B owner verify 포함** — 이미 verified면 스킵)
- [x] 완료 판정: **curl로 전 플로우 완주** (`app/verify-e2e.sh` PASS — A ALLOW / B APPROVAL / C DENY, settle·unlock)
- 메모: 라운드별 auction_id 증가 + A·B WHITELIST에 auction_pda `PUT` 갱신(정책 엔진이 tx마다 DB 재조회 → 즉시 반영). deployer 키는 시드 전용(오케스트레이터/seller는 데몬 API+읽기 전용).

## D-4 (7/30 수) 웹 UI
- [ ] 경매 스테이지 화면 (commit·예치 배지, DIY vs BUY 칩, RAW vs EXECUTABLE 배너)
- [ ] B 승인대기 연출 (owner 알림 장면)
- 완료 판정: **브라우저에서 3분기 시연**

## D-3 (7/31 목) Receipt·통합
- [ ] Receipt/Audit 뷰 (증거 체인 + 데몬별 감사 로그 원본)
- [ ] result unlock (낙찰자 A에게만)
- [ ] e2e 통합. 여유 시 컨트랙트에 환불→마감→유찰 순 추가
- 완료 판정: **스펙 6장 완성 기준 충족**

## D-2 (8/1 금) 배포·리허설
- [ ] **devnet 공개 배포** (explorer 링크용): deployer `BtsvpHpPP3CFvTZR8T6C1ru6TCmGp4xS56gSAzuYrM2q`에 ~4 SOL + Circle devnet USDC mint 확정
- [ ] Cloud Run (웹+오케스트레이터+seller) + Secret Manager
- [ ] 리허설 2회
- 완료 판정: **라이브 URL에서 데모 완주**

## D-1 (8/2 토) 제출물
- [ ] 데모 영상 3분 (촬영본)
- [ ] README (commit·예치·settle tx 증거 링크 고정)
- [ ] 원페이저 + 피치덱 (스펙 8장 스크립트 기반)

## D-0 (8/3 일) 제출
- [ ] 버퍼 + 최종 제출 (23:59 KST 전)

---

## 스파이크에서 나온 후속 이슈 (놓치면 데모가 깨짐)
- [ ] 시드에 B owner **verify까지** 포함 (등록만 하면 APPROVAL이 DELAY로 강등됨)
- [ ] 예치는 반드시 **단독 TOKEN_TRANSFER (2-tx)**. batch는 token_limits를 무시함
- [ ] 예치 TOKEN_TRANSFER의 `to`는 vault ATA가 아니라 **auction_pda(=vault owner)** (WAIaaS가 owner→ATA 유도). **WHITELIST 대상도 auction_pda**
- [ ] **commit_bid(CONTRACT_CALL)도 WHITELIST 평가를 거침** → C는 WHITELIST에 programId만 넣고 auction_pda 제외해야 "commit 통과 + deposit 거부"가 성립 (WHITELIST 아예 없으면 deposit이 그냥 실행됨)
- [ ] TOKEN_TRANSFER 요청에 `token.assetId`(CAIP-19)를 실어야 token_limits 수량 티어가 걸림
- [ ] token_limits 키(CAIP-19 assetId)가 TOKEN_TRANSFER의 assetId와 **정확히 일치**해야 수량 티어가 걸림
- [ ] A는 INSTANT가 아니라 **NOTIFY로 통과**(devnet/local USDC는 notListed→NOTIFY 격상). 자동 실행은 동일 → UI는 "ALLOW"로 표기, 서사 영향 없음
- [ ] devnet↔localnet 전환은 데몬 env `WAIAAS_RPC_SOLANA_DEVNET` 하나만 바꾸면 됨 (기본값=실제 devnet)
- [ ] (제품 로드맵, 스펙 부록 A) dApp 어댑터 / 승인 타임아웃 vs 경매 마감 정합

## 로컬 개발 메모
- **localnet 밸리데이터**: `solana-test-validator --bind-address <호스트 LAN IP>` (0.0.0.0은 gossip 패닉으로 불가). 컨테이너는 그 LAN IP로 접근.
- 데몬 API(127.0.0.1:3100~3104)·localnet 호출은 **샌드박스 해제** 필요(루프백 차단).
- devnet 공용 faucet airdrop 차단됨 → localnet 무제한 airdrop 또는 보유 devnet SOL 분배.
- 시크릿은 `.gitignore`로 제외: `infra/.env`, `demo-state.json`, `onchain/deployer.json`.

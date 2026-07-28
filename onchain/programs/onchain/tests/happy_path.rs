//! 데모 happy path 통합 테스트 (litesvm 인프로세스 SVM, devnet 자금 불필요).
//!
//! 시나리오: buyer A만 vault에 예치 성공 -> A만 reveal 성공 -> settle에서 A의
//! highest_amount가 seller로 지급된다. create_auction / commit_bid / (별도 tx 예치)
//! / reveal_bid / settle 전 구간을 온체인 프로그램(.so)으로 실제 실행한다.

use {
    anchor_lang::{
        prelude::Pubkey,
        solana_program::{
            instruction::Instruction, program_pack::Pack, system_instruction, system_program,
        },
        AccountDeserialize, InstructionData, ToAccountMetas,
    },
    anchor_spl::{
        associated_token::{
            get_associated_token_address, spl_associated_token_account, ID as ATA_PROGRAM_ID,
        },
        token::{spl_token, ID as TOKEN_PROGRAM_ID},
    },
    litesvm::LiteSVM,
    sha2::{Digest, Sha256},
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
};

const MINT_LEN: usize = 82; // spl_token::state::Mint::LEN
const USDC_DECIMALS: u8 = 6;
const AUCTION_ID: u64 = 1;
const BID_AMOUNT: u64 = 100_000_000; // 100 USDC (6 decimals)

fn send(svm: &mut LiteSVM, ixs: &[Instruction], signers: &[&Keypair]) {
    let payer = signers[0].pubkey();
    let blockhash = svm.latest_blockhash();
    let msg = Message::new_with_blockhash(ixs, Some(&payer), &blockhash);
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), signers).unwrap();
    let res = svm.send_transaction(tx);
    assert!(res.is_ok(), "tx failed: {:#?}", res.err());
}

fn token_balance(svm: &LiteSVM, ata: &Pubkey) -> u64 {
    let acc = svm.get_account(ata).expect("token account missing");
    spl_token::state::Account::unpack(&acc.data).unwrap().amount
}

#[test]
fn happy_path_single_winner() {
    let program_id = onchain::id();
    let mut svm = LiteSVM::new();
    let bytes = include_bytes!(concat!(env!("CARGO_TARGET_TMPDIR"), "/../deploy/onchain.so"));
    svm.add_program(program_id, bytes).unwrap();

    // 참여자
    let authority = Keypair::new(); // marketplace (경매 authority + mint authority)
    let seller = Keypair::new();
    let buyer = Keypair::new(); // buyer A
    let mint = Keypair::new();

    svm.airdrop(&authority.pubkey(), 100_000_000_000).unwrap();
    svm.airdrop(&buyer.pubkey(), 100_000_000_000).unwrap();

    // 1) USDC mint 생성 (create_account + initialize_mint2). signers = [authority, mint]
    let rent = svm.minimum_balance_for_rent_exemption(MINT_LEN);
    let create_mint_acc = system_instruction::create_account(
        &authority.pubkey(),
        &mint.pubkey(),
        rent,
        MINT_LEN as u64,
        &TOKEN_PROGRAM_ID,
    );
    let init_mint = spl_token::instruction::initialize_mint2(
        &TOKEN_PROGRAM_ID,
        &mint.pubkey(),
        &authority.pubkey(),
        None,
        USDC_DECIMALS,
    )
    .unwrap();
    send(&mut svm, &[create_mint_acc, init_mint], &[&authority, &mint]);

    // PDA / ATA 주소 유도
    let (auction_pda, _) = Pubkey::find_program_address(
        &[b"auction", authority.pubkey().as_ref(), &AUCTION_ID.to_le_bytes()],
        &program_id,
    );
    let vault = get_associated_token_address(&auction_pda, &mint.pubkey());
    let buyer_ata = get_associated_token_address(&buyer.pubkey(), &mint.pubkey());
    let seller_ata = get_associated_token_address(&seller.pubkey(), &mint.pubkey());
    let (bid_pda, _) = Pubkey::find_program_address(
        &[b"bid", auction_pda.as_ref(), buyer.pubkey().as_ref()],
        &program_id,
    );

    // 2) create_auction (auction PDA + vault ATA 생성)
    let ix = Instruction::new_with_bytes(
        program_id,
        &onchain::instruction::CreateAuction { auction_id: AUCTION_ID }.data(),
        onchain::accounts::CreateAuction {
            authority: authority.pubkey(),
            seller: seller.pubkey(),
            usdc_mint: mint.pubkey(),
            auction: auction_pda,
            vault,
            token_program: TOKEN_PROGRAM_ID,
            associated_token_program: ATA_PROGRAM_ID,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    );
    send(&mut svm, &[ix], &[&authority]);

    // 3) buyer USDC ATA 생성 + 민팅
    let create_buyer_ata = spl_associated_token_account::instruction::create_associated_token_account(
        &buyer.pubkey(),
        &buyer.pubkey(),
        &mint.pubkey(),
        &TOKEN_PROGRAM_ID,
    );
    send(&mut svm, &[create_buyer_ata], &[&buyer]);
    let mint_to = spl_token::instruction::mint_to(
        &TOKEN_PROGRAM_ID,
        &mint.pubkey(),
        &buyer_ata,
        &authority.pubkey(),
        &[],
        1_000_000_000, // 1000 USDC
    )
    .unwrap();
    send(&mut svm, &[mint_to], &[&authority]);

    // 4) commit_bid: commit_hash = sha256(amount_le || salt)
    let salt = [7u8; 32];
    let mut hasher = Sha256::new();
    hasher.update(BID_AMOUNT.to_le_bytes());
    hasher.update(salt);
    let commit_hash: [u8; 32] = hasher.finalize().as_slice().try_into().unwrap();
    let ix = Instruction::new_with_bytes(
        program_id,
        &onchain::instruction::CommitBid { commit_hash }.data(),
        onchain::accounts::CommitBid {
            bidder: buyer.pubkey(),
            auction: auction_pda,
            bid: bid_pda,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    );
    send(&mut svm, &[ix], &[&buyer]);

    // 5) 예치(별도 tx): buyer가 vault로 USDC 전송 (프로그램 CPI 아님)
    let deposit = spl_token::instruction::transfer(
        &TOKEN_PROGRAM_ID,
        &buyer_ata,
        &vault,
        &buyer.pubkey(),
        &[],
        BID_AMOUNT,
    )
    .unwrap();
    send(&mut svm, &[deposit], &[&buyer]);
    assert_eq!(token_balance(&svm, &vault), BID_AMOUNT, "vault deposit");

    // 6) reveal_bid
    let ix = Instruction::new_with_bytes(
        program_id,
        &onchain::instruction::RevealBid { amount: BID_AMOUNT, salt }.data(),
        onchain::accounts::RevealBid {
            bidder: buyer.pubkey(),
            auction: auction_pda,
            bid: bid_pda,
            vault,
        }
        .to_account_metas(None),
    );
    send(&mut svm, &[ix], &[&buyer]);

    // reveal 후 상태 검증
    let auction_data = svm.get_account(&auction_pda).unwrap().data;
    let auction = onchain::state::Auction::try_deserialize(&mut auction_data.as_slice()).unwrap();
    assert_eq!(auction.highest_amount, BID_AMOUNT);
    assert_eq!(auction.winner, Some(buyer.pubkey()));
    assert_eq!(auction.total_revealed, BID_AMOUNT);
    assert!(matches!(auction.status, onchain::state::AuctionStatus::Revealing));
    let bid_data = svm.get_account(&bid_pda).unwrap().data;
    let bid = onchain::state::Bid::try_deserialize(&mut bid_data.as_slice()).unwrap();
    assert!(bid.revealed);
    assert_eq!(bid.revealed_amount, BID_AMOUNT);

    // 7) seller USDC ATA 생성 (settle 수령처)
    let create_seller_ata =
        spl_associated_token_account::instruction::create_associated_token_account(
            &authority.pubkey(),
            &seller.pubkey(),
            &mint.pubkey(),
            &TOKEN_PROGRAM_ID,
        );
    send(&mut svm, &[create_seller_ata], &[&authority]);

    // 8) settle: vault -> seller (CPI transfer, auction PDA signer seeds)
    let ix = Instruction::new_with_bytes(
        program_id,
        &onchain::instruction::Settle {}.data(),
        onchain::accounts::Settle {
            authority: authority.pubkey(),
            auction: auction_pda,
            vault,
            seller_token_account: seller_ata,
            token_program: TOKEN_PROGRAM_ID,
        }
        .to_account_metas(None),
    );
    send(&mut svm, &[ix], &[&authority]);

    // settle 후 검증: seller가 낙찰금 수령, vault 0, status Settled
    assert_eq!(token_balance(&svm, &seller_ata), BID_AMOUNT, "seller payout");
    assert_eq!(token_balance(&svm, &vault), 0, "vault drained");
    let auction_data = svm.get_account(&auction_pda).unwrap().data;
    let auction = onchain::state::Auction::try_deserialize(&mut auction_data.as_slice()).unwrap();
    assert!(matches!(auction.status, onchain::state::AuctionStatus::Settled));
}

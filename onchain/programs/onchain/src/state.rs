use anchor_lang::prelude::*;

/// 경매 상태 머신. 데모 경로: Committing -> Revealing -> Settled.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, InitSpace)]
pub enum AuctionStatus {
    Committing,
    Revealing,
    Settled,
}

/// 경매 계정 (PDA: ["auction", authority, auction_id_le]).
#[account]
#[derive(InitSpace)]
pub struct Auction {
    /// 마켓플레이스(경매 운영 주체). create/settle signer.
    pub authority: Pubkey,
    /// 낙찰금 수령자.
    pub seller: Pubkey,
    /// 결제 SPL 토큰 mint (USDC).
    pub usdc_mint: Pubkey,
    /// vault 토큰 계정 주소 (auction PDA가 authority인 ATA).
    pub vault: Pubkey,
    /// PDA 재구성용 auction_id.
    pub auction_id: u64,
    pub status: AuctionStatus,
    /// 현재까지 공개된 최고 입찰액.
    pub highest_amount: u64,
    /// 현재 최고 입찰자.
    pub winner: Option<Pubkey>,
    /// 지금까지 reveal된 입찰액의 누적 합(예치 도착 검증 기준).
    pub total_revealed: u64,
    /// auction PDA bump (settle CPI signer seeds용).
    pub bump: u8,
}

/// 입찰 계정 (PDA: ["bid", auction, bidder]).
#[account]
#[derive(InitSpace)]
pub struct Bid {
    pub bidder: Pubkey,
    /// sha256(amount_le(8) || salt(32)).
    pub commit_hash: [u8; 32],
    pub revealed_amount: u64,
    pub revealed: bool,
}

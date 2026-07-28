pub mod constants;
pub mod error;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("9nUhQbyNxmeZWpfxTmfP3U3fQ9GYtVnyP5WW1CVCYctV");

#[program]
pub mod onchain {
    use super::*;

    /// 경매 생성 + vault(ATA) 생성. signer = authority(marketplace).
    pub fn create_auction(ctx: Context<CreateAuction>, auction_id: u64) -> Result<()> {
        instructions::create_auction::handle(ctx, auction_id)
    }

    /// 커밋(입찰 해시 등록). signer = bidder. Committing 단계에서만.
    pub fn commit_bid(ctx: Context<CommitBid>, commit_hash: [u8; 32]) -> Result<()> {
        instructions::commit_bid::handle(ctx, commit_hash)
    }

    /// 공개(금액+salt로 커밋 검증, vault 예치 도착 확인). signer = bidder.
    pub fn reveal_bid(ctx: Context<RevealBid>, amount: u64, salt: [u8; 32]) -> Result<()> {
        instructions::reveal_bid::handle(ctx, amount, salt)
    }

    /// 정산(낙찰금 seller에게 전송, Settled로 전환). signer = authority.
    pub fn settle(ctx: Context<Settle>) -> Result<()> {
        instructions::settle::handle(ctx)
    }
}

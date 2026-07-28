use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{Mint, Token, TokenAccount},
};

use crate::{constants::AUCTION_SEED, state::*};

#[derive(Accounts)]
#[instruction(auction_id: u64)]
pub struct CreateAuction<'info> {
    /// 마켓플레이스: 계정 생성 비용 지불 + 경매 authority.
    #[account(mut)]
    pub authority: Signer<'info>,

    /// 낙찰금 수령자. 여기서는 pubkey만 기록한다.
    /// CHECK: seller는 주소만 저장하며 서명·검증이 필요 없다.
    pub seller: UncheckedAccount<'info>,

    pub usdc_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = authority,
        space = 8 + Auction::INIT_SPACE,
        seeds = [AUCTION_SEED, authority.key().as_ref(), &auction_id.to_le_bytes()],
        bump
    )]
    pub auction: Account<'info, Auction>,

    /// vault: auction PDA가 authority인 USDC ATA.
    #[account(
        init,
        payer = authority,
        associated_token::mint = usdc_mint,
        associated_token::authority = auction,
    )]
    pub vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handle(ctx: Context<CreateAuction>, auction_id: u64) -> Result<()> {
    let auction = &mut ctx.accounts.auction;
    auction.authority = ctx.accounts.authority.key();
    auction.seller = ctx.accounts.seller.key();
    auction.usdc_mint = ctx.accounts.usdc_mint.key();
    auction.vault = ctx.accounts.vault.key();
    auction.auction_id = auction_id;
    auction.status = AuctionStatus::Committing;
    auction.highest_amount = 0;
    auction.winner = None;
    auction.total_revealed = 0;
    auction.bump = ctx.bumps.auction;

    msg!("Auction {} created", auction_id);
    Ok(())
}

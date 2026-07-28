use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::{constants::AUCTION_SEED, error::AuctionError, state::*};

#[derive(Accounts)]
pub struct Settle<'info> {
    /// 마켓플레이스(경매 authority). settle 서명자.
    pub authority: Signer<'info>,

    #[account(mut, has_one = authority, has_one = vault)]
    pub auction: Account<'info, Auction>,

    #[account(mut)]
    pub vault: Account<'info, TokenAccount>,

    /// seller 소유의 USDC 토큰 계정(낙찰금 수령). mint/owner를 검증한다.
    #[account(
        mut,
        constraint = seller_token_account.mint == auction.usdc_mint,
        constraint = seller_token_account.owner == auction.seller,
    )]
    pub seller_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub fn handle(ctx: Context<Settle>) -> Result<()> {
    require!(
        ctx.accounts.auction.status != AuctionStatus::Settled,
        AuctionError::AlreadySettled
    );
    ctx.accounts.auction.status = AuctionStatus::Settled;

    let has_winner = ctx.accounts.auction.winner.is_some();
    let amount = ctx.accounts.auction.highest_amount;

    if has_winner && amount > 0 {
        // vault(=auction PDA authority)에서 seller로 CPI transfer. signer seeds로 서명.
        let authority_key = ctx.accounts.auction.authority;
        let auction_id_le = ctx.accounts.auction.auction_id.to_le_bytes();
        let bump_arr = [ctx.accounts.auction.bump];
        let seeds: &[&[u8]] = &[AUCTION_SEED, authority_key.as_ref(), &auction_id_le, &bump_arr];
        let signer_seeds: &[&[&[u8]]] = &[seeds];

        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.seller_token_account.to_account_info(),
                authority: ctx.accounts.auction.to_account_info(),
            },
            signer_seeds,
        );
        token::transfer(cpi_ctx, amount)?;
        msg!("Settled: {} transferred to seller", amount);
    } else {
        msg!("Settled with no winner");
    }

    Ok(())
}

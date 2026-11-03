use crate::constants::*;
use crate::errors::RegistryError;
use crate::state::*;
use anchor_lang::prelude::*;

// ——————————————————————————————— submit ———————————————————————————————

#[derive(Accounts)]
pub struct SubmitListing<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [BUILDER_SEED, authority.key().as_ref()],
        bump = builder.bump,
        has_one = authority,
    )]
    pub builder: Account<'info, Builder>,

    #[account(
        init,
        payer = authority,
        space = 8 + AgentListing::INIT_SPACE,
        seeds = [AGENT_SEED, builder.key().as_ref(), &builder.agent_count.to_le_bytes()],
        bump
    )]
    pub listing: Account<'info, AgentListing>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn submit_listing(
    ctx: Context<SubmitListing>,
    agent_authority: Pubkey,
    market: u8,
    metadata_hash: [u8; 32],
) -> Result<()> {
    let builder = &ctx.accounts.builder;
    require!(builder.tier >= 1, RegistryError::BondBelowTierOne);
    require!(!builder.is_unbonding(), RegistryError::BuilderUnbonding);

    let index = builder.agent_count;
    let listing = &mut ctx.accounts.listing;
    listing.builder = builder.key();
    listing.agent_authority = agent_authority;
    listing.status = ListingStatus::Vetting;
    listing.market = market;
    listing.metadata_hash = metadata_hash;
    listing.aum_current = 0;
    listing.vault_count = 0;
    listing.index = index;
    listing.created_at = Clock::get()?.unix_timestamp;
    listing.approved_at = 0;
    listing.bump = ctx.bumps.listing;
    // Fees stay zeroed until approval writes the real config. The execution-fee fields
    // are not zeroed here because they are not on this account: `ListingEconomics` does
    // not exist until approval, which is the same guarantee by a stronger route.
    listing.apply_fee_config(&FeeConfig {
        listing_fee_bps: 0,
        performance_fee_bps: 0,
        builder_split_bps: 0,
        execution_fee_bps: 0,
        execution_builder_split_bps: 0,
        position_cap_bps: 0,
        max_drawdown_bps: 0,
        auto_pause: true,
    });

    let builder = &mut ctx.accounts.builder;
    builder.agent_count = builder
        .agent_count
        .checked_add(1)
        .ok_or(RegistryError::MathOverflow)?;

    msg!("Listing {} submitted for vetting", index);
    Ok(())
}

// ——————————————————————————————— approve ———————————————————————————————

#[derive(Accounts)]
pub struct ApproveListing<'info> {
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = authority @ RegistryError::Unauthorized,
    )]
    pub config: Account<'info, Config>,

    /// The `Vetting` requirement is an account constraint rather than only a check in the
    /// handler, and the ordering is load-bearing. Anchor validates accounts in declaration
    /// order, so this fires before `economics` is initialised. Without it, a second
    /// approval fails on `init` with a raw "account already in use" from the system
    /// program — the listing is still protected, but the caller is told the wrong thing,
    /// and a multisig signer reading that error would have no idea the listing was simply
    /// already live. The handler keeps its `require!` too: cheap, and it keeps the failure
    /// legible from the handler alone.
    #[account(
        mut,
        seeds = [AGENT_SEED, listing.builder.as_ref(), &listing.index.to_le_bytes()],
        bump = listing.bump,
        constraint = listing.status == ListingStatus::Vetting @ RegistryError::ListingNotVetting,
    )]
    pub listing: Account<'info, AgentListing>,

    /// Created here rather than at submission, so a listing still in vetting has no
    /// economics account and therefore nowhere a fee could be written. `init` rather than
    /// `init_if_needed`: approval happens once, guarded by the constraint above.
    #[account(
        init,
        payer = authority,
        space = 8 + ListingEconomics::INIT_SPACE,
        seeds = [ECONOMICS_SEED, listing.key().as_ref()],
        bump
    )]
    pub economics: Account<'info, ListingEconomics>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

/// Passing `None` applies the locked launch defaults — 0 bps listing fee,
/// 1000 bps performance fee, 8000 bps builder split, 2 bps execution fee at a 5000 bps
/// split, 1200/1500 risk caps. Explicit configs are still bounded by the guardrails in
/// `FeeConfig::validate`.
pub fn approve_listing(ctx: Context<ApproveListing>, fee_config: Option<FeeConfig>) -> Result<()> {
    require!(
        ctx.accounts.listing.status == ListingStatus::Vetting,
        RegistryError::ListingNotVetting
    );

    let cfg = fee_config.unwrap_or_default();
    cfg.validate()?;

    let listing_key = ctx.accounts.listing.key();

    let listing = &mut ctx.accounts.listing;
    listing.apply_fee_config(&cfg);
    listing.status = ListingStatus::Live;
    listing.approved_at = Clock::get()?.unix_timestamp;

    let economics = &mut ctx.accounts.economics;
    economics.listing = listing_key;
    economics.execution_fee_bps = cfg.execution_fee_bps;
    economics.execution_builder_split_bps = cfg.execution_builder_split_bps;
    economics.bump = ctx.bumps.economics;

    msg!(
        "Listing {} live — perf {} bps (builder {} bps), execution {} bps (builder {} bps)",
        listing.index,
        cfg.performance_fee_bps,
        cfg.builder_split_bps,
        cfg.execution_fee_bps,
        cfg.execution_builder_split_bps
    );
    Ok(())
}

// ——————————————————————————————— lifecycle ———————————————————————————————

/// Either the builder or the multisig may pause or delist. Both are checked in
/// the handler because Anchor cannot express "one of two signers" declaratively.
#[derive(Accounts)]
pub struct ManageListing<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,

    #[account(
        seeds = [BUILDER_SEED, builder.authority.as_ref()],
        bump = builder.bump,
    )]
    pub builder: Account<'info, Builder>,

    #[account(
        mut,
        seeds = [AGENT_SEED, listing.builder.as_ref(), &listing.index.to_le_bytes()],
        bump = listing.bump,
        constraint = listing.builder == builder.key(),
    )]
    pub listing: Account<'info, AgentListing>,

    pub signer: Signer<'info>,
}

impl<'info> ManageListing<'info> {
    fn assert_builder_or_authority(&self) -> Result<()> {
        let key = self.signer.key();
        require!(
            key == self.builder.authority || key == self.config.authority,
            RegistryError::Unauthorized
        );
        Ok(())
    }
}

pub fn pause_listing(ctx: Context<ManageListing>) -> Result<()> {
    ctx.accounts.assert_builder_or_authority()?;
    let listing = &mut ctx.accounts.listing;
    require!(
        listing.status == ListingStatus::Live,
        RegistryError::ListingNotLive
    );

    listing.status = ListingStatus::Paused;
    msg!("Listing {} paused", listing.index);
    Ok(())
}

pub fn resume_listing(ctx: Context<ManageListing>) -> Result<()> {
    ctx.accounts.assert_builder_or_authority()?;
    let listing = &mut ctx.accounts.listing;
    require!(
        listing.status == ListingStatus::Paused,
        RegistryError::ListingNotPaused
    );

    listing.status = ListingStatus::Live;
    msg!("Listing {} resumed", listing.index);
    Ok(())
}

/// Terminal. Refused while capital is still deployed — traders must exit first,
/// otherwise vaults would be stranded against a dead listing.
pub fn delist(ctx: Context<ManageListing>) -> Result<()> {
    ctx.accounts.assert_builder_or_authority()?;
    let listing = &mut ctx.accounts.listing;
    require!(
        listing.status != ListingStatus::Delisted,
        RegistryError::ListingDelisted
    );
    require!(listing.aum_current == 0, RegistryError::ListingHasAum);

    listing.status = ListingStatus::Delisted;
    msg!("Listing {} delisted", listing.index);
    Ok(())
}

// ——————————————————————————— key rotation ———————————————————————————

#[derive(Accounts)]
pub struct RotateAgentAuthority<'info> {
    #[account(
        seeds = [BUILDER_SEED, authority.key().as_ref()],
        bump = builder.bump,
        has_one = authority,
    )]
    pub builder: Account<'info, Builder>,

    #[account(
        mut,
        seeds = [AGENT_SEED, listing.builder.as_ref(), &listing.index.to_le_bytes()],
        bump = listing.bump,
        constraint = listing.builder == builder.key() @ RegistryError::Unauthorized,
    )]
    pub listing: Account<'info, AgentListing>,

    pub authority: Signer<'info>,
}

/// Mandatory, not optional: delegated trade authority means a stolen bot key can
/// trade live vaults until it is replaced.
pub fn rotate_agent_authority(
    ctx: Context<RotateAgentAuthority>,
    new_agent_authority: Pubkey,
) -> Result<()> {
    let listing = &mut ctx.accounts.listing;
    require!(
        listing.status != ListingStatus::Delisted,
        RegistryError::ListingDelisted
    );

    let previous = listing.agent_authority;
    listing.agent_authority = new_agent_authority;

    msg!("Agent authority rotated {} → {}", previous, new_agent_authority);
    Ok(())
}

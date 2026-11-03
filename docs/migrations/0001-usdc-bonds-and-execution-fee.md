# Migration 0001 — USDC bonds, the execution fee, and the guardrails that were missing

**Date:** 2 November 2026
**Program:** `agent_registry` at `22rFHvivAX4hDwx3NdwfQ1hsyorwDFxc9JLy5WcZV7x6` — **unchanged**
**Affects:** devnet. Nothing is deployed to mainnet.

Three changes land together, deliberately, so clients break once rather than three times.

---

## 1. `Config.agent_mint` → `Config.bond_mint`

Bonds move from $AGENT to USDC. A bond denominated in a token the platform issues is a
bond whose value the platform controls, and the deterrent is only as real as the
collateral behind it. $AGENT also does not exist yet, so the previous design could not
have shipped as written.

**Same offset, same size, so no realloc and no account rewrite.** Existing `Config`
accounts on devnet deserialise correctly against the new struct; the bytes have not moved.
What changes is the name, which means:

- The IDL field is now `bondMint`. Any client reading `config.agentMint` gets
  `undefined`, silently, rather than an error. **Regenerate types.**
- The instruction account on `initialize_config` and `register_builder` is now
  `bond_mint`. Callers passing it positionally are unaffected; callers passing it by name
  must rename.

The *value* in any existing devnet `Config` still points at whatever mint it was
initialised with. There is no on-chain migration to run — but a devnet config initialised
against a mock $AGENT mint is now semantically wrong, and `initialize_config` cannot be
re-run because the PDA already exists. **To move devnet to USDC bonds, the config PDA has
to be closed and recreated, or a fresh devnet deployment used.** That is an operator
decision, not a code one.

## 2. Tier bonds are now USDC amounts

| Tier | Was ($AGENT) | Now (USDC) | AUM ceiling (unchanged) |
|---|---|---|---|
| 1 | 25,000 | **2,500** | 25,000 |
| 2 | 100,000 | **10,000** | 150,000 |
| 3 | 400,000 | **40,000** | 1,000,000 |

Roughly 10% of the ceiling each tier unlocks. Below that the bond is theatre: a builder
who can defraud $25,000 for a $2,500 stake will.

`tier_bonds` is governance-settable through the existing `queue_update_tiers` →
`execute_change` timelock, so **this needs no code migration** — the multisig queues the
new values and executes after the delay. The constants in `scripts/` and the tests carry
the new figures; the on-chain values are whatever governance last set.

## 3. The execution fee, and a guardrail hole that was already open

### New account: `ListingEconomics`

PDA at `["economics", listing]`, created at approval time, holding
`execution_fee_bps` and `execution_builder_split_bps`.

A separate account rather than two more fields on `AgentListing`, for the reason already
recorded on `Governance` in `state.rs`: `AgentListing` is live on devnet, and adding
fields grows `INIT_SPACE`, which means a realloc across every existing listing for the
sake of four bytes.

**`approve_listing` now takes two more accounts** — `economics` (init, paid by the
authority) and `system_program` — and `authority` is now `mut` because it funds the rent.
Anchor's TypeScript client resolves the PDA from the IDL seeds, so `accountsPartial`
callers need no change beyond regenerating types.

Listings approved **before** this change have no `ListingEconomics` account. They are not
broken — the registry never reads it — but they charge no execution fee, and anything
reading the fee must treat a missing account as zero rather than failing. There is no
backfill instruction: on devnet, re-approve or redeploy.

### `FeeConfig` gains two fields

`execution_fee_bps` and `execution_builder_split_bps`. `FeeConfig` is an instruction
argument, not an account, so this is a wire-format change to `approve_listing` only.
Passing `None` still applies the locked defaults, now including 2 bps at a 5000 bps split.

### The guardrail hole

`FeeConfig::validate()` bounded `position_cap_bps` and `max_drawdown_bps` only against
`MAX_BPS` (10,000). The Solidity implementation bounds them at 2,500 and 5,000. **This
program would have approved a listing with a 100% position cap and a 100% drawdown limit
that Solidity rejects outright**, and nothing caught it for two months.

`MAX_POSITION_CAP_BPS` and `MAX_DRAWDOWN_BPS_CEILING` now exist and bind, and zero is
rejected for both. `agent-circle-evm/script/check-params.py` fails CI on any future
divergence.

**Operational consequence:** if any live devnet listing was approved with a cap above
2,500 bps or a drawdown limit above 5,000 bps, it is still live with those values —
validation runs at approval, not continuously. Audit existing listings before relying on
the new bound.

## 4. Error codes have shifted

The four new variants are grouped with the other parameter errors rather than appended,
to keep the file parallel to `Errors.sol`. Anchor numbers variants sequentially from
6000, so **every code from 6007 onwards has moved**:

| Code | Was | Now |
|---|---|---|
| 6007 | `BpsOutOfRange` | `ExecutionFeeTooHigh` |
| 6008 | `BuilderUnbonding` | `ExecutionBuilderSplitTooLow` |
| 6009 | `UnbondNotRequested` | `PositionCapOutOfRange` |
| 6010 | `UnbondAlreadyRequested` | `DrawdownLimitOutOfRange` |
| 6011 | `UnbondPeriodNotElapsed` | `BpsOutOfRange` |
| … | | each later variant +4 |

This is the one change here that fails *silently* in the worst way: a client matching on
the number `6007` to mean "basis points out of range" now reads an execution-fee error and
will not notice. Clients must match on the **name** from the regenerated IDL, never on the
numeric code. Nothing in this repository matches on numbers — `expectError` in the test
suite compares names — but anything outside it might.

---

## Checklist for whoever applies this

- [ ] Regenerate the IDL and TypeScript types (`yarn build`); redistribute to any client.
- [ ] Grep clients for `agentMint`, and for hard-coded error numbers ≥ 6007.
- [ ] Decide whether devnet gets a fresh config PDA (USDC bond mint) or is left as-is.
- [ ] Queue `update_tiers` with the USDC figures if devnet is being kept.
- [ ] Audit existing devnet listings for caps above the newly enforced bounds.
- [ ] Program ID and upgrade authority are untouched. See
      `docs/runbooks/upgrade-authority.md` before any deploy.

## Verification status

`cargo check` and `cargo-build-sbf --tools-version v1.52` both pass, and the IDL builds
with `ListingEconomics` and the new errors present.

**The test suite has not been run against these changes.** `anchor test` needs
`surfpool`, which this machine does not have, and the installed `solana-test-validator`
is too old to load a v1.52 binary — it rejects it with *"Detected sbpf_version required by
the executable which are not enabled"*. That is the same toolchain gap `scripts/build.sh`
documents at length. The suite was updated alongside the code (eight new guardrail cases,
plus assertions on the new PDA) but is unverified until it runs somewhere with a matching
runtime. Pinning that runtime in CI is the open item.

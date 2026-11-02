# Runbook — moving the upgrade authority to the Squads multisig

**Status:** written, not executed. Nobody has run this.
**Program:** `agent_registry` at `22rFHvivAX4hDwx3NdwfQ1hsyorwDFxc9JLy5WcZV7x6`
**Audience:** whoever holds the deploy key today.

This is written to be followed by a human at a keyboard, in order, with the verification
step after each action actually performed rather than assumed. Nothing in this repository
automates it and nothing should: the failure modes are irreversible and the mitigations
are all "do not get it wrong".

---

## 0. Why this matters more than the program does

Everything the registry's governance design achieves — the timelock, the veto-only
guardian, the bounds a compromised multisig cannot exceed — rests on one assumption: that
the program's *code* cannot be swapped out underneath it.

A program upgrade replaces the code. It does not go through the timelock, because the
timelock is implemented *in* the code being replaced. Whoever holds the upgrade authority
can deploy a version with no timelock, no guardian and no bounds, and then do whatever
they like in the next block.

So the upgrade authority is strictly more powerful than the config authority, and a
single key holding it makes every defence in `instructions/governance.rs` decorative. The
Drift precedent the whitelist is designed against was not a code bug; it was months of
social engineering against the people who held admin control. One key on one laptop is
the shape of that attack.

**Until this runbook has been executed, the honest description of the program's security
is "controlled by a single key", whatever the governance code says.** Do not let the docs
or the app claim otherwise before then.

## 1. Preconditions

- [ ] The Squads multisig exists, on the target cluster, with its signers **tested** —
      each signer has approved at least one real transaction from their own device.
- [ ] The multisig has **at least 3 signers and a threshold of at least 2**. A 1-of-n is
      a single key with extra steps.
- [ ] No signer's key lives on the same machine as another signer's.
- [ ] The guardian key is **not** a multisig signer. The guardian's whole value is being
      a separate party who can obstruct; a guardian who is also a signer is one person
      wearing two hats.
- [ ] The multisig has SOL for rent and fees.
- [ ] You know where the program keypair is and can read it.
- [ ] You have the program's current upgrade authority confirmed from chain, not from
      memory.

```bash
solana program show 22rFHvivAX4hDwx3NdwfQ1hsyorwDFxc9JLy5WcZV7x6
```

Record `Authority` and `Last Deployed In Slot` before you change anything.

## 2. Do it on devnet first, end to end

Including the parts that feel unnecessary. The point is not to prove the command works —
it does — but to prove *your signers can actually sign an upgrade afterwards*. That is
the step people discover is broken only when they need it.

```bash
solana program set-upgrade-authority \
  22rFHvivAX4hDwx3NdwfQ1hsyorwDFxc9JLy5WcZV7x6 \
  --new-upgrade-authority <SQUADS_VAULT_PDA> \
  --url devnet
```

Then, and this is the actual test:

- [ ] Deploy a trivial change (bump a `msg!` string) **through the multisig**, with the
      real signers approving from their own devices.
- [ ] Confirm the deployed program changed.
- [ ] Confirm the multisig can still read the buffer and close it to reclaim rent.

If any of that is awkward on devnet, it will be awkward on mainnet in an incident.

<!-- Keep the devnet program's authority on the multisig afterwards. A devnet program on
     a single key is a convenient target for practising the attack on. -->

## 3. The irreversible parts

Read these twice.

**The new authority must be the Squads *vault* PDA, not the multisig account and not a
signer's wallet.** Squads exposes several addresses and they are easy to confuse. Getting
this wrong does not fail loudly: it hands the authority to something that cannot sign,
and the program becomes permanently unupgradeable. Copy the vault address from the Squads
UI and verify it character by character, both leading and trailing.

**`--final` makes the program immutable forever.** There is no recovery. Do not pass it.
It is not a security measure here — an immutable program cannot be patched when an audit
finds something, and this code has not been audited.

**Set the authority, do not revoke it.** `--new-upgrade-authority` with no value, or
`solana program set-upgrade-authority --final`, both end the program's upgradeability.

## 4. Mainnet

Only after section 2 has been done with real signers.

```bash
# 1. Confirm the current authority is what you expect.
solana program show <PROGRAM_ID> --url mainnet-beta

# 2. Transfer.
solana program set-upgrade-authority \
  <PROGRAM_ID> \
  --new-upgrade-authority <SQUADS_VAULT_PDA> \
  --url mainnet-beta

# 3. Confirm it took.
solana program show <PROGRAM_ID> --url mainnet-beta
```

- [ ] `Authority` now reads the Squads vault PDA.
- [ ] Record the transaction signature here, in this file, with the date.
- [ ] Publish the program ID, the multisig address and the signer count in the public
      docs. A multisig nobody can verify is a claim, not a control.

## 5. Securing the program keypair afterwards

The program keypair is **not** the upgrade authority — it identifies the program, and
after a deploy it is not needed for upgrades at all. It still matters: it is the only
thing that proves which program is yours, and `anchor keys sync` will happily overwrite
`declare_id!` from whatever keypair is lying in `target/deploy/`.

- [ ] It is **not** in this repository and must never be. `target/` is gitignored, which
      is why CI generates a throwaway key and syncs to it instead.
- [ ] Move it to offline storage — a hardware token or an encrypted volume that is not on
      a machine with a network connection.
- [ ] Keep **two** copies, in two physical locations. Losing it does not lose the program,
      but it loses the ability to prove provenance and to redeploy under the same ID from
      a clean checkout.
- [ ] Delete it from `target/deploy/` on every developer machine once mainnet is deployed,
      and from CI caches.
- [ ] Note in `README.md` where it lives — the location, not the key.

## 6. What this does not fix

Stating it plainly, because a completed checklist invites the belief that the problem is
solved:

- A multisig is a smaller attack surface than a single key, not a safe one. Drift had a
  multisig. The attack was social, against the people holding it.
- Signers on the same hardware, in the same office, reachable by the same phishing
  campaign, are correlated regardless of what the threshold says.
- This program has **not been audited**. The multisig controls who may deploy a bug, not
  whether the current code has one.
- The config authority (`Config.authority`) is a separate thing and should also be the
  multisig. Check it: `queue_transfer_authority` → wait → `execute_change`, with the
  guardian able to veto during the wait. That path *is* timelocked, unlike this one.

## 7. Record of execution

| Date | Cluster | From | To | Signature | By |
|---|---|---|---|---|---|
| — | — | — | — | — | *not yet executed* |

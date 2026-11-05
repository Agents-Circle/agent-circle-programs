# Runbook — moving the upgrade authority to the Squads multisig

**Status:** run end to end on **public devnet** on 2026-11-04 with solana-cli 3.0.0 and the
Squads v4 program, using a throwaway test program and a throwaway 2-of-3 multisig (signatures in
§9). Rehearsed before that on a surfpool fork of devnet. **Not executed** for the real program
on any cluster.
**Program:** `agent_registry` at `22rFHvivAX4hDwx3NdwfQ1hsyorwDFxc9JLy5WcZV7x6`
**Audience:** whoever holds the deploy key today.

This is written to be followed by a human at a keyboard, in order, with the verification
step after each action actually performed rather than assumed. Nothing in this repository
automates it and nothing should: the failure modes are irreversible and the mitigations
are all "do not get it wrong". The one helper here, [`squads-sat.mjs`](squads-sat.mjs),
builds Squads proposals and submits only the votes and executions you sign with your own
keypair. It decides nothing.

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

## 1. Why the one-line CLI transfer does not work

The obvious command fails on solana-cli 3.0.0:

```console
$ solana program set-upgrade-authority <PROGRAM_ID> \
    --new-upgrade-authority <SQUADS_VAULT_PDA> -k deployer.json --url devnet
Error: Dynamic program error: missing signature for supplied pubkey: <SQUADS_VAULT_PDA>
```

By default the CLI uses the loader's `SetAuthorityChecked`, in which the **new** authority
must sign too. The Squads vault is a PDA with no private key. It can only sign inside a
Squads execution, never at the CLI. Nothing is sent, so the failure is harmless.

The CLI does offer `--skip-new-upgrade-authority-signer-check`. **Do not use it.** It
switches to the unchecked `SetAuthority`, which accepts any address: a typo, the
multisig account instead of the vault, or a signer's wallet. That is exactly the
irreversible mistake described in §5.

What Squads calls a **Safe Authority Transfer (SAT)** is the same `SetAuthorityChecked`,
run as a Squads vault transaction. The vault signs through the Squads program when the
transaction executes, and the current authority co-signs that execution. If the new
authority is not this multisig's vault, nobody can produce its signature and the transfer
cannot execute. A wrong address fails loudly instead of locking the program forever.

## 2. Preconditions

- [ ] The Squads multisig exists, on the target cluster, with its signers **tested** —
      each signer has approved at least one real transaction from their own device.
- [ ] The multisig has **at least 3 signers and a threshold of at least 2**. A 1-of-n is
      a single key with extra steps.
- [ ] The multisig has **no config authority** (`status` below prints
      `config authority: none`). A config authority can change members and the threshold on
      its own, which makes it a single key again.
- [ ] No signer's key lives on the same machine as another signer's.
- [ ] The guardian key is **not** a multisig signer. The guardian's whole value is being
      a separate party who can obstruct; a guardian who is also a signer is one person
      wearing two hats.
- [ ] The current upgrade authority is a keypair file on the deploy machine. The helper
      signs with keypair files only. If the deploy key is on a hardware wallet, stop here
      and adapt the execute step first.
- [ ] Whoever pays for proposals and the deploy key both have SOL for rent and fees. The
      whole devnet rehearsal used about 0.035 SOL with a 1 KB test program. A buffer for
      the current 555 KB `agent_registry.so` needs 2.82 SOL of rent until the upgrade
      refunds it (`solana rent 554917`).
- [ ] You have the program's current upgrade authority confirmed from chain, not from
      memory.

### Tools

Every command here was run with **solana-cli 3.0.0** (Agave, `src:b6c96e84`). Check
yours with `solana --version`. Pass `--url` and `-k`/`--keypair` explicitly on every
command, so nothing falls back to `~/.config/solana/cli/config.yml` or `id.json`.

The helper needs Node 20 or later (rehearsed on 22.22.3). Install its two dependencies in
a scratch directory, so the repo's own `package.json` stays untouched:

```bash
T=$(mktemp -d) && cp docs/runbooks/squads-sat.mjs "$T" && cd "$T"
npm init -y >/dev/null && npm i @sqds/multisig@2.1.4 @solana/web3.js@1.98.4
node squads-sat.mjs --help
```

The Squads v4 program is `SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf` on both devnet and
mainnet, and the helper uses it by default.

Signers approve **in the Squads app** (app.squads.so), each from their own device and
wallet. The helper's `approve` command is for devnet rehearsals with throwaway keypair
files. The proposals it creates are ordinary Squads vault and config transactions, so they
should appear in the app. That last point has not been checked; see §9.

Set these once per shell. `--url` takes the same values for both tools: a moniker
(`devnet`, `testnet`, `mainnet-beta`, `localhost`) or a full RPC URL.

```bash
URL=devnet                      # mainnet-beta in §6
PROGRAM_ID=<program id>
DEPLOYER=<path to the current upgrade authority's keypair file>
AUTHORITY=$(solana-keygen pubkey "$DEPLOYER")
MULTISIG=<multisig account address, from the Squads app settings>
PROPOSER=<path to a member keypair with Proposer permission>
```

## 3. Do it on devnet first, end to end

Including the parts that feel unnecessary. The point is not to prove the transfer
works — it does — but to prove *your signers can actually sign an upgrade afterwards*.
That is the step people discover is broken only when they need it.

### 3.1 Record the starting state

```bash
solana program show "$PROGRAM_ID" --url "$URL"
node squads-sat.mjs status --url "$URL" --multisig "$MULTISIG"
```

Record `Authority`, `ProgramData Address` and `Last Deployed In Slot`. `status` prints the
vault address (index 0), the threshold, the members with their permissions, the config
authority and the time lock. Check that the vault matches the one the Squads app shows,
character by character. Set `VAULT=<that address>`.

### 3.2 Add the deploy key as an Execute-only member

The current authority has to sign the execution, so Squads' SAT flow starts by adding
it to the multisig ("add your CLI tool to the Squad"). Give it **Execute permission
only**. It cannot propose or vote, so it cannot move anything the threshold has not
approved.

```bash
node squads-sat.mjs propose-add-executor --url "$URL" --multisig "$MULTISIG" \
  --member "$AUTHORITY" --keypair "$PROPOSER"
```

Note the printed index. The signers approve it in the app. On devnet with throwaway keys
you can instead run
`node squads-sat.mjs approve --url "$URL" --multisig "$MULTISIG" --index <N> --keypair <member.json>`
once per signer. Then any member with Execute permission executes it:

```bash
node squads-sat.mjs execute --url "$URL" --multisig "$MULTISIG" --index <N> --keypair "$PROPOSER"
node squads-sat.mjs status  --url "$URL" --multisig "$MULTISIG"   # the deploy key now shows as Executor
```

**Order matters.** Executing a config transaction makes every older proposal that has not
executed yet stale. Finish this step before you create the transfer proposal.

There is a shorter route, and it was rehearsed too. A member with Execute permission
executes the transfer in 3.4 with `--keypair <member.json> --co-signer "$DEPLOYER"`, which
skips 3.2 and 3.7. It needs that member's keypair file on the deploy machine, which is
why it is not the default.

### 3.3 Propose the Safe Authority Transfer

```bash
node squads-sat.mjs propose-sat --url "$URL" --multisig "$MULTISIG" \
  --program "$PROGRAM_ID" --current-authority "$AUTHORITY" --keypair "$PROPOSER"
node squads-sat.mjs status --url "$URL" --multisig "$MULTISIG" --index <N>
```

`propose-sat` refuses to run unless the authority on chain is `$AUTHORITY`. Before anyone
approves, check what `status --index` prints, or the same details in the app:

- program `BPFLoaderUpgradeab1e11111111111111111111111`, data `07000000`
  (`SetAuthorityChecked`)
- account 0: the `ProgramData Address` from 3.1
- account 1: the current authority, `$AUTHORITY`
- account 2: the vault, `$VAULT`

### 3.4 Approve, then execute as the deploy key

The signers approve to the threshold. Then the deploy key executes it. It signs once,
both as the executing member and as the current authority:

```bash
node squads-sat.mjs execute --url "$URL" --multisig "$MULTISIG" --index <N> --keypair "$DEPLOYER"
solana program show "$PROGRAM_ID" --url "$URL"
```

- [ ] `Authority` now reads `$VAULT`.
- [ ] Record the execute signature in §9.

If the multisig has a time lock, execution waits for it. Without the deploy key's
signature the execution fails at signature verification (checked in the rehearsal).

### 3.5 The actual test: upgrade through the multisig

Make a trivial change (bump a `msg!` string), build it with `scripts/build.sh`, and then:

```bash
solana program write-buffer target/deploy/agent_registry.so -k "$DEPLOYER" --url "$URL"
BUFFER=<buffer address it printed>
solana program set-buffer-authority "$BUFFER" --new-buffer-authority "$VAULT" \
  --buffer-authority "$DEPLOYER" -k "$DEPLOYER" --url "$URL"
node squads-sat.mjs propose-upgrade --url "$URL" --multisig "$MULTISIG" \
  --program "$PROGRAM_ID" --buffer "$BUFFER" --spill <address that gets the buffer's rent back> \
  --keypair "$PROPOSER"
```

`set-buffer-authority` takes a plain address and does not need the vault to sign.
`propose-upgrade` refuses to run unless the buffer's authority is already the vault. The
signers approve, a **real signer** executes, and you confirm the deployed code changed:

```bash
node squads-sat.mjs execute --url "$URL" --multisig "$MULTISIG" --index <N> --keypair <signer>
solana program show "$PROGRAM_ID" --url "$URL"          # Last Deployed In Slot moved
solana program dump "$PROGRAM_ID" dump.so --url "$URL"
head -c "$(stat -c %s target/deploy/agent_registry.so)" dump.so | sha256sum
sha256sum target/deploy/agent_registry.so              # the two hashes match
```

- [ ] Deployed **through the multisig**, with the real signers approving from their own
      devices.
- [ ] The deployed program changed.

If the new build is larger than the program-data account, the upgrade fails until the
account is extended. Extending is not covered by this rehearsal.

### 3.6 Close a buffer through the multisig

A failed or abandoned upgrade leaves a buffer the vault owns. Prove the multisig can
reclaim it:

```bash
solana program show --buffers --buffer-authority "$VAULT" --url "$URL"
node squads-sat.mjs propose-close-buffer --url "$URL" --multisig "$MULTISIG" \
  --buffer <buffer> --recipient <address for the rent> --keypair "$PROPOSER"
# approve, then execute as in 3.5
solana program show --buffers --buffer-authority "$VAULT" --url "$URL"   # gone
```

- [ ] The multisig can read the buffer and close it to reclaim rent.

### 3.7 Remove the deploy key from the multisig

```bash
node squads-sat.mjs propose-remove-member --url "$URL" --multisig "$MULTISIG" \
  --member "$AUTHORITY" --keypair "$PROPOSER"
# approve, execute, then check `status` no longer lists it
```

Do this last. It is a config transaction, so it makes any proposal still pending stale.

If any of that is awkward on devnet, it will be awkward on mainnet in an incident.

<!-- Keep the devnet program's authority on the multisig afterwards. A devnet program on
     a single key is a convenient target for practising the attack on. -->

## 4. Using the Squads app instead of the helper

The Squads app has the same flow under Programs → Add Program → "Use SAT (Safe Authority
Transfer)". It creates the transfer proposal, signers approve it in the app, and the deploy
key, added as a member, executes it. Squads documents this at
docs.squads.so → Navigating your Squad → Developers → Programs. Upgrades go through Programs →
"Add upgrade", after the same `write-buffer` and `set-buffer-authority` steps.

Whichever tool creates the proposal, the checks in 3.1, 3.3 and 3.4 still apply. This
runbook's rehearsal did **not** exercise the app.

## 5. The irreversible parts

Read these twice.

**The new authority must be the Squads *vault* PDA, not the multisig account and not a
signer's wallet.** Squads exposes several addresses and they are easy to confuse. The
SAT guards against this, because only this multisig's vault can co-sign, but only if you
do not bypass it. With `--skip-new-upgrade-authority-signer-check` a wrong address does
not fail loudly. It hands the authority to something that cannot sign, and the program
becomes permanently unupgradeable. Copy the vault address from the Squads app, compare it
with `status`, and verify it character by character, both leading and trailing.

**`--final` makes the program immutable forever.** There is no recovery. Do not pass it.
It is not a security measure here — an immutable program cannot be patched when an audit
finds something, and this code has not been audited.

**Set the authority, do not revoke it.** `solana program set-upgrade-authority --final`,
or a Squads "Change authority" to an address nobody controls, ends the program's
upgradeability.

## 6. Mainnet

Only after section 3 has been done with real signers.

Use the same steps with `URL=mainnet-beta`, in the same order:

1. 3.1: confirm the current authority and the vault.
2. 3.2: add the deploy key as an Execute-only member.
3. 3.3–3.4: propose the SAT, signers approve in the app, then the deploy key executes it.
4. 3.7: remove the deploy key from the multisig.

Then check:

- [ ] `solana program show <PROGRAM_ID> --url mainnet-beta` reads the Squads vault PDA as
      `Authority`.
- [ ] Record the transaction signature here, in this file, with the date.
- [ ] Publish the program ID, the multisig address and the signer count in the public
      docs. A multisig nobody can verify is a claim, not a control.

On a congested mainnet, pass `--priority-fee <micro-lamports per CU>` to the helper.

## 7. Securing the program keypair afterwards

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

## 8. What this does not fix

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

## 9. Record of execution

### Rehearsals (throwaway program and keys, not `agent_registry`)

**2026-11-04, surfpool 1.7.0 fork of devnet, solana-cli 3.0.0, helper with @sqds/multisig
2.1.4.** A 1.2 KB test program was deployed under a throwaway ID, with a throwaway 2-of-3
multisig. Every step in §3 passed:

- The one-line transfer failed as shown in §1.
- The deploy key was added as an Execute-only member.
- The SAT moved the authority to the vault. Executing it without the deploy key's
  signature failed signature verification.
- A second test program was moved by the shorter route from 3.2: a member executed with
  the deploy key as `--co-signer`.
- `propose-sat` refused to run when `--current-authority` did not match the chain.
- The upgrade through the multisig worked: the dumped program's sha256 matched the new
  build.
- A buffer was closed through the vault, and its 0.0071374 SOL came back.
- The deploy key was removed from the multisig.

The signatures exist only on that local fork, so they are not recorded here.

**2026-11-04, public devnet, solana-cli 3.0.0, helper with @sqds/multisig 2.1.4.** Same
1.2 KB test program (`runbook-noop`), deployed under the throwaway ID
`9tRUBvzjzyUMVTTt94V6zFUV9jXiFQkxT8hkzTnHjLdg` with a throwaway deploy key
`GYAPVdaEPjFhz6vVogDCEDFYDKN7Hw9auuoKczfG9ymW`, and a throwaway 2-of-3 multisig
`7e7jK9BfsQyMkoSHpK1xauhHSZFstimCHF5GDEn9nekU` (vault `DztyTd4DLNGWJ6HMmQsRFvXcbKnzDFupTqoQj3Z1meEo`,
no config authority, no time lock). The deploy key was funded from faucet.solana.com, because
the RPC faucets answer `410 The RPC faucet is closed on this cluster`. Every step in §3 passed,
and every signature below is finalized:

- The one-line transfer failed as shown in §1, with nothing sent.
- `propose-sat` refused a wrong `--current-authority`.
- The SAT proposal showed `07000000` with the program-data account, the deploy key and the
  vault, in that order (3.3).
- Executing the SAT as a member, without the deploy key, failed signature verification.
  Executed by the deploy key, `Authority` changed to the vault.
- The upgrade through the multisig, executed by a voting member, moved `Last Deployed In Slot`
  from 518686147 to 518686665. The dumped program's sha256 is `e5fb63fe…7088`, which is the
  v2 build's, not v1's (`7e78bc10…cd64`).
- A buffer was closed through the vault, and its 0.0071374 SOL rent reached the recipient.
- The deploy key was removed. The multisig is back to its three members, and the test program
  stays on the vault.

The whole run cost about 0.02 SOL, plus 0.15 SOL moved to the throwaway members for fees.

Found in this run and fixed: the helper took only a full RPC URL, so `URL=devnet` from §2
failed before sending anything. It now accepts the CLI's monikers.

**Not verified at all:** the Squads app's SAT and upgrade screens, Squads proposals
created by the helper appearing in the app, signing with hardware wallets, programs
larger than the program-data account, and anything on mainnet.

| Date | Cluster | Step | Signature | By |
|---|---|---|---|---|
| 2026-11-04 | devnet | multisig created (rehearsal only) | `W7QseGF3GfC2A7QkCPp35Uf363mwaJMfmAW2ixYVdomjn5cRNHnXBFKCxJhzyUGFB861iu9nSWsz1rAYwUK2TF9` | throwaway deploy key |
| 2026-11-04 | devnet | 3.2 add executor (execute) | `476CcJDQPvAATYDSrudbXmrvVfJa6ADyDQuBTQNCBJUas3KT1xRfLen3ddjHHeKqFA6MJxBt6Saue63R7zJHUYCT` | a voting member |
| 2026-11-04 | devnet | 3.4 SAT (execute) | `yZdB21hLThyjNCNJeiSF9H3n8TiDPR5XKA7LbDmJ3qBqVNvkzS1dyN4eiGP6SGyYoH3kJLZZToaMLKoHPNL3Uqy` | deploy key |
| 2026-11-04 | devnet | 3.5 upgrade (execute) | `4pkCJgdhiAnbPqCkiprNSrNVXQkVqCnqh2K8jJQbMijg3GptyjmDQVRfbcKUSHzXavtAKHdFSoaBKS45Syi8c8qZ` | a voting member |
| 2026-11-04 | devnet | 3.6 close buffer (execute) | `3ETsDNNXrpPdCHhjvyttRAM6XHnsYKJ89PAWAEaj49xWdZ9ZSA185KwqYShfH2UaHiwgazwoPWLav5JtvCePFuyY` | a voting member |
| 2026-11-04 | devnet | 3.7 remove executor (execute) | `aTCN5qXXBQ8r9UEg5W2yDiJLCMVXTK8Rat3FSdR9iSJnRCcy5ReuQXHzN7S54YDvS5JvtZfCmYXByu9Hkeprv1a` | a voting member |
| — | mainnet-beta | 3.4 SAT for `agent_registry` | — | *not yet executed* |

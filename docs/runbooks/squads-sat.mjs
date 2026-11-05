#!/usr/bin/env node
// Squads v4 helper for docs/runbooks/upgrade-authority.md.
//
// It creates proposals and executes approved ones. It never approves on anyone's behalf
// except the keypair you pass, and it never reads ~/.config/solana/id.json. Every write
// needs --url and --keypair spelled out.
//
// Setup (keeps the repo's own dependencies untouched):
//   T=$(mktemp -d) && cp docs/runbooks/squads-sat.mjs "$T" && cd "$T"
//   npm init -y >/dev/null && npm i @sqds/multisig@2.1.4 @solana/web3.js@1.98.4
//   node squads-sat.mjs --help

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import * as multisig from "@sqds/multisig";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  SYSVAR_RENT_PUBKEY,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";

const LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const { Permission, Permissions } = multisig.types;

const USAGE = `usage: node squads-sat.mjs <command> --url <rpc> [options]

read-only:
  status                --multisig M [--index N]
  program               --program P              upgrade authority of a program (or a buffer with --buffer B)

proposals (--keypair = a member with Proposer permission):
  propose-add-executor  --multisig M --member K   add K as an Execute-only member
  propose-remove-member --multisig M --member K
  propose-sat           --multisig M --program P --current-authority A
                        SetAuthorityChecked: P's upgrade authority A -> vault. A co-signs at execution.
  propose-upgrade       --multisig M --program P --buffer B --spill S
  propose-close-buffer  --multisig M --buffer B --recipient R

votes and execution:
  approve               --multisig M --index N --keypair <member with Voter permission>
  execute               --multisig M --index N --keypair <member with Executor permission>
                        [--co-signer <keypair>]   extra signer the inner instruction needs

rehearsal only (devnet/localnet; on mainnet create the multisig in the Squads app):
  create-multisig       --keypair <creator> --members K1,K2,K3 --threshold 2

common: [--vault-index 0] [--priority-fee <micro-lamports per CU>]`;

const { values: o, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    url: { type: "string" },
    keypair: { type: "string" },
    "co-signer": { type: "string" },
    multisig: { type: "string" },
    index: { type: "string" },
    member: { type: "string" },
    members: { type: "string" },
    threshold: { type: "string" },
    program: { type: "string" },
    buffer: { type: "string" },
    spill: { type: "string" },
    recipient: { type: "string" },
    "current-authority": { type: "string" },
    "vault-index": { type: "string", default: "0" },
    "priority-fee": { type: "string" },
    help: { type: "boolean" },
  },
});

const command = positionals[0];
if (o.help || !command) {
  console.log(USAGE);
  process.exit(o.help ? 0 : 1);
}

function need(name) {
  if (!o[name]) throw new Error(`--${name} is required for ${command}`);
  return o[name];
}
const pk = (name) => new PublicKey(need(name));
const loadKeypair = (path) =>
  Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));

// Same monikers as solana-cli's --url, so one URL variable works for both tools.
const MONIKERS = {
  devnet: "https://api.devnet.solana.com",
  d: "https://api.devnet.solana.com",
  testnet: "https://api.testnet.solana.com",
  t: "https://api.testnet.solana.com",
  "mainnet-beta": "https://api.mainnet-beta.solana.com",
  m: "https://api.mainnet-beta.solana.com",
  localhost: "http://localhost:8899",
  l: "http://localhost:8899",
};
const connection = new Connection(MONIKERS[need("url")] ?? o.url, "confirmed");
const vaultIndex = Number(o["vault-index"]);

// Upgradeable-loader account layouts (bincode): Buffer = 1, ProgramData = 3.
async function loaderAuthority(address) {
  const info = await connection.getAccountInfo(address);
  if (!info) throw new Error(`${address.toBase58()} not found`);
  if (!info.owner.equals(LOADER)) throw new Error(`${address.toBase58()} is not owned by the upgradeable loader`);
  const kind = info.data.readUInt32LE(0);
  const tagAt = kind === 1 ? 4 : kind === 3 ? 12 : -1;
  if (tagAt < 0) throw new Error(`${address.toBase58()} is not a buffer or program-data account (kind ${kind})`);
  return info.data[tagAt] === 1 ? new PublicKey(info.data.subarray(tagAt + 1, tagAt + 33)) : null;
}

function programDataAddress(program) {
  return PublicKey.findProgramAddressSync([program.toBuffer()], LOADER)[0];
}

function loaderIx(tag, keys) {
  const data = Buffer.alloc(4);
  data.writeUInt32LE(tag);
  return new TransactionInstruction({ programId: LOADER, keys, data });
}
const w = (pubkey, isSigner = false) => ({ pubkey, isSigner, isWritable: true });
const r = (pubkey, isSigner = false) => ({ pubkey, isSigner, isWritable: false });

async function confirm(signature) {
  // Poll instead of subscribing over the websocket (same reason as programs#2).
  for (let i = 0; i < 60; i++) {
    const { value } = await connection.getSignatureStatuses([signature]);
    const s = value[0];
    if (s?.err) throw new Error(`${signature} failed: ${JSON.stringify(s.err)}`);
    if (s && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized")) return;
    await new Promise((res) => setTimeout(res, 1000));
  }
  throw new Error(`${signature} not confirmed after 60 s; check it before retrying`);
}

async function send(instructions, signers, lookupTables = []) {
  const pre = [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })];
  if (o["priority-fee"]) {
    pre.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: Number(o["priority-fee"]) }));
  }
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: signers[0].publicKey,
    recentBlockhash: blockhash,
    instructions: [...pre, ...instructions],
  }).compileToV0Message(lookupTables);
  const tx = new VersionedTransaction(message);
  tx.sign(signers);
  const signature = await connection.sendRawTransaction(tx.serialize());
  await confirm(signature);
  console.log(`signature: ${signature}`);
  return signature;
}

async function loadMultisig() {
  const multisigPda = pk("multisig");
  const account = await multisig.accounts.Multisig.fromAccountAddress(connection, multisigPda);
  const [vaultPda] = multisig.getVaultPda({ multisigPda, index: vaultIndex });
  return { multisigPda, account, vaultPda };
}

const describePermissions = (mask) =>
  ["Proposer", "Voter", "Executor"].filter((_, bit) => mask & (1 << bit)).join("+") || "none";

async function propose(kind, build) {
  const { multisigPda, account, vaultPda } = await loadMultisig();
  const creator = loadKeypair(need("keypair"));
  const transactionIndex = BigInt(account.transactionIndex.toString()) + 1n;
  const createIx = await build({ multisigPda, vaultPda, creator: creator.publicKey, transactionIndex });
  const proposalIx = multisig.instructions.proposalCreate({
    multisigPda,
    transactionIndex,
    creator: creator.publicKey,
  });
  await send([createIx, proposalIx], [creator]);
  console.log(`${kind} proposal created: multisig ${multisigPda.toBase58()} index ${transactionIndex}`);
  console.log(`vault (index ${vaultIndex}): ${vaultPda.toBase58()}`);
}

function vaultTransaction(instruction, memo) {
  return ({ multisigPda, vaultPda, creator, transactionIndex }) =>
    multisig.instructions.vaultTransactionCreate({
      multisigPda,
      transactionIndex,
      creator,
      vaultIndex,
      ephemeralSigners: 0,
      transactionMessage: new TransactionMessage({
        payerKey: vaultPda,
        recentBlockhash: PublicKey.default.toBase58(), // ignored by Squads; replaced at execution
        instructions: [instruction(vaultPda)],
      }),
      memo,
    });
}

function configTransaction(actions, memo) {
  return ({ multisigPda, creator, transactionIndex }) =>
    multisig.instructions.configTransactionCreate({ multisigPda, transactionIndex, creator, actions, memo });
}

const commands = {
  async status() {
    const { multisigPda, account, vaultPda } = await loadMultisig();
    console.log(`multisig:          ${multisigPda.toBase58()}`);
    console.log(`vault (index ${vaultIndex}):  ${vaultPda.toBase58()}`);
    const voters = account.members.filter((m) => Permissions.has(m.permissions, Permission.Vote)).length;
    console.log(`threshold:         ${account.threshold} of ${voters} voters (${account.members.length} members)`);
    console.log(`config authority:  ${account.configAuthority.equals(PublicKey.default) ? "none (changes need a vote)" : account.configAuthority.toBase58()}`);
    console.log(`time lock:         ${account.timeLock} s`);
    console.log(`transaction index: ${account.transactionIndex} (unexecuted proposals <= ${account.staleTransactionIndex} are stale)`);
    for (const m of account.members) console.log(`  member ${m.key.toBase58()}  ${describePermissions(m.permissions.mask)}`);
    if (o.index) {
      const transactionIndex = BigInt(o.index);
      const [proposalPda] = multisig.getProposalPda({ multisigPda, transactionIndex });
      const p = await multisig.accounts.Proposal.fromAccountAddress(connection, proposalPda);
      console.log(`proposal ${o.index}: ${p.status.__kind}, approved by ${p.approved.map((k) => k.toBase58()).join(", ") || "nobody"}`);
      const [txPda] = multisig.getTransactionPda({ multisigPda, index: transactionIndex });
      const info = await connection.getAccountInfo(txPda);
      if (info && info.data.subarray(0, 8).equals(Buffer.from(multisig.accounts.vaultTransactionDiscriminator))) {
        const [vt] = multisig.accounts.VaultTransaction.fromAccountInfo(info);
        vt.message.instructions.forEach((ix, n) => {
          const program = vt.message.accountKeys[ix.programIdIndex].toBase58();
          const keys = [...ix.accountIndexes].map((i) => vt.message.accountKeys[i].toBase58());
          console.log(`  instruction ${n}: program ${program} data ${Buffer.from(ix.data).toString("hex")}`);
          keys.forEach((k, i) => console.log(`    account ${i}: ${k}`));
        });
      }
    }
  },

  async program() {
    if (o.buffer) {
      const a = await loaderAuthority(pk("buffer"));
      console.log(`buffer authority: ${a ? a.toBase58() : "none"}`);
      return;
    }
    const program = pk("program");
    const programData = programDataAddress(program);
    const a = await loaderAuthority(programData);
    console.log(`program data:      ${programData.toBase58()}`);
    console.log(`upgrade authority: ${a ? a.toBase58() : "none (immutable)"}`);
  },

  async "create-multisig"() {
    const creator = loadKeypair(need("keypair"));
    const createKey = Keypair.generate();
    const [multisigPda] = multisig.getMultisigPda({ createKey: createKey.publicKey });
    const [programConfigPda] = multisig.getProgramConfigPda({});
    const programConfig = await multisig.accounts.ProgramConfig.fromAccountAddress(connection, programConfigPda);
    const members = need("members")
      .split(",")
      .map((k) => ({ key: new PublicKey(k), permissions: Permissions.all() }));
    const ix = multisig.instructions.multisigCreateV2({
      treasury: programConfig.treasury,
      createKey: createKey.publicKey,
      creator: creator.publicKey,
      multisigPda,
      configAuthority: null,
      threshold: Number(need("threshold")),
      members,
      timeLock: 0,
      rentCollector: null,
    });
    await send([ix], [creator, createKey]);
    console.log(`multisig: ${multisigPda.toBase58()}`);
    console.log(`vault (index 0): ${multisig.getVaultPda({ multisigPda, index: 0 })[0].toBase58()}`);
  },

  async "propose-add-executor"() {
    const key = pk("member");
    await propose(
      "add-executor",
      configTransaction(
        [{ __kind: "AddMember", newMember: { key, permissions: Permissions.fromPermissions([Permission.Execute]) } }],
        `add ${key.toBase58()} as executor for the upgrade-authority transfer`,
      ),
    );
  },

  async "propose-remove-member"() {
    const key = pk("member");
    await propose("remove-member", configTransaction([{ __kind: "RemoveMember", oldMember: key }], `remove ${key.toBase58()}`));
  },

  async "propose-sat"() {
    const program = pk("program");
    const current = pk("current-authority");
    const programData = programDataAddress(program);
    const onChain = await loaderAuthority(programData);
    if (!onChain || !onChain.equals(current)) {
      throw new Error(`upgrade authority on chain is ${onChain?.toBase58() ?? "none"}, not ${current.toBase58()}`);
    }
    // SetAuthorityChecked (7): [program data (w), current authority (signer), new authority (signer)].
    await propose(
      "safe-authority-transfer",
      vaultTransaction(
        (vault) => loaderIx(7, [w(programData), r(current, true), r(vault, true)]),
        `upgrade authority of ${program.toBase58()} -> vault`,
      ),
    );
  },

  async "propose-upgrade"() {
    const program = pk("program");
    const buffer = pk("buffer");
    const spill = pk("spill");
    const { vaultPda } = await loadMultisig();
    const bufferAuthority = await loaderAuthority(buffer);
    if (!bufferAuthority?.equals(vaultPda)) {
      throw new Error(`buffer authority is ${bufferAuthority?.toBase58() ?? "none"}; set it to the vault ${vaultPda.toBase58()} first`);
    }
    // Upgrade (3): [program data (w), program (w), buffer (w), spill (w), rent, clock, authority (signer)].
    await propose(
      "upgrade",
      vaultTransaction(
        (vault) =>
          loaderIx(3, [w(programDataAddress(program)), w(program), w(buffer), w(spill), r(SYSVAR_RENT_PUBKEY), r(SYSVAR_CLOCK_PUBKEY), r(vault, true)]),
        `upgrade ${program.toBase58()} from buffer ${buffer.toBase58()}`,
      ),
    );
  },

  async "propose-close-buffer"() {
    const buffer = pk("buffer");
    const recipient = pk("recipient");
    // Close (5): [buffer (w), recipient (w), authority (signer)].
    await propose(
      "close-buffer",
      vaultTransaction((vault) => loaderIx(5, [w(buffer), w(recipient), r(vault, true)]), `close buffer ${buffer.toBase58()}`),
    );
  },

  async approve() {
    const { multisigPda } = await loadMultisig();
    const member = loadKeypair(need("keypair"));
    const ix = multisig.instructions.proposalApprove({ multisigPda, transactionIndex: BigInt(need("index")), member: member.publicKey });
    await send([ix], [member]);
  },

  async execute() {
    const { multisigPda } = await loadMultisig();
    const member = loadKeypair(need("keypair"));
    const transactionIndex = BigInt(need("index"));
    const [txPda] = multisig.getTransactionPda({ multisigPda, index: transactionIndex });
    const info = await connection.getAccountInfo(txPda);
    if (!info) throw new Error(`transaction ${transactionIndex} not found`);
    const signers = [member];
    if (o["co-signer"]) signers.push(loadKeypair(o["co-signer"]));
    if (info.data.subarray(0, 8).equals(Buffer.from(multisig.accounts.configTransactionDiscriminator))) {
      const ix = multisig.instructions.configTransactionExecute({ multisigPda, transactionIndex, member: member.publicKey, rentPayer: member.publicKey });
      await send([ix], signers);
      return;
    }
    const { instruction, lookupTableAccounts } = await multisig.instructions.vaultTransactionExecute({
      connection,
      multisigPda,
      transactionIndex,
      member: member.publicKey,
    });
    await send([instruction], signers, lookupTableAccounts);
  },
};

if (!commands[command]) {
  console.error(`unknown command ${command}\n\n${USAGE}`);
  process.exit(1);
}
commands[command]().catch((e) => {
  console.error(`error: ${e.message}`);
  if (e.logs) console.error(e.logs.join("\n"));
  process.exit(1);
});

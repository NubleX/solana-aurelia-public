/**
 * Propose a Squads vault transaction that splits current vault AURA by
 * post-fee locked weights into the five allocation ATAs.
 *
 * Last bucket (team) takes dust. Requires threshold approvals (2-of-3).
 * With --execute and a second member key, approves + executes in one run
 * when the creator already counted as one vote.
 *
 *   KEYPAIR_PATH=./keys/payer.json npm run vest:squads:split
 *   KEYPAIR_PATH=./keys/payer.json CONFIRM_MAINNET=I_UNDERSTAND npm run vest:squads:split:live
 *   ... APPROVER_BUCKET=team npm run vest:squads:split:live -- --execute
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  PublicKey,
  TransactionMessage,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
  getAccount,
} from "@solana/spl-token";
import * as multisig from "@sqds/multisig";
import {
  getCluster,
  getConnection,
  loadEnv,
  loadKeypair,
} from "../lib/connection.js";
import { fromRaw, MINT, ROOT } from "./shared.js";
import {
  POST_FEE_LOCKED_SHARES,
  assertFeeMath,
  loadMemberSigner,
  loadSquadsState,
  previewPostFeeSplit,
  vaultAtaFor,
} from "./squads.js";

loadEnv();

const isLive = (): boolean =>
  process.argv.includes("--live") || process.env.LIVE === "1";

const wantExecute = (): boolean =>
  process.argv.includes("--execute") || process.env.EXECUTE === "1";

const main = async (): Promise<void> => {
  assertFeeMath();
  const live = isLive();
  const execute = wantExecute();
  const cluster = getCluster();
  const connection = getConnection();
  const creator = loadKeypair();
  const state = loadSquadsState();

  const multisigPda = new PublicKey(state.multisigPda);
  const vaultPda = new PublicKey(state.vaultPda);
  const vaultAta = vaultAtaFor(vaultPda);

  let balanceRaw = 0n;
  try {
    const acct = await getAccount(connection, vaultAta);
    balanceRaw = acct.amount;
  } catch {
    balanceRaw = 0n;
  }

  const parts = previewPostFeeSplit(balanceRaw);
  const totalWeight = POST_FEE_LOCKED_SHARES.reduce((a, s) => a + s.vestUi, 0);

  console.log(`cluster:     ${cluster}`);
  console.log(`mode:        ${live ? "LIVE" : "dry-run"}${execute ? " +execute" : ""}`);
  console.log(`multisig:    ${multisigPda.toBase58()}`);
  console.log(`vault:       ${vaultPda.toBase58()}`);
  console.log(`vault ATA:   ${vaultAta.toBase58()}`);
  console.log(`balance:     ${fromRaw(balanceRaw).toLocaleString()} AURA`);
  console.log(`weights sum: ${totalWeight.toLocaleString()} (post-fee vest)`);
  console.log("\nsplit plan:");
  POST_FEE_LOCKED_SHARES.forEach((s, i) => {
    console.log(
      `  ${s.bucket.padEnd(12)} weight=${s.vestUi.toLocaleString().padStart(12)}  -> ${fromRaw(parts[i]!).toLocaleString()} AURA`,
    );
  });

  const feePayer = creator.publicKey;
  const ixs = [];
  for (let i = 0; i < POST_FEE_LOCKED_SHARES.length; i++) {
    const share = POST_FEE_LOCKED_SHARES[i]!;
    const amount = parts[i]!;
    if (amount <= 0n) continue;
    const dest = new PublicKey(share.wallet);
    const destAta = getAssociatedTokenAddressSync(MINT, dest);
    ixs.push(
      createAssociatedTokenAccountIdempotentInstruction(
        vaultPda,
        destAta,
        dest,
        MINT,
      ),
      createTransferInstruction(vaultAta, destAta, vaultPda, amount),
    );
  }

  const plan = {
    cluster,
    live: false,
    multisigPda: multisigPda.toBase58(),
    vaultPda: vaultPda.toBase58(),
    vaultAta: vaultAta.toBase58(),
    balanceUi: fromRaw(balanceRaw),
    parts: POST_FEE_LOCKED_SHARES.map((s, i) => ({
      bucket: s.bucket,
      wallet: s.wallet,
      vestUi: s.vestUi,
      amountUi: fromRaw(parts[i]!),
      amountRaw: parts[i]!.toString(),
    })),
  };
  const planPath = resolve(ROOT, "assets/squads-split-plan.json");
  writeFileSync(planPath, JSON.stringify(plan, null, 2) + "\n");
  console.log(`\nwrote ${planPath}`);

  if (!live) {
    console.log(
      "\nDry-run only. Re-run with --live + CONFIRM_MAINNET=I_UNDERSTAND to propose.",
    );
    return;
  }
  if (cluster === "mainnet-beta" && process.env.CONFIRM_MAINNET !== "I_UNDERSTAND") {
    throw new Error("Refusing mainnet live split without CONFIRM_MAINNET=I_UNDERSTAND");
  }
  if (balanceRaw === 0n) {
    if (process.env.CRON_ALLOW_EMPTY === "1" || process.env.CRON === "1") {
      console.log("vault ATA balance is 0 - nothing to split (cron no-op)");
      return;
    }
    throw new Error("vault ATA balance is 0 - nothing to split");
  }
  if (ixs.length === 0) {
    throw new Error("no transfer instructions generated");
  }

  const multisigAccount = await multisig.accounts.Multisig.fromAccountAddress(
    connection,
    multisigPda,
  );
  const transactionIndex =
    BigInt(multisigAccount.transactionIndex.toString()) + 1n;

  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const transactionMessage = new TransactionMessage({
    payerKey: vaultPda,
    recentBlockhash: blockhash,
    instructions: ixs,
  });

  console.log(`\nproposing vault tx index ${transactionIndex}…`);
  const createTxSig = await multisig.rpc.vaultTransactionCreate({
    connection,
    feePayer: creator,
    multisigPda,
    transactionIndex,
    creator: creator.publicKey,
    vaultIndex: state.vaultIndex,
    ephemeralSigners: 0,
    transactionMessage,
    memo: "AURA monthly post-fee split",
  });
  console.log(`vaultTransactionCreate: ${createTxSig}`);

  const proposalSig = await multisig.rpc.proposalCreate({
    connection,
    feePayer: creator,
    creator,
    multisigPda,
    transactionIndex,
  });
  console.log(`proposalCreate: ${proposalSig}`);

  const approve1 = await multisig.rpc.proposalApprove({
    connection,
    feePayer: creator,
    member: creator,
    multisigPda,
    transactionIndex,
  });
  console.log(`proposalApprove (payer): ${approve1}`);

  let approve2: string | null = null;
  let executeSig: string | null = null;

  if (execute) {
    const approverRole = process.env.APPROVER_BUCKET ?? "team";
    const memberMeta = state.members.find((m) => m.role === approverRole);
    if (!memberMeta) {
      throw new Error(`APPROVER_BUCKET=${approverRole} not in squads members`);
    }
    const approver = loadMemberSigner(memberMeta.role, memberMeta.pubkey);
    if (!approver) {
      throw new Error(`cannot load signer for ${approverRole} (${memberMeta.pubkey})`);
    }
    if (approver.publicKey.equals(creator.publicKey)) {
      throw new Error("APPROVER_BUCKET must be a second distinct member for --execute");
    }
    approve2 = await multisig.rpc.proposalApprove({
      connection,
      feePayer: creator,
      member: approver,
      multisigPda,
      transactionIndex,
    });
    console.log(`proposalApprove (${approverRole}): ${approve2}`);

    executeSig = await multisig.rpc.vaultTransactionExecute({
      connection,
      feePayer: creator,
      multisigPda,
      transactionIndex,
      member: creator.publicKey,
    });
    console.log(`vaultTransactionExecute: ${executeSig}`);
  } else {
    console.log(
      "\nNeed 1 more approval (threshold 2). Re-run with --execute APPROVER_BUCKET=team|treasury",
    );
  }

  writeFileSync(
    planPath,
    JSON.stringify(
      {
        ...plan,
        live: true,
        transactionIndex: transactionIndex.toString(),
        createTxSig,
        proposalSig,
        approve1,
        approve2,
        executeSig,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`\nupdated ${planPath}`);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

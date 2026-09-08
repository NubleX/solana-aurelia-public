/**
 * Gather exactly 800M AURA from the five locked buckets into the stream sender.
 * Does NOT pull from circulating/LP float for the Streamflow fee - seasons
 * contributes the full 100M (of which F becomes the protocol fee at create).
 *
 * Requires assets/squads.json (Squads exists before gather, per live order).
 *
 *   KEYPAIR_PATH=./keys/payer.json npm run vest:gather:sender
 *   KEYPAIR_PATH=./keys/payer.json CONFIRM_MAINNET=I_UNDERSTAND npm run vest:gather:sender:live
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  getCluster,
  getConnection,
  loadEnv,
  loadKeypair,
} from "../lib/connection.js";
import {
  ROOT,
  MINT,
  fromRaw,
  toRaw,
  loadTokenomics,
  tryLoadBucketKey,
  getAuraBalance,
} from "./shared.js";
import {
  LOCKED_GATHER_UI,
  POST_FEE_LOCKED_SHARES,
  STREAM_AMOUNT_UI,
  STREAMFLOW_FEE_UI,
  assertFeeMath,
  loadSquadsState,
} from "./squads.js";

loadEnv();

const isLive = (): boolean =>
  process.argv.includes("--live") || process.env.LIVE === "1";

const fundSolUi = Number(process.env.FUND_SOL_PER_WALLET ?? "0.05");

type Step = {
  fromBucket: string;
  fromWallet: string;
  amountUi: number;
  keypair: Keypair | null;
};

const main = async (): Promise<void> => {
  assertFeeMath();
  const live = isLive();
  const cluster = getCluster();
  const cfg = loadTokenomics();

  // Squads must exist first (live order).
  const squads = loadSquadsState();
  console.log(`squads vault: ${squads.vaultPda}`);

  const senderBucket = process.env.STREAM_SENDER_BUCKET ?? "liquidity";
  let sender: Keypair;
  let senderWallet: string;
  if (senderBucket === "payer") {
    sender = loadKeypair();
    senderWallet = sender.publicKey.toBase58();
  } else {
    const alloc = cfg.allocations.find((a) => a.bucket === senderBucket);
    if (!alloc) throw new Error(`unknown STREAM_SENDER_BUCKET=${senderBucket}`);
    const loaded = tryLoadBucketKey(senderBucket, alloc.wallet);
    if (!loaded) {
      throw new Error(`missing key for sender ${senderBucket}`);
    }
    sender = loaded.keypair;
    senderWallet = alloc.wallet;
  }

  console.log(`cluster:  ${cluster}`);
  console.log(`mode:     ${live ? "LIVE" : "dry-run"}`);
  console.log(`sender:   ${senderWallet} (${senderBucket})`);
  console.log(`target:   ${LOCKED_GATHER_UI.toLocaleString()} AURA (= V ${STREAM_AMOUNT_UI.toLocaleString()} + F ${STREAMFLOW_FEE_UI.toLocaleString()} from seasons)`);
  console.log("NOTE: liquidity/circulating float is NOT skimmed for the fee.");

  const senderBal = await getAuraBalance(sender.publicKey);
  const senderHave = fromRaw(senderBal);
  console.log(`sender bal now: ${senderHave.toLocaleString()} AURA`);

  const steps: Step[] = [];
  let plannedIn = 0;

  for (const share of POST_FEE_LOCKED_SHARES) {
    // If sender is one of the locked buckets, skip self-transfer for that portion
    // (tokens already there count toward the 800M).
    if (share.wallet === senderWallet) {
      console.log(
        `  ${share.bucket}: already on sender - counting ${share.gatherUi.toLocaleString()} in place`,
      );
      plannedIn += share.gatherUi;
      continue;
    }
    const loaded = tryLoadBucketKey(share.bucket, share.wallet);
    const bal = await getAuraBalance(new PublicKey(share.wallet));
    const have = fromRaw(bal);
    const amountUi = Math.min(share.gatherUi, Math.floor(have));
    console.log(
      `  ${share.bucket.padEnd(12)} gather=${share.gatherUi.toLocaleString().padStart(12)}  have=${have.toLocaleString().padStart(12)}  send=${amountUi.toLocaleString().padStart(12)}  ${loaded ? "key:ok" : "key:MISSING"}`,
    );
    if (have + 0.5 < share.gatherUi) {
      console.warn(
        `WARN: ${share.bucket} short for gather (need ${share.gatherUi}, have ${have}) - will send ${amountUi}`,
      );
    }
    if (amountUi <= 0) {
      console.log(`  ${share.bucket}: skip (already drained / nothing to send)`);
      plannedIn += share.gatherUi; // assume prior partial gather credited sender
      continue;
    }
    steps.push({
      fromBucket: share.bucket,
      fromWallet: share.wallet,
      amountUi,
      keypair: loaded?.keypair ?? null,
    });
    plannedIn += share.gatherUi;
  }

  // If sender already holds some of the target from prior partial gathers,
  // still transfer the planned amounts from other buckets; final assert checks 800M.
  const projected = senderHave + steps.reduce((a, s) => a + s.amountUi, 0);
  // When sender is a locked bucket, that bucket's gatherUi is already in senderHave
  // and counted in plannedIn without a transfer - projected double-counts.
  // Better final check: after transfers, balance should be >= 800M if starting clean.

  console.log(`\nplanned gather transfers: ${steps.length}`);
  for (const s of steps) {
    console.log(`  ${s.fromBucket} -> sender: ${s.amountUi.toLocaleString()} AURA`);
  }
  console.log(`plannedIn (incl in-place): ${plannedIn.toLocaleString()}`);
  if (plannedIn !== LOCKED_GATHER_UI) {
    throw new Error(`gather plan sums to ${plannedIn}, expected ${LOCKED_GATHER_UI}`);
  }

  const outPath = resolve(ROOT, "assets/gather-sender-plan.json");
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        cluster,
        live: false,
        sender: senderWallet,
        senderBucket,
        targetUi: LOCKED_GATHER_UI,
        streamAmountUi: STREAM_AMOUNT_UI,
        feeUi: STREAMFLOW_FEE_UI,
        feeFrom: "seasons",
        senderHaveUi: senderHave,
        projectedUi: projected,
        steps: steps.map(({ keypair: _k, ...rest }) => rest),
        vaultPda: squads.vaultPda,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`\nwrote ${outPath}`);

  if (!live) {
    console.log("\nDry-run only. Re-run with --live + CONFIRM_MAINNET=I_UNDERSTAND.");
    return;
  }
  if (cluster === "mainnet-beta" && process.env.CONFIRM_MAINNET !== "I_UNDERSTAND") {
    throw new Error("Refusing mainnet live gather without CONFIRM_MAINNET=I_UNDERSTAND");
  }

  const connection = getConnection();
  const payer = loadKeypair();

  // SOL top-up for signing sources
  for (const step of steps) {
    if (!step.keypair) {
      throw new Error(`cannot sign gather from ${step.fromBucket}`);
    }
    const bal = await connection.getBalance(step.keypair.publicKey);
    const need = Math.floor(fundSolUi * LAMPORTS_PER_SOL);
    if (bal < need) {
      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: step.keypair.publicKey,
          lamports: need - bal,
        }),
      );
      const sig = await sendAndConfirmTransaction(connection, tx, [payer], {
        commitment: "confirmed",
      });
      console.log(`SOL top-up ${step.fromBucket}: ${sig}`);
    }
  }

  const destAta = getAssociatedTokenAddressSync(MINT, sender.publicKey);
  const results: Array<{ fromBucket: string; amountUi: number; signature: string }> = [];

  for (const step of steps) {
    if (!step.keypair) throw new Error(`missing key ${step.fromBucket}`);
    const raw = toRaw(step.amountUi);
    const srcAta = getAssociatedTokenAddressSync(MINT, step.keypair.publicKey);
    const tx = new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(
        payer.publicKey,
        destAta,
        sender.publicKey,
        MINT,
      ),
      createTransferInstruction(srcAta, destAta, step.keypair.publicKey, raw),
    );
    const sig = await sendAndConfirmTransaction(
      connection,
      tx,
      [payer, step.keypair],
      { commitment: "confirmed" },
    );
    console.log(
      `${step.fromBucket} -> sender: ${step.amountUi.toLocaleString()} AURA  ${sig}`,
    );
    results.push({
      fromBucket: step.fromBucket,
      amountUi: step.amountUi,
      signature: sig,
    });
  }

  const finalBal = await getAuraBalance(sender.publicKey);
  const finalUi = fromRaw(finalBal);
  console.log(`\nsender final: ${finalUi.toLocaleString()} AURA`);
  if (finalUi + 0.5 < LOCKED_GATHER_UI) {
    throw new Error(
      `sender still short of 800M after gather (have ${finalUi})`,
    );
  }
  // Prefer exactly 800M for create; warn if over (prior dust / LP overlap).
  if (finalUi > LOCKED_GATHER_UI + 1) {
    console.warn(
      `WARN: sender holds ${finalUi} (>800M). Stream create uses V+F=800M; excess stays on sender.`,
    );
  }

  writeFileSync(
    outPath,
    JSON.stringify(
      {
        cluster,
        live: true,
        sender: senderWallet,
        senderBucket,
        targetUi: LOCKED_GATHER_UI,
        finalUi,
        steps: results,
        vaultPda: squads.vaultPda,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`updated ${outPath}`);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

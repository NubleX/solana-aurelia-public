/**
 * Create Streamflow vesting streams for the 80% locked buckets.
 *
 * Default is dry-run: prints params, writes assets/streamflow-plan.json, sends nothing.
 * Live creates one non-cancelable monthly stream per vesting bucket.
 *
 * Sender mode (STREAM_SENDER=bucket|payer, default bucket):
 *   bucket - each alloc wallet self-vests to itself (recommended; tokens already there)
 *   payer  - payer must hold the 800M and streams out to each recipient
 *
 *   CLUSTER=mainnet-beta KEYPAIR_PATH=./keys/payer.json npm run vest:streamflow
 *   CLUSTER=mainnet-beta KEYPAIR_PATH=./keys/payer.json CONFIRM_MAINNET=I_UNDERSTAND npm run vest:streamflow:live
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Keypair, PublicKey } from "@solana/web3.js";
import { SolanaStreamClient, getBN } from "@streamflow/stream";
import {
  getCluster,
  getRpcUrl,
  loadEnv,
  loadKeypair,
} from "../lib/connection.js";
import {
  ROOT,
  MINT,
  DECIMALS,
  MONTH_SECS,
  loadTokenomics,
  tryLoadBucketKey,
  getAuraBalance,
  fromRaw,
  vestingBuckets,
} from "./shared.js";

loadEnv();

const isLive = (): boolean =>
  process.argv.includes("--live") || process.env.LIVE === "1";

type StreamPlan = {
  bucket: string;
  sender: string;
  recipient: string;
  amountUi: number;
  amountPerPeriodUi: number;
  durationMonths: number;
  periodSecs: number;
  cliffMonths: number;
  cancelableBySender: boolean;
  name: string;
};

const main = async (): Promise<void> => {
  const live = isLive();
  const cluster = getCluster();
  const senderMode = (process.env.STREAM_SENDER ?? "bucket") as "bucket" | "payer";
  console.log(`cluster: ${cluster}`);
  console.log(`mode:    ${live ? "LIVE" : "dry-run"}`);
  console.log(`sender:  ${senderMode}`);

  if (live && cluster === "mainnet-beta" && process.env.CONFIRM_MAINNET !== "I_UNDERSTAND") {
    throw new Error(
      "Refusing mainnet live Streamflow create without CONFIRM_MAINNET=I_UNDERSTAND",
    );
  }

  const cfg = loadTokenomics();
  const durationMonths = cfg.vesting.durationMonths;
  const cliffMonths = cfg.vesting.cliffMonths ?? 0;
  const start = Math.floor(Date.now() / 1000) + 60;
  const period = MONTH_SECS;
  const duration = durationMonths * period;
  const cliff = start + cliffMonths * period;

  const plans: StreamPlan[] = [];
  const signers = new Map<string, Keypair>();

  let payer: Keypair | null = null;
  if (process.env.KEYPAIR_PATH) {
    payer = loadKeypair();
    signers.set(payer.publicKey.toBase58(), payer);
  }

  for (const alloc of vestingBuckets(cfg)) {
    const amountUi = alloc.amount;
    const amountPerPeriodUi =
      alloc.release?.amountPerMonth ?? Math.floor(amountUi / durationMonths);
    const recipient = alloc.wallet;

    let senderPk = recipient;
    if (senderMode === "payer") {
      if (!payer) throw new Error("KEYPAIR_PATH required for STREAM_SENDER=payer");
      senderPk = payer.publicKey.toBase58();
    } else {
      const loaded = tryLoadBucketKey(alloc.bucket, alloc.wallet);
      if (!loaded) {
        throw new Error(
          `missing key for bucket ${alloc.bucket} (${alloc.wallet}). Expected keys/alloc-${alloc.bucket}.json`,
        );
      }
      signers.set(loaded.keypair.publicKey.toBase58(), loaded.keypair);
      senderPk = loaded.keypair.publicKey.toBase58();
    }

    plans.push({
      bucket: alloc.bucket,
      sender: senderPk,
      recipient,
      amountUi,
      amountPerPeriodUi,
      durationMonths,
      periodSecs: period,
      cliffMonths,
      cancelableBySender: cfg.vesting.cancelableBySender,
      name: `AURA ${alloc.label} ${durationMonths}m`,
    });
  }

  console.log("\n=== stream plan ===");
  for (const p of plans) {
    const bal = fromRaw(await getAuraBalance(new PublicKey(p.sender)));
    const ok = bal + 1e-9 >= p.amountUi;
    console.log(
      `${p.bucket.padEnd(12)} ${p.amountUi.toLocaleString()} AURA  sender=${p.sender.slice(0, 8)}…  bal=${bal.toLocaleString()}  ${ok ? "funded" : "UNDERFUNDED"}`,
    );
  }

  const outPath = resolve(ROOT, "assets/streamflow-plan.json");
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        cluster,
        live: false,
        mint: MINT.toBase58(),
        start,
        period,
        duration,
        cliff,
        plans,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`\nwrote ${outPath}`);

  if (!live) {
    console.log(
      "\nDry-run only. Re-run with --live and CONFIRM_MAINNET=I_UNDERSTAND after balances are correct.",
    );
    return;
  }

  const client = new SolanaStreamClient(getRpcUrl());
  const created: Array<StreamPlan & { metadataId: string; txId: string }> = [];

  for (const p of plans) {
    const sender = signers.get(p.sender);
    if (!sender) throw new Error(`no signer for ${p.sender}`);

    const createParams = {
      recipient: p.recipient,
      tokenId: MINT.toBase58(),
      start,
      amount: getBN(p.amountUi, DECIMALS),
      period,
      cliff,
      cliffAmount: getBN(cfg.vesting.cliffAmount ?? 0, DECIMALS),
      amountPerPeriod: getBN(p.amountPerPeriodUi, DECIMALS),
      name: p.name,
      canTopup: cfg.vesting.canTopup,
      cancelableBySender: cfg.vesting.cancelableBySender,
      cancelableByRecipient: false,
      transferableBySender: false,
      transferableByRecipient: false,
      automaticWithdrawal: false,
      withdrawalFrequency: 0,
    };

    console.log(`creating stream: ${p.bucket}…`);
    const { txId, metadataId } = await client.create(createParams, {
      sender,
      isNative: false,
    });
    console.log(`  metadata: ${metadataId}`);
    console.log(`  tx:       ${txId}`);
    created.push({ ...p, metadataId: String(metadataId), txId: String(txId) });
  }

  writeFileSync(
    outPath,
    JSON.stringify(
      {
        cluster,
        live: true,
        mint: MINT.toBase58(),
        start,
        period,
        duration,
        cliff,
        plans: created,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`\ndone. updated ${outPath}`);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

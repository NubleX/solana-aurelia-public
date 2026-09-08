/**
 * DEPRECATED: custom aura-splitter path is unused. Prefer
 * `createStreamflowToSquads.ts` / `npm run vest:streamflow:squads`.
 *
 * Create ONE Streamflow vesting stream for the full 800M locked supply,
 * with recipient = immutable aura-splitter config PDA.
 *
 * Requires:
 *   - splitter initialized (assets/splitter-state.json / SPLITTER_PROGRAM_ID)
 *   - sender ATA holds amount + 0.19% Streamflow token fee
 *
 * Uses automaticWithdrawal so unlocks land in the PDA vault without a hot key.
 * Crank `npm run vest:splitter:split` after unlocks to distribute by share.
 *
 *   KEYPAIR_PATH=./keys/payer.json SPLITTER_PROGRAM_ID=... npm run vest:streamflow:splitter
 *   KEYPAIR_PATH=./keys/payer.json SPLITTER_PROGRAM_ID=... CONFIRM_MAINNET=I_UNDERSTAND npm run vest:streamflow:splitter:live
 */
import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PublicKey } from "@solana/web3.js";
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
  getAuraBalance,
  fromRaw,
  tryLoadBucketKey,
} from "./shared.js";
import {
  DEFAULT_LOCKED_SHARES,
  findConfigPda,
  vaultAta,
  loadProgramId,
} from "./splitter.js";

loadEnv();

const isLive = (): boolean =>
  process.argv.includes("--live") || process.env.LIVE === "1";

/** Streamflow SDK charges 0.19% on top of deposited amount. */
const FEE_BPS = 19n; // 0.19% = 19 / 10000
const feeOnTop = (amount: bigint): bigint => (amount * FEE_BPS + 9999n) / 10000n;

const main = async (): Promise<void> => {
  const live = isLive();
  const cluster = getCluster();
  const programId = loadProgramId();
  const cfg = loadTokenomics();
  const lockedUi = cfg.vesting.lockedAmount;
  const durationMonths = cfg.vesting.durationMonths;
  const period = MONTH_SECS;
  const start = Math.floor(Date.now() / 1000) + 120;
  const cliff = start + (cfg.vesting.cliffMonths ?? 0) * period;
  const amountPerMonth =
    Math.floor(lockedUi / durationMonths); // Streamflow uses amountPerPeriod

  const [configPda] = findConfigPda(MINT, programId);
  const vault = vaultAta(MINT, configPda);

  // Prefer liquidity wallet as sender if it will hold the consolidated 800M+fee;
  // override with STREAM_SENDER_BUCKET=treasury|payer|liquidity|community|...
  const senderBucket = process.env.STREAM_SENDER_BUCKET ?? "liquidity";
  let sender;
  if (senderBucket === "payer") {
    sender = loadKeypair();
  } else {
    const alloc = cfg.allocations.find((a) => a.bucket === senderBucket);
    if (!alloc) throw new Error(`unknown STREAM_SENDER_BUCKET=${senderBucket}`);
    const loaded = tryLoadBucketKey(senderBucket, alloc.wallet);
    if (!loaded) {
      throw new Error(`missing key for ${senderBucket} (${alloc.wallet})`);
    }
    sender = loaded.keypair;
  }

  const amountRaw = BigInt(lockedUi) * 10n ** BigInt(DECIMALS);
  const feeRaw = feeOnTop(amountRaw);
  const needRaw = amountRaw + feeRaw;
  const bal = await getAuraBalance(sender.publicKey);

  console.log(`cluster:    ${cluster}`);
  console.log(`mode:       ${live ? "LIVE" : "dry-run"}`);
  console.log(`program:    ${programId.toBase58()}`);
  console.log(`recipient:  ${configPda.toBase58()} (splitter PDA)`);
  console.log(`vault ATA:  ${vault.toBase58()}`);
  console.log(`sender:     ${sender.publicKey.toBase58()} (${senderBucket})`);
  console.log(`vest:       ${lockedUi.toLocaleString()} AURA over ${durationMonths}m`);
  console.log(`per period: ~${amountPerMonth.toLocaleString()} AURA`);
  console.log(`fee 0.19%:  ${fromRaw(feeRaw).toLocaleString()} AURA (on top)`);
  console.log(`need total: ${fromRaw(needRaw).toLocaleString()} AURA`);
  console.log(`sender bal: ${fromRaw(bal).toLocaleString()} AURA  ${bal >= needRaw ? "OK" : "UNDERFUNDED"}`);
  console.log("split targets:");
  for (const r of DEFAULT_LOCKED_SHARES) {
    console.log(`  ${r.bucket.padEnd(12)} ${r.share}/800`);
  }

  const plan = {
    cluster,
    live: false,
    mint: MINT.toBase58(),
    splitterProgramId: programId.toBase58(),
    recipientPda: configPda.toBase58(),
    vaultAta: vault.toBase58(),
    sender: sender.publicKey.toBase58(),
    senderBucket,
    amountUi: lockedUi,
    feeUi: fromRaw(feeRaw),
    needUi: fromRaw(needRaw),
    start,
    cliff,
    period,
    durationMonths,
    amountPerMonth,
    automaticWithdrawal: true,
    cancelableBySender: false,
    shares: DEFAULT_LOCKED_SHARES,
  };
  writeFileSync(
    resolve(ROOT, "assets/streamflow-splitter-plan.json"),
    JSON.stringify(plan, null, 2) + "\n",
  );
  console.log("\nwrote assets/streamflow-splitter-plan.json");

  if (!live) {
    console.log(
      "\nDry-run only. Fund sender with needUi, then re-run with --live + CONFIRM_MAINNET=I_UNDERSTAND.",
    );
    return;
  }
  if (cluster === "mainnet-beta" && process.env.CONFIRM_MAINNET !== "I_UNDERSTAND") {
    throw new Error("Refusing mainnet live Streamflow without CONFIRM_MAINNET=I_UNDERSTAND");
  }
  if (bal < needRaw) {
    throw new Error(
      `sender underfunded: have ${fromRaw(bal)}, need ${fromRaw(needRaw)} (includes 0.19% fee)`,
    );
  }

  // Confirm splitter config exists
  const connection = (await import("../lib/connection.js")).getConnection();
  const cfgInfo = await connection.getAccountInfo(configPda);
  if (!cfgInfo) {
    throw new Error("splitter config PDA missing - run vest:splitter:init:live first");
  }

  const client = new SolanaStreamClient(getRpcUrl());
  const createParams = {
    recipient: configPda.toBase58(),
    tokenId: MINT.toBase58(),
    start,
    amount: getBN(lockedUi, DECIMALS),
    period,
    cliff,
    cliffAmount: getBN(0, DECIMALS),
    amountPerPeriod: getBN(amountPerMonth, DECIMALS),
    name: `AURA locked 800M ${durationMonths}m splitter`,
    canTopup: false,
    cancelableBySender: false,
    cancelableByRecipient: false,
    transferableBySender: false,
    transferableByRecipient: false,
    automaticWithdrawal: true,
    withdrawalFrequency: period,
  };

  console.log("\ncreating Streamflow vesting stream…");
  const { txId, metadataId } = await client.create(createParams, {
    sender,
    isNative: false,
  });
  console.log(`metadata: ${metadataId}`);
  console.log(`tx:       ${txId}`);

  const result = {
    ...plan,
    live: true,
    metadataId: String(metadataId),
    txId: String(txId),
  };
  writeFileSync(
    resolve(ROOT, "assets/streamflow-splitter-plan.json"),
    JSON.stringify(result, null, 2) + "\n",
  );

  const deployPath = resolve(ROOT, "assets/splitter-deploy.json");
  const prev = existsSync(deployPath)
    ? (JSON.parse(readFileSync(deployPath, "utf8")) as Record<string, unknown>)
    : {};
  writeFileSync(
    deployPath,
    JSON.stringify(
      {
        ...prev,
        streamflow: {
          metadataId: String(metadataId),
          txId: String(txId),
          recipientPda: configPda.toBase58(),
          amountUi: lockedUi,
        },
      },
      null,
      2,
    ) + "\n",
  );
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

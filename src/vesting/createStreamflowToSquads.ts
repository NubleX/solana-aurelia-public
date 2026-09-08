/**
 * Create ONE Streamflow vesting stream: amount = V (~798.482883M AURA),
 * recipient = Squads vault PDA. Sender must hold exactly 800M (V + 0.19% fee).
 * Fee F is taken from seasons inside the gather - not from circulating/LP.
 *
 *   KEYPAIR_PATH=./keys/payer.json npm run vest:streamflow:squads
 *   KEYPAIR_PATH=./keys/payer.json CONFIRM_MAINNET=I_UNDERSTAND npm run vest:streamflow:squads:live
 */
import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { SolanaStreamClient, getBN } from "@streamflow/stream";
import {
  getCluster,
  getRpcUrl,
  loadEnv,
  loadKeypair,
  getConnection,
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
  LOCKED_GATHER_RAW,
  LOCKED_GATHER_UI,
  POST_FEE_LOCKED_SHARES,
  STREAM_AMOUNT_RAW,
  STREAM_AMOUNT_UI,
  STREAMFLOW_FEE_RAW,
  STREAMFLOW_FEE_UI,
  assertFeeMath,
  loadSquadsState,
  vaultAtaFor,
} from "./squads.js";

loadEnv();

const isLive = (): boolean =>
  process.argv.includes("--live") || process.env.LIVE === "1";

const main = async (): Promise<void> => {
  assertFeeMath();
  const live = isLive();
  const cluster = getCluster();
  const cfg = loadTokenomics();
  const durationMonths = cfg.vesting.durationMonths;
  const period = MONTH_SECS;
  const start = Math.floor(Date.now() / 1000) + 120;
  const cliff = start + (cfg.vesting.cliffMonths ?? 0) * period;
  const amountPerMonth = Math.floor(STREAM_AMOUNT_UI / durationMonths);

  const squads = loadSquadsState();
  const vaultPda = new PublicKey(squads.vaultPda);
  const vaultAta = vaultAtaFor(vaultPda);

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

  const needRaw = LOCKED_GATHER_RAW; // V_raw + F_raw
  const bal = await getAuraBalance(sender.publicKey);

  console.log(`cluster:    ${cluster}`);
  console.log(`mode:       ${live ? "LIVE" : "dry-run"}`);
  console.log(`recipient:  ${vaultPda.toBase58()} (Squads vault PDA)`);
  console.log(`vault ATA:  ${vaultAta.toBase58()}`);
  console.log(`sender:     ${sender.publicKey.toBase58()} (${senderBucket})`);
  console.log(`stream V:   ~${STREAM_AMOUNT_UI.toLocaleString()} AURA over ${durationMonths}m`);
  console.log(`stream raw: ${STREAM_AMOUNT_RAW.toString()}`);
  console.log(`per period: ~${amountPerMonth.toLocaleString()} AURA`);
  console.log(`fee F:      ~${STREAMFLOW_FEE_UI.toLocaleString()} AURA (from seasons)`);
  console.log(`fee raw:    ${STREAMFLOW_FEE_RAW.toString()}`);
  console.log(`gather:     ${LOCKED_GATHER_UI.toLocaleString()} AURA (= V+F; not 801.52M)`);
  console.log(`sender bal: ${fromRaw(bal).toLocaleString()} AURA  ${bal >= needRaw ? "OK" : "UNDERFUNDED"}`);
  console.log("post-fee split targets:");
  for (const r of POST_FEE_LOCKED_SHARES) {
    console.log(`  ${r.bucket.padEnd(12)} vest=${r.vestUi.toLocaleString()}`);
  }

  const plan = {
    cluster,
    live: false,
    mint: MINT.toBase58(),
    recipientVault: vaultPda.toBase58(),
    vaultAta: vaultAta.toBase58(),
    multisigPda: squads.multisigPda,
    sender: sender.publicKey.toBase58(),
    senderBucket,
    streamAmountUi: STREAM_AMOUNT_UI,
    streamAmountRaw: STREAM_AMOUNT_RAW.toString(),
    feeUi: STREAMFLOW_FEE_UI,
    feeRaw: STREAMFLOW_FEE_RAW.toString(),
    feeFrom: "seasons",
    gatherUi: LOCKED_GATHER_UI,
    start,
    cliff,
    period,
    durationMonths,
    amountPerMonth,
    automaticWithdrawal: true,
    cancelableBySender: false,
    transferableBySender: false,
    shares: POST_FEE_LOCKED_SHARES,
  };
  writeFileSync(
    resolve(ROOT, "assets/streamflow-squads-plan.json"),
    JSON.stringify(plan, null, 2) + "\n",
  );
  console.log("\nwrote assets/streamflow-squads-plan.json");

  if (!live) {
    console.log(
      "\nDry-run only. Gather 800M to sender, then --live + CONFIRM_MAINNET=I_UNDERSTAND.",
    );
    return;
  }
  if (cluster === "mainnet-beta" && process.env.CONFIRM_MAINNET !== "I_UNDERSTAND") {
    throw new Error("Refusing mainnet live Streamflow without CONFIRM_MAINNET=I_UNDERSTAND");
  }
  if (bal < needRaw) {
    throw new Error(
      `sender underfunded: have ${fromRaw(bal)}, need ${fromRaw(needRaw)} (exactly V+F=800M)`,
    );
  }

  const connection = getConnection();
  const msInfo = await connection.getAccountInfo(new PublicKey(squads.multisigPda));
  if (!msInfo) {
    throw new Error("multisig missing - run vest:squads:create:live first");
  }

  const client = new SolanaStreamClient(getRpcUrl());
  const createParams = {
    recipient: vaultPda.toBase58(),
    tokenId: MINT.toBase58(),
    start,
    amount: new BN(STREAM_AMOUNT_RAW.toString()),
    period,
    cliff,
    cliffAmount: getBN(0, DECIMALS),
    amountPerPeriod: getBN(amountPerMonth, DECIMALS),
    name: `AURA locked ${STREAM_AMOUNT_UI} ${durationMonths}m Squads`,
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
    resolve(ROOT, "assets/streamflow-squads-plan.json"),
    JSON.stringify(result, null, 2) + "\n",
  );

  const squadsPath = resolve(ROOT, "assets/squads.json");
  const prev = existsSync(squadsPath)
    ? (JSON.parse(readFileSync(squadsPath, "utf8")) as Record<string, unknown>)
    : {};
  writeFileSync(
    squadsPath,
    JSON.stringify(
      {
        ...prev,
        streamflow: {
          metadataId: String(metadataId),
          txId: String(txId),
          recipientVault: vaultPda.toBase58(),
          streamAmountUi: STREAM_AMOUNT_UI,
          feeUi: STREAMFLOW_FEE_UI,
          feeFrom: "seasons",
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

/**
 * Rebalance AURA across allocation wallets to match config/tokenomics.json targets.
 *
 * Dry-run (default): print current vs target and the transfer plan.
 * Live: KEYPAIR_PATH must be set; bucket keys under keys/alloc-*.json (or keys/<bucket>.json)
 * must match tokenomics wallet pubkeys.
 *
 *   CLUSTER=mainnet-beta KEYPAIR_PATH=./keys/payer.json npm run vest:rebalance
 *   CLUSTER=mainnet-beta KEYPAIR_PATH=./keys/payer.json npm run vest:rebalance:live
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
import { getConnection, getCluster, loadKeypair, loadEnv } from "../lib/connection.js";
import {
  ROOT,
  MINT,
  fromRaw,
  toRaw,
  loadTokenomics,
  tryLoadBucketKey,
  getAuraBalance,
  targetUiForBucket,
  type Allocation,
} from "./shared.js";

loadEnv();

type Position = {
  bucket: string;
  wallet: string;
  targetUi: number;
  currentUi: number;
  deltaUi: number;
  keyPath: string | null;
  canSign: boolean;
  keypair: Keypair | null;
};

type TransferStep = {
  from: string;
  to: string;
  amountUi: number;
  fromBucket: string;
  toBucket: string;
};

const isLive = (): boolean =>
  process.argv.includes("--live") || process.env.LIVE === "1";

const fundSolUi = Number(process.env.FUND_SOL_PER_WALLET ?? "0.05");

const buildPositions = async (allocs: Allocation[]): Promise<Position[]> => {
  const positions: Position[] = [];
  for (const alloc of allocs) {
    const loaded = tryLoadBucketKey(alloc.bucket, alloc.wallet);
    const current = await getAuraBalance(new PublicKey(alloc.wallet));
    const targetUi = targetUiForBucket(alloc);
    const currentUi = fromRaw(current);
    positions.push({
      bucket: alloc.bucket,
      wallet: alloc.wallet,
      targetUi,
      currentUi,
      deltaUi: targetUi - currentUi,
      keyPath: loaded?.path ?? null,
      canSign: Boolean(loaded),
      keypair: loaded?.keypair ?? null,
    });
  }

  // Payer is an extra source/sink when present
  const payerPath = process.env.KEYPAIR_PATH;
  if (payerPath) {
    try {
      const payer = loadKeypair(payerPath);
      const current = await getAuraBalance(payer.publicKey);
      const currentUi = fromRaw(current);
      positions.push({
        bucket: "payer",
        wallet: payer.publicKey.toBase58(),
        targetUi: 0,
        currentUi,
        deltaUi: -currentUi, // prefer draining spare payer AURA into deficits
        keyPath: payerPath,
        canSign: true,
        keypair: payer,
      });
    } catch (err) {
      console.warn(`payer key not loaded: ${String(err)}`);
    }
  }

  return positions;
};

/**
 * Greedy match: sources with surplus (delta < 0) fund sinks with deficit (delta > 0).
 * If a dust shortfall remains (supply left the system), pull extra from liquidity
 * then payer so vesting buckets can still hit exact tokenomics amounts.
 */
const planTransfers = (positions: Position[]): TransferStep[] => {
  const remainingOut = new Map<string, number>();
  for (const p of positions) remainingOut.set(p.bucket, 0);

  const sources = positions
    .filter((p) => p.deltaUi < -0.5 && p.canSign)
    .map((p) => ({ ...p, remaining: -p.deltaUi }));
  const sinks = positions
    .filter((p) => p.bucket !== "payer" && p.deltaUi > 0.5)
    .map((p) => ({ ...p, needed: p.deltaUi }));

  const steps: TransferStep[] = [];
  const push = (
    fromBucket: string,
    fromWallet: string,
    sink: (typeof sinks)[number],
    amountUi: number,
  ) => {
    if (amountUi <= 0) return;
    steps.push({
      from: fromWallet,
      to: sink.wallet,
      amountUi,
      fromBucket,
      toBucket: sink.bucket,
    });
    remainingOut.set(fromBucket, (remainingOut.get(fromBucket) ?? 0) + amountUi);
    sink.needed -= amountUi;
  };

  for (const sink of sinks) {
    for (const src of sources) {
      if (sink.needed <= 0) break;
      if (src.remaining <= 0) continue;
      const amountUi = Math.floor(Math.min(src.remaining, sink.needed));
      push(src.bucket, src.wallet, sink, amountUi);
      src.remaining -= amountUi;
    }
  }

  for (const sink of sinks) {
    if (sink.needed <= 0.5) continue;
    for (const prefer of ["liquidity", "payer"] as const) {
      if (sink.needed <= 0.5) break;
      const srcPos = positions.find((p) => p.bucket === prefer && p.canSign);
      if (!srcPos) continue;
      const left = Math.floor(srcPos.currentUi - (remainingOut.get(prefer) ?? 0));
      const take = Math.floor(Math.min(left, sink.needed));
      push(prefer, srcPos.wallet, sink, take);
    }
  }

  return steps;
};

const executeTransfer = async (
  from: Keypair,
  to: PublicKey,
  amountUi: number,
): Promise<string> => {
  const connection = getConnection();
  const raw = toRaw(amountUi);
  const srcAta = getAssociatedTokenAddressSync(MINT, from.publicKey);
  const destAta = getAssociatedTokenAddressSync(MINT, to);
  const tx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(
      from.publicKey,
      destAta,
      to,
      MINT,
    ),
    createTransferInstruction(srcAta, destAta, from.publicKey, raw),
  );
  return sendAndConfirmTransaction(connection, tx, [from], {
    commitment: "confirmed",
  });
};

const fundSolIfNeeded = async (
  payer: Keypair,
  dest: PublicKey,
  minSol = fundSolUi,
): Promise<string | null> => {
  const connection = getConnection();
  const bal = await connection.getBalance(dest);
  const need = Math.floor(minSol * LAMPORTS_PER_SOL);
  if (bal >= need) return null;
  const topUp = need - bal;
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: dest,
      lamports: topUp,
    }),
  );
  return sendAndConfirmTransaction(connection, tx, [payer], {
    commitment: "confirmed",
  });
};

const main = async (): Promise<void> => {
  const live = isLive();
  const cluster = getCluster();
  console.log(`cluster: ${cluster}`);
  console.log(`mode:    ${live ? "LIVE" : "dry-run"}`);

  if (live && cluster === "mainnet-beta" && process.env.CONFIRM_MAINNET !== "I_UNDERSTAND") {
    throw new Error(
      "Refusing mainnet live rebalance without CONFIRM_MAINNET=I_UNDERSTAND",
    );
  }

  const cfg = loadTokenomics();
  const positions = await buildPositions(cfg.allocations);

  console.log("\n=== balances vs targets ===");
  for (const p of positions) {
    const sign = p.canSign ? "key:ok" : "key:MISSING";
    console.log(
      `${p.bucket.padEnd(12)} target=${p.targetUi.toLocaleString()}  have=${p.currentUi.toLocaleString()}  delta=${p.deltaUi.toLocaleString()}  ${sign}`,
    );
  }

  const steps = planTransfers(positions);
  console.log(`\n=== transfer plan (${steps.length}) ===`);
  if (steps.length === 0) {
    console.log("nothing to move");
  } else {
    for (const s of steps) {
      console.log(
        `${s.fromBucket} -> ${s.toBucket}: ${s.amountUi.toLocaleString()} AURA`,
      );
    }
  }

  const unmet = positions.filter(
    (p) => p.bucket !== "payer" && p.deltaUi > 0.5,
  );
  // recompute unmet after plan
  const funded = new Map<string, number>();
  for (const s of steps) {
    funded.set(s.toBucket, (funded.get(s.toBucket) ?? 0) + s.amountUi);
  }
  for (const p of unmet) {
    const got = funded.get(p.bucket) ?? 0;
    const still = p.deltaUi - got;
    if (still > 0.5) {
      console.warn(
        `WARN: ${p.bucket} still short ~${still.toLocaleString()} AURA after plan`,
      );
    }
  }

  const outPath = resolve(ROOT, "assets/rebalance-plan.json");
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        cluster,
        live: false,
        positions: positions.map(({ keypair: _k, keyPath: _p, ...rest }) => rest),
        steps,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`\nwrote ${outPath}`);

  if (!live) {
    console.log("\nDry-run only. Re-run with --live and CONFIRM_MAINNET=I_UNDERSTAND to send.");
    return;
  }

  const byWallet = new Map(positions.map((p) => [p.wallet, p]));
  const payerPos = positions.find((p) => p.bucket === "payer");
  if (!payerPos?.keypair) {
    throw new Error("KEYPAIR_PATH payer required for live fee payer / SOL top-ups");
  }

  // Top up SOL on signing sources + vesting sinks so Streamflow txs can pay fees later
  const needSol = positions.filter(
    (p) =>
      p.canSign &&
      p.bucket !== "payer" &&
      (cfg.vesting.buckets.includes(p.bucket) || p.bucket === "liquidity"),
  );
  console.log("\n=== SOL top-ups ===");
  for (const p of needSol) {
    const sig = await fundSolIfNeeded(payerPos.keypair, new PublicKey(p.wallet));
    console.log(
      sig
        ? `${p.bucket}: topped up SOL  ${sig}`
        : `${p.bucket}: SOL already >= ${fundSolUi}`,
    );
  }

  console.log("\n=== executing AURA transfers ===");
  const results: Array<TransferStep & { signature: string }> = [];
  for (const step of steps) {
    const src = byWallet.get(step.from);
    if (!src?.keypair) {
      throw new Error(`cannot sign for source ${step.fromBucket} (${step.from})`);
    }
    const sig = await executeTransfer(
      src.keypair,
      new PublicKey(step.to),
      step.amountUi,
    );
    console.log(
      `${step.fromBucket} -> ${step.toBucket}: ${step.amountUi.toLocaleString()} AURA  ${sig}`,
    );
    results.push({ ...step, signature: sig });
  }

  writeFileSync(
    outPath,
    JSON.stringify(
      {
        cluster,
        live: true,
        positions: positions.map(({ keypair: _k, keyPath: _p, ...rest }) => rest),
        steps: results,
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

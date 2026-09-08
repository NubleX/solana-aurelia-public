/**
 * Create a Meteora DAMM v2 AURA/SOL customizable pool from the liquidity wallet.
 *
 * Default seed (tokenomics): 8% of circulating (200M) = 16M AURA + 0.17 SOL.
 * Requires keys/liquidity.json = EnGUbfDakK3gzMkA9QYow4duieusnFcHEYipKGthKS4P
 *
 * Usage:
 *   CLUSTER=mainnet-beta RPC_URL=... tsx src/token/createMeteoraPool.ts
 *   ... --live
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import BN from "bn.js";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  ActivationType,
  BaseFeeMode,
  CollectFeeMode,
  CpAmm,
  getBaseFeeParams,
  getDynamicFeeParams,
  MAX_SQRT_PRICE,
  MIN_SQRT_PRICE,
  type PoolFeesParams,
} from "@meteora-ag/cp-amm-sdk";
import { getCluster, getConnection, loadKeypair } from "../lib/connection.js";

const ROOT = resolve(import.meta.dirname, "../..");
const AURA_MINT = "AoPZi6gXYKArxUdAk5aGtYsq4XjRGpotq5xVkvkZr3dK";
const EXPECTED_LIQUIDITY = "EnGUbfDakK3gzMkA9QYow4duieusnFcHEYipKGthKS4P";

/** 16_000_000 AURA with 9 decimals */
const AURA_UI = 16_000_000;
const AURA_RAW = new BN("16000000000000000");
/** 0.17 SOL in lamports - leaves ~0.03 SOL for create rent + fees */
const SOL_LAMPORTS = new BN(170_000_000);

const isLive = process.argv.includes("--live");

const main = async (): Promise<void> => {
  const cluster = getCluster();
  if (cluster !== "mainnet-beta") {
    throw new Error(`Refusing pool create on cluster=${cluster}; set CLUSTER=mainnet-beta`);
  }

  const connection = getConnection();
  const wallet = loadKeypair(
    process.env.LIQUIDITY_KEYPAIR_PATH ?? resolve(ROOT, "keys/liquidity.json"),
  );
  if (wallet.publicKey.toBase58() !== EXPECTED_LIQUIDITY) {
    throw new Error(
      `liquidity keypair is ${wallet.publicKey.toBase58()}, expected ${EXPECTED_LIQUIDITY}`,
    );
  }

  const solBal = await connection.getBalance(wallet.publicKey);
  if (solBal < SOL_LAMPORTS.toNumber() + 25_000_000) {
    throw new Error(
      `Need >= ${(SOL_LAMPORTS.toNumber() + 25_000_000) / 1e9} SOL (seed + rent buffer); have ${solBal / 1e9}`,
    );
  }

  const auraMint = new PublicKey(AURA_MINT);

  // tokenA = AURA, tokenB = WSOL (SDK wraps native SOL when tokenB is NATIVE_MINT)
  const tokenAAmount = AURA_RAW;
  const tokenBAmount = SOL_LAMPORTS;

  const cpAmm = new CpAmm(connection);
  const collectFeeMode = CollectFeeMode.BothToken;

  const { initSqrtPrice, liquidityDelta } = cpAmm.preparePoolCreationParams({
    tokenAAmount,
    tokenBAmount,
    minSqrtPrice: MIN_SQRT_PRICE,
    maxSqrtPrice: MAX_SQRT_PRICE,
    collectFeeMode,
  });

  const baseFee = getBaseFeeParams({
    baseFeeMode: BaseFeeMode.FeeTimeSchedulerLinear,
    feeTimeSchedulerParam: {
      startingFeeBps: 25,
      endingFeeBps: 25,
      numberOfPeriod: 0,
      totalDuration: 0,
    },
  });

  const poolFees: PoolFeesParams = {
    baseFee,
    compoundingFeeBps: 0,
    padding: 0,
    dynamicFee: getDynamicFeeParams(25),
  };

  const positionNft = Keypair.generate();

  const { tx, pool, position } = await cpAmm.createCustomPool({
    payer: wallet.publicKey,
    creator: wallet.publicKey,
    positionNft: positionNft.publicKey,
    tokenAMint: auraMint,
    tokenBMint: NATIVE_MINT,
    tokenAAmount,
    tokenBAmount,
    sqrtMinPrice: MIN_SQRT_PRICE,
    sqrtMaxPrice: MAX_SQRT_PRICE,
    initSqrtPrice,
    liquidityDelta,
    poolFees,
    hasAlphaVault: false,
    collectFeeMode,
    activationPoint: null,
    activationType: ActivationType.Timestamp,
    tokenAProgram: TOKEN_PROGRAM_ID,
    tokenBProgram: TOKEN_PROGRAM_ID,
    isLockLiquidity: true,
  });

  tx.feePayer = wallet.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
  tx.instructions.unshift(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
  );

  const priceSolPerAura = SOL_LAMPORTS.toNumber() / 1e9 / AURA_UI;
  const preview = {
    cluster,
    live: isLive,
    pool: pool.toBase58(),
    position: position.toBase58(),
    positionNft: positionNft.publicKey.toBase58(),
    tokenA: { mint: auraMint.toBase58(), symbol: "AURA", ui: AURA_UI },
    tokenB: { mint: NATIVE_MINT.toBase58(), symbol: "SOL", ui: SOL_LAMPORTS.toNumber() / 1e9 },
    initSqrtPrice: initSqrtPrice.toString(),
    liquidityDelta: liquidityDelta.toString(),
    priceSolPerAura,
    impliedFdvSol: priceSolPerAura * 1_000_000_000,
    feeBps: 25,
    locked: true,
    app: `https://app.meteora.ag/pools/${pool.toBase58()}`,
    explorerPool: `https://explorer.solana.com/address/${pool.toBase58()}`,
  };

  console.log(JSON.stringify(preview, null, 2));

  if (!isLive) {
    console.log("\nDry-run only. Pass --live to submit.");
    return;
  }

  const signature = await sendAndConfirmTransaction(
    connection,
    tx,
    [wallet, positionNft],
    { commitment: "confirmed", skipPreflight: false },
  );

  const result = {
    ...preview,
    signature,
    explorerTx: `https://explorer.solana.com/tx/${signature}`,
    createdAt: new Date().toISOString(),
  };

  const outPath = resolve(ROOT, "assets/meteora-pool.json");
  writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log("\nPool created.");
  console.log("signature", signature);
  console.log("wrote", outPath);
};

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});

/**
 * Initialize the immutable AURA splitter PDA + vault ATA.
 *
 * Dry-run by default. Live requires deployed program id + CONFIRM_MAINNET.
 * KEYPAIR_PATH must point at Phantom-style `{ "privateKey": "<base58>" }` (or CLI array).
 *
 *   SPLITTER_PROGRAM_ID=... KEYPAIR_PATH=./keys/payer.json npm run vest:splitter:init
 *   SPLITTER_PROGRAM_ID=... KEYPAIR_PATH=./keys/payer.json CONFIRM_MAINNET=I_UNDERSTAND npm run vest:splitter:init:live
 */
import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  getCluster,
  getConnection,
  loadEnv,
  loadKeypair,
} from "../lib/connection.js";
import { MINT, ROOT } from "./shared.js";
import {
  DEFAULT_LOCKED_SHARES,
  buildInitializeIx,
  findConfigPda,
  vaultAta,
  decodeConfig,
  loadProgramId,
} from "./splitter.js";

loadEnv();

const isLive = (): boolean =>
  process.argv.includes("--live") || process.env.LIVE === "1";

const main = async (): Promise<void> => {
  const live = isLive();
  const cluster = getCluster();
  const programId = loadProgramId();
  const payer = loadKeypair();
  const connection = getConnection();

  console.log(`cluster:   ${cluster}`);
  console.log(`mode:      ${live ? "LIVE" : "dry-run"}`);
  console.log(`program:   ${programId.toBase58()}`);
  console.log(`payer:     ${payer.publicKey.toBase58()}`);

  if (live && cluster === "mainnet-beta" && process.env.CONFIRM_MAINNET !== "I_UNDERSTAND") {
    throw new Error("Refusing mainnet live init without CONFIRM_MAINNET=I_UNDERSTAND");
  }

  const recipients = DEFAULT_LOCKED_SHARES.map((r) => new PublicKey(r.wallet));
  const shares = DEFAULT_LOCKED_SHARES.map((r) => r.share);
  const [configPda, bump] = findConfigPda(MINT, programId);
  const vault = vaultAta(MINT, configPda);

  console.log(`configPda: ${configPda.toBase58()} (bump ${bump})`);
  console.log(`vaultAta:  ${vault.toBase58()}`);
  console.log("recipients:");
  for (const r of DEFAULT_LOCKED_SHARES) {
    console.log(`  ${r.bucket.padEnd(12)} share=${r.share}  ${r.wallet}`);
  }

  const existing = await connection.getAccountInfo(configPda);
  if (existing) {
    const cfg = decodeConfig(Buffer.from(existing.data));
    console.log("\nconfig already on-chain:");
    console.log(`  mint=${cfg.mint.toBase58()} count=${cfg.recipientCount} total=${cfg.shareTotal}`);
    writeFileSync(
      resolve(ROOT, "assets/splitter-state.json"),
      JSON.stringify(
        {
          programId: programId.toBase58(),
          configPda: configPda.toBase58(),
          vaultAta: vault.toBase58(),
          mint: MINT.toBase58(),
          recipients: DEFAULT_LOCKED_SHARES,
          existing: true,
        },
        null,
        2,
      ) + "\n",
    );
    return;
  }

  // Ensure destination ATAs exist so first split never fails on missing accounts
  const ataIxs = recipients.map((owner) => {
    const ata = getAssociatedTokenAddressSync(MINT, owner);
    return createAssociatedTokenAccountIdempotentInstruction(
      payer.publicKey,
      ata,
      owner,
      MINT,
    );
  });

  const initIx = buildInitializeIx({
    programId,
    payer: payer.publicKey,
    mint: MINT,
    recipients,
    shares,
  });

  // Fund PDA with a little SOL so Streamflow auto-withdraw tips / rent quirks are covered
  const fundPdaIx = SystemProgram.transfer({
    fromPubkey: payer.publicKey,
    toPubkey: configPda,
    lamports: Math.floor(0.002 * LAMPORTS_PER_SOL),
  });

  const out = {
    programId: programId.toBase58(),
    configPda: configPda.toBase58(),
    vaultAta: vault.toBase58(),
    mint: MINT.toBase58(),
    recipients: DEFAULT_LOCKED_SHARES,
    existing: false,
  };
  writeFileSync(resolve(ROOT, "assets/splitter-state.json"), JSON.stringify(out, null, 2) + "\n");
  console.log("\nwrote assets/splitter-state.json");

  if (!live) {
    console.log("Dry-run only. Re-run with --live after program deploy.");
    return;
  }

  const tx = new Transaction().add(...ataIxs, initIx, fundPdaIx);
  const sig = await sendAndConfirmTransaction(connection, tx, [payer], {
    commitment: "confirmed",
  });
  console.log(`initialized: ${sig}`);

  const deployPath = resolve(ROOT, "assets/splitter-deploy.json");
  const prev = existsSync(deployPath)
    ? (JSON.parse(readFileSync(deployPath, "utf8")) as Record<string, unknown>)
    : {};
  writeFileSync(
    deployPath,
    JSON.stringify({ ...prev, ...out, initSignature: sig }, null, 2) + "\n",
  );
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

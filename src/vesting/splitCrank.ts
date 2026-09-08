/**
 * Permissionless crank: split whatever AURA sits in the splitter vault ATA
 * into the immutable share recipients.
 *
 * Fee payer key must be Phantom-style JSON, not a Solana CLI byte array:
 *   keys/payer.json -> { "privateKey": "<base58 64-byte secret>" }
 * `loadKeypair()` already accepts that shape (also secretKey / raw base58 / CLI array).
 *
 *   SPLITTER_PROGRAM_ID=... KEYPAIR_PATH=./keys/payer.json npm run vest:splitter:split
 *   SPLITTER_PROGRAM_ID=... KEYPAIR_PATH=./keys/payer.json CONFIRM_MAINNET=I_UNDERSTAND npm run vest:splitter:split:live
 */
import {
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  getCluster,
  getConnection,
  loadEnv,
  loadKeypair,
} from "../lib/connection.js";
import { MINT } from "./shared.js";
import {
  DEFAULT_LOCKED_SHARES,
  buildSplitIx,
  findConfigPda,
  vaultAta,
  loadProgramId,
  previewSplit,
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

  const [configPda] = findConfigPda(MINT, programId);
  const vault = vaultAta(MINT, configPda);

  console.log(`cluster: ${cluster}`);
  console.log(`mode:    ${live ? "LIVE" : "dry-run"}`);
  console.log(`vault:   ${vault.toBase58()}`);

  let balance = 0n;
  try {
    balance = (await getAccount(connection, vault)).amount;
  } catch {
    console.log("vault ATA missing or empty");
  }
  console.log(`balance: ${Number(balance) / 1e9} AURA`);

  const shares = DEFAULT_LOCKED_SHARES.map((r) => r.share);
  const parts = previewSplit(balance, shares);
  console.log("preview:");
  DEFAULT_LOCKED_SHARES.forEach((r, i) => {
    console.log(`  ${r.bucket.padEnd(12)} ${Number(parts[i]!) / 1e9} AURA`);
  });

  if (!live) {
    console.log("\nDry-run only.");
    return;
  }
  if (live && cluster === "mainnet-beta" && process.env.CONFIRM_MAINNET !== "I_UNDERSTAND") {
    throw new Error("Refusing mainnet live split without CONFIRM_MAINNET=I_UNDERSTAND");
  }
  if (balance === 0n) {
    console.log("nothing to split");
    return;
  }

  const recipientAtas = DEFAULT_LOCKED_SHARES.map((r) =>
    getAssociatedTokenAddressSync(MINT, new PublicKey(r.wallet)),
  );
  const ataIxs = DEFAULT_LOCKED_SHARES.map((r, i) =>
    createAssociatedTokenAccountIdempotentInstruction(
      payer.publicKey,
      recipientAtas[i]!,
      new PublicKey(r.wallet),
      MINT,
    ),
  );
  const splitIx = buildSplitIx({ programId, mint: MINT, recipientAtas });
  const tx = new Transaction().add(...ataIxs, splitIx);
  const sig = await sendAndConfirmTransaction(connection, tx, [payer], {
    commitment: "confirmed",
  });
  console.log(`split ok: ${sig}`);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

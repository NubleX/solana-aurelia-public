import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
  getAccount,
} from "@solana/spl-token";
import { getCluster, getConnection, loadKeypair } from "../lib/connection.js";

type Recipient = {
  address: string;
  amount: number;
};

type AirdropList = {
  mint: string;
  decimals: number;
  recipients: Recipient[];
};

const ROOT = resolve(import.meta.dirname, "../..");

const loadList = (path: string): AirdropList => {
  if (!existsSync(path)) {
    throw new Error(`airdrop list not found: ${path}`);
  }
  return JSON.parse(readFileSync(path, "utf-8")) as AirdropList;
};

const toRaw = (ui: number, decimals: number): bigint => {
  const factor = 10n ** BigInt(decimals);
  return BigInt(ui) * factor;
};

/**
 * Bulk-transfer airdrop from the payer's ATA for `mint` to each recipient.
 *
 * Upgrade path: for large lists (thousands+), replace this with a Merkle distributor
 * (e.g. Jupiter Merkle Distributor / Streamflow Airdrops) so recipients claim themselves
 * and you do not pay one tx fee per recipient.
 */
const main = async (): Promise<void> => {
  const listPath = process.env.AIRDROP_LIST ?? resolve(ROOT, "config/airdrop-recipients.sample.json");
  const live = process.argv.includes("--live") || process.env.LIVE === "1";
  const dryRun = !live;

  const list = loadList(listPath);
  const totalUi = list.recipients.reduce((s, r) => s + r.amount, 0);

  console.log(`cluster:    ${getCluster()}`);
  console.log(`mode:       ${dryRun ? "dry-run (no transactions)" : "LIVE"}`);
  console.log(`list:       ${listPath}`);
  console.log(`mint:       ${list.mint}`);
  console.log(`recipients: ${list.recipients.length} total=${totalUi}`);

  if (dryRun) {
    for (const r of list.recipients) {
      console.log(`[dry-run] ${r.amount} -> ${r.address}`);
    }
    console.log("dry-run complete (no transactions sent)");
    console.log("When you want a real drop: npm run airdrop:live");
    return;
  }

  const payer = loadKeypair();
  const connection = getConnection();
  const mint = new PublicKey(list.mint);

  const sourceAta = getAssociatedTokenAddressSync(mint, payer.publicKey);
  let sourceBalance = 0n;
  try {
    sourceBalance = (await getAccount(connection, sourceAta)).amount;
  } catch {
    throw new Error(`payer has no ATA for mint ${list.mint}. Fund the community wallet first.`);
  }

  const totalRaw = toRaw(totalUi, list.decimals);
  console.log(`payer:      ${payer.publicKey.toBase58()}`);
  console.log(`sourceATA:  ${sourceAta.toBase58()} balance=${sourceBalance}`);

  if (sourceBalance < totalRaw) {
    throw new Error(`insufficient balance: need ${totalRaw}, have ${sourceBalance}`);
  }

  for (const r of list.recipients) {
    const dest = new PublicKey(r.address);
    const destAta = getAssociatedTokenAddressSync(mint, dest);
    const raw = toRaw(r.amount, list.decimals);
    const tx = new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(
        payer.publicKey,
        destAta,
        dest,
        mint,
      ),
      createTransferInstruction(sourceAta, destAta, payer.publicKey, raw),
    );
    const sig = await sendAndConfirmTransaction(connection, tx, [payer]);
    console.log(`sent ${r.amount} -> ${r.address} sig=${sig}`);
  }

  console.log("airdrop complete");
};

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PublicKey } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  getAccount,
} from "@solana/spl-token";
import { getConnection, loadKeypair } from "../lib/connection.js";

export const ROOT = resolve(import.meta.dirname, "../..");
export const MINT = new PublicKey("AoPZi6gXYKArxUdAk5aGtYsq4XjRGpotq5xVkvkZr3dK");
export const DECIMALS = 9;
export const MONTH_SECS = 30 * 24 * 60 * 60;

export type Allocation = {
  bucket: string;
  label: string;
  percent: number;
  amount: number;
  wallet: string;
  release?: {
    style?: string;
    provider?: string;
    custody?: string;
    durationMonths?: number;
    amountPerMonth?: number;
    lastMonthAmount?: number;
    cliffMonths?: number;
    of?: string;
    restOfBucket?: number;
    tgeAmount?: number;
    restDurationMonths?: number;
    gatherAmount?: number;
    streamflowFeeAmount?: number;
    note?: string;
  };
};

export type Tokenomics = {
  decimals: number;
  totalSupply: number;
  vesting: {
    buckets: string[];
    durationMonths: number;
    cliffMonths: number;
    cliffAmount: number;
    cancelableBySender: boolean;
    canTopup: boolean;
    lockedAmount: number;
    streamAmount?: number;
    streamflowFeeAmount?: number;
    streamflowFeeFrom?: string;
  };
  allocations: Allocation[];
};

export const loadTokenomics = (): Tokenomics => {
  const path = resolve(ROOT, "config/tokenomics.json");
  return JSON.parse(readFileSync(path, "utf-8")) as Tokenomics;
};

export const toRaw = (ui: number): bigint => {
  const factor = 10n ** BigInt(DECIMALS);
  return BigInt(Math.trunc(ui)) * factor;
};

export const fromRaw = (raw: bigint): number => Number(raw) / 10 ** DECIMALS;

/** Candidate key files for a bucket (first matching pubkey wins). */
export const keyCandidates = (bucket: string): string[] => [
  resolve(ROOT, `keys/mainnet-${bucket}.json`),
  resolve(ROOT, `keys/${bucket}.json`),
  resolve(ROOT, `keys/alloc-${bucket}.json`),
];

export const tryLoadBucketKey = (
  bucket: string,
  expectedPubkey: string,
): { path: string; keypair: ReturnType<typeof loadKeypair> } | null => {
  for (const path of keyCandidates(bucket)) {
    if (!existsSync(path)) continue;
    try {
      const keypair = loadKeypair(path);
      if (keypair.publicKey.toBase58() === expectedPubkey) {
        return { path, keypair };
      }
    } catch {
      // skip unreadable / wrong format
    }
  }
  return null;
};

export const getAuraBalance = async (owner: PublicKey): Promise<bigint> => {
  const connection = getConnection();
  const ata = getAssociatedTokenAddressSync(MINT, owner);
  try {
    const account = await getAccount(connection, ata);
    return account.amount;
  } catch {
    return 0n;
  }
};

export const vestingBuckets = (cfg: Tokenomics): Allocation[] =>
  cfg.allocations.filter((a) => cfg.vesting.buckets.includes(a.bucket));

export const targetUiForBucket = (alloc: Allocation): number => {
  if (alloc.bucket === "liquidity") {
    return alloc.release?.restOfBucket ?? alloc.amount;
  }
  // Pre-stream gather may need full wallet contribution (e.g. seasons 100M
  // before Streamflow fee); vest `amount` can be post-fee.
  return alloc.release?.gatherAmount ?? alloc.amount;
};

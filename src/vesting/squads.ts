/**
 * Squads v4 helpers for the one-stream lock path.
 *
 * Fee rule: sender pays Streamflow 0.19% on top of vest amount V.
 * Total leaving locked wallets = 800M = V + F, with F taken from seasons
 * (not circulating / liquidity float).
 *
 *   V = 798_482_883, F = floor(V * 19 / 10000) = 1_517_117
 *   seasons vest = 100_000_000 - F = 98_482_883
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Keypair, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { ROOT, MINT, loadTokenomics } from "./shared.js";
import { tryLoadBucketKey } from "./shared.js";
import { loadKeypair } from "../lib/connection.js";

export const SQUADS_PATH = resolve(ROOT, "assets/squads.json");
export const VAULT_INDEX = 0;
export const THRESHOLD = 2;

/** Total AURA gathered from the five locked buckets for stream create. */
export const LOCKED_GATHER_UI = 800_000_000;
export const LOCKED_GATHER_RAW = BigInt(LOCKED_GATHER_UI) * 1_000_000_000n;

/**
 * Streamflow token fee = 0.19% of deposited vest amount, charged on top.
 * Exact smallest-unit solution: V_raw + floor(V_raw * 19 / 10000) = 800M * 1e9.
 * UI figures match the plan (~798.482883M streamed, ~1.517117M fee from seasons).
 */
export const STREAM_AMOUNT_RAW = 798_482_882_523_205_909n;
export const STREAMFLOW_FEE_RAW = 1_517_117_476_794_091n; // floor(STREAM_AMOUNT_RAW * 19 / 10000)
export const STREAM_AMOUNT_UI = 798_482_883; // rounded for docs / getBN display
export const STREAMFLOW_FEE_UI = 1_517_117; // rounded
export const SEASONS_VEST_UI = 100_000_000 - STREAMFLOW_FEE_UI; // 98_482_883

export type LockedShare = {
  bucket: string;
  wallet: string;
  /** Post-fee vest weight (UI AURA). Sum = STREAM_AMOUNT_UI. */
  vestUi: number;
  /** Amount this wallet contributes to the 800M gather (UI AURA). */
  gatherUi: number;
};

/** Post-fee vest slices used for monthly Squads vault splits. */
export const POST_FEE_LOCKED_SHARES: LockedShare[] = [
  {
    bucket: "community",
    wallet: "AveLbGScDVyah9VpdjRJBXGYhm42xjYidzD7PbgeEUju",
    vestUi: 250_000_000,
    gatherUi: 250_000_000,
  },
  {
    bucket: "treasury",
    wallet: "HGf7V82B51i1eUybqLCC27fB1oYYHFoD8H28s6mcgJmY",
    vestUi: 200_000_000,
    gatherUi: 200_000_000,
  },
  {
    bucket: "ecosystem",
    wallet: "AZbx1ndAwPuP21WBwWfLSiM6MevKfjZaa7fUHnReUJWJ",
    vestUi: 150_000_000,
    gatherUi: 150_000_000,
  },
  {
    bucket: "seasons",
    wallet: "6n2V89NjCYNjnyxk9V8xiYGsuMX4pzwNTD23Uwa41LSQ",
    vestUi: SEASONS_VEST_UI,
    gatherUi: 100_000_000,
  },
  {
    bucket: "team",
    wallet: "EjyrpYnwWX1baKTsnS7B55eGKGJzon8didBQ2ibVxF4C",
    vestUi: 100_000_000,
    gatherUi: 100_000_000,
  },
];

export const assertFeeMath = (): void => {
  const fee = (STREAM_AMOUNT_RAW * 19n) / 10000n;
  if (fee !== STREAMFLOW_FEE_RAW) {
    throw new Error(`fee mismatch: floor(V_raw*19/10000)=${fee} expected ${STREAMFLOW_FEE_RAW}`);
  }
  if (STREAM_AMOUNT_RAW + STREAMFLOW_FEE_RAW !== LOCKED_GATHER_RAW) {
    throw new Error("V_raw + F_raw must equal 800M raw gather");
  }
  if (STREAM_AMOUNT_UI + STREAMFLOW_FEE_UI !== LOCKED_GATHER_UI) {
    throw new Error("rounded V + F must equal 800M UI gather");
  }
  const vestSum = POST_FEE_LOCKED_SHARES.reduce((a, s) => a + s.vestUi, 0);
  if (vestSum !== STREAM_AMOUNT_UI) {
    throw new Error(`vest shares sum ${vestSum} != STREAM_AMOUNT_UI`);
  }
  const gatherSum = POST_FEE_LOCKED_SHARES.reduce((a, s) => a + s.gatherUi, 0);
  if (gatherSum !== LOCKED_GATHER_UI) {
    throw new Error(`gather shares sum ${gatherSum} != LOCKED_GATHER_UI`);
  }
};

export type SquadsState = {
  cluster: string;
  multisigPda: string;
  vaultPda: string;
  vaultIndex: number;
  createKey: string;
  threshold: number;
  configAuthority: null;
  members: Array<{ role: string; pubkey: string }>;
  createTx?: string;
  vaultAta?: string;
  dryRun?: boolean;
};

export const defaultMembers = (): Array<{ role: string; pubkey: string }> => {
  const cfg = loadTokenomics();
  const payer = loadKeypair();
  const team = cfg.allocations.find((a) => a.bucket === "team");
  const treasury = cfg.allocations.find((a) => a.bucket === "treasury");
  if (!team || !treasury) throw new Error("tokenomics missing team/treasury");
  return [
    { role: "payer", pubkey: payer.publicKey.toBase58() },
    { role: "team", pubkey: team.wallet },
    { role: "treasury", pubkey: treasury.wallet },
  ];
};

export const loadSquadsState = (): SquadsState => {
  if (!existsSync(SQUADS_PATH)) {
    throw new Error(
      `missing ${SQUADS_PATH} - run npm run vest:squads:create first`,
    );
  }
  return JSON.parse(readFileSync(SQUADS_PATH, "utf8")) as SquadsState;
};

export const saveSquadsState = (state: SquadsState): void => {
  writeFileSync(SQUADS_PATH, JSON.stringify(state, null, 2) + "\n");
};

export const vaultAtaFor = (vaultPda: PublicKey): PublicKey =>
  getAssociatedTokenAddressSync(MINT, vaultPda, true);

/** Proportional split; last bucket takes dust remainder. */
export const previewPostFeeSplit = (balanceRaw: bigint): bigint[] => {
  const weights = POST_FEE_LOCKED_SHARES.map((s) => s.vestUi);
  const total = weights.reduce((a, b) => a + b, 0);
  const out: bigint[] = [];
  let distributed = 0n;
  for (let i = 0; i < weights.length; i++) {
    if (i === weights.length - 1) {
      out.push(balanceRaw - distributed);
    } else {
      const part = (balanceRaw * BigInt(weights[i]!)) / BigInt(total);
      out.push(part);
      distributed += part;
    }
  }
  return out;
};

export const loadMemberSigner = (
  role: string,
  pubkey: string,
): Keypair | null => {
  if (role === "payer") {
    try {
      const kp = loadKeypair();
      if (kp.publicKey.toBase58() === pubkey) return kp;
    } catch {
      return null;
    }
    return null;
  }
  const loaded = tryLoadBucketKey(role, pubkey);
  return loaded?.keypair ?? null;
};

/**
 * Immutable AURA splitter helpers (UNUSED on mainnet - prefer Squads v4).
 *
 * Do not deploy `programs/aura-splitter`. Production path:
 * one Streamflow stream -> Squads vault -> monthly `vest:squads:split`.
 *
 * Post-fee locked shares (Streamflow 0.19% fee taken from seasons):
 *   community 250M, treasury 200M, ecosystem 150M, seasons ~98.482883M, team 100M
 * Legacy share integers below remain for the unused on-chain program (sum 800).
 */
import { Buffer } from "node:buffer";
import {
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { POST_FEE_LOCKED_SHARES } from "./squads.js";

export const CONFIG_SEED = Buffer.from("aura_splitter");
export const MAX_RECIPIENTS = 5;

export type SplitterRecipient = {
  bucket: string;
  wallet: string;
  share: number;
};

/** @deprecated Prefer POST_FEE_LOCKED_SHARES from ./squads.js for vault splits. */
export const DEFAULT_LOCKED_SHARES: SplitterRecipient[] = POST_FEE_LOCKED_SHARES.map(
  (s) => ({
    bucket: s.bucket,
    wallet: s.wallet,
    // On-chain u64 shares: use vest UI amounts (sum = STREAM_AMOUNT_UI).
    share: s.vestUi,
  }),
);

export const loadProgramId = (): PublicKey => {
  const fromEnv = process.env.SPLITTER_PROGRAM_ID;
  if (fromEnv && fromEnv.length > 0) return new PublicKey(fromEnv);
  throw new Error(
    "SPLITTER_PROGRAM_ID is not set. Deploy the program and export the id (see assets/splitter-deploy.json).",
  );
};

/** Borsh: enum Initialize = 0, then [Pubkey;5] + [u64;5] */
export const encodeInitialize = (
  recipients: PublicKey[],
  shares: number[],
): Buffer => {
  const data = Buffer.alloc(1 + MAX_RECIPIENTS * 32 + MAX_RECIPIENTS * 8);
  data[0] = 0; // Initialize
  for (let i = 0; i < MAX_RECIPIENTS; i++) {
    const pk = i < recipients.length ? recipients[i]! : PublicKey.default;
    pk.toBytes().forEach((b, j) => {
      data[1 + i * 32 + j] = b;
    });
  }
  for (let i = 0; i < MAX_RECIPIENTS; i++) {
    const share = BigInt(i < shares.length ? shares[i]! : 0);
    data.writeBigUInt64LE(share, 1 + MAX_RECIPIENTS * 32 + i * 8);
  }
  return data;
};

export const encodeSplit = (): Buffer => Buffer.from([1]);

export const findConfigPda = (
  mint: PublicKey,
  programId: PublicKey,
): [PublicKey, number] =>
  PublicKey.findProgramAddressSync([CONFIG_SEED, mint.toBytes()], programId);

export const vaultAta = (mint: PublicKey, configPda: PublicKey): PublicKey =>
  getAssociatedTokenAddressSync(mint, configPda, true);

export const buildInitializeIx = (args: {
  programId: PublicKey;
  payer: PublicKey;
  mint: PublicKey;
  recipients: PublicKey[];
  shares: number[];
}): TransactionInstruction => {
  const [configPda] = findConfigPda(args.mint, args.programId);
  const vault = vaultAta(args.mint, configPda);
  return new TransactionInstruction({
    programId: args.programId,
    keys: [
      { pubkey: args.payer, isSigner: true, isWritable: true },
      { pubkey: configPda, isSigner: false, isWritable: true },
      { pubkey: args.mint, isSigner: false, isWritable: false },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    data: encodeInitialize(args.recipients, args.shares),
  });
};

export const buildSplitIx = (args: {
  programId: PublicKey;
  mint: PublicKey;
  recipientAtas: PublicKey[];
}): TransactionInstruction => {
  const [configPda] = findConfigPda(args.mint, args.programId);
  const vault = vaultAta(args.mint, configPda);
  return new TransactionInstruction({
    programId: args.programId,
    keys: [
      { pubkey: configPda, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ...args.recipientAtas.map((ata) => ({
        pubkey: ata,
        isSigner: false,
        isWritable: true,
      })),
    ],
    data: encodeSplit(),
  });
};

export type OnChainConfig = {
  mint: PublicKey;
  bump: number;
  recipientCount: number;
  recipients: PublicKey[];
  shares: bigint[];
  shareTotal: bigint;
};

export const decodeConfig = (data: Buffer): OnChainConfig => {
  let o = 0;
  const mint = new PublicKey(data.subarray(o, o + 32));
  o += 32;
  const bump = data[o]!;
  o += 1;
  const recipientCount = data[o]!;
  o += 1;
  const recipients: PublicKey[] = [];
  for (let i = 0; i < MAX_RECIPIENTS; i++) {
    recipients.push(new PublicKey(data.subarray(o, o + 32)));
    o += 32;
  }
  const shares: bigint[] = [];
  for (let i = 0; i < MAX_RECIPIENTS; i++) {
    shares.push(data.readBigUInt64LE(o));
    o += 8;
  }
  const shareTotal = data.readBigUInt64LE(o);
  return { mint, bump, recipientCount, recipients, shares, shareTotal };
};

/** Local pure split preview (mirrors on-chain dust rule). */
export const previewSplit = (balance: bigint, shares: number[]): bigint[] => {
  const total = shares.reduce((a, b) => a + b, 0);
  const out: bigint[] = [];
  let distributed = 0n;
  for (let i = 0; i < shares.length; i++) {
    if (i === shares.length - 1) {
      out.push(balance - distributed);
    } else {
      const part = (balance * BigInt(shares[i]!)) / BigInt(total);
      out.push(part);
      distributed += part;
    }
  }
  return out;
};

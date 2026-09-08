import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Connection, Keypair, clusterApiUrl } from "@solana/web3.js";
import bs58 from "bs58";
import { keypairIdentity, type Umi } from "@metaplex-foundation/umi";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { fromWeb3JsKeypair } from "@metaplex-foundation/umi-web3js-adapters";
import { mplTokenMetadata } from "@metaplex-foundation/mpl-token-metadata";

/** Load .env from project root into process.env (does not override existing). */
export const loadEnv = (envPath = resolve(process.cwd(), ".env")): void => {
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    // Do not override values explicitly set in the shell (e.g. `CLUSTER=devnet npm run ...`).
    if (process.env[key] === undefined) process.env[key] = value;
  }
};

loadEnv();

export type Cluster = "devnet" | "mainnet-beta";

export const getCluster = (): Cluster =>
  (process.env.CLUSTER as Cluster | undefined) ?? "devnet";

export const getRpcUrl = (): string =>
  process.env.RPC_URL && process.env.RPC_URL.length > 0
    ? process.env.RPC_URL
    : clusterApiUrl(getCluster());

/** Public project wallet from .env (no private key). */
export const getWalletPubkey = (): string | undefined => {
  const pk = process.env.WALLET_PUBKEY;
  return pk && pk.length > 0 ? pk : undefined;
};

/**
 * Load a keypair from disk. Accepts three formats:
 *  1. Solana CLI byte array: `[12, 34, ...]` (64 numbers).
 *  2. Phantom / bs58 secret string: `"5J8..."` (base58, decodes to 64 bytes).
 *  3. Wrapping object with `secretKey` / `privateKey` in either form above.
 *
 * Project keys under `keys/` are typically form (3): `{ "privateKey": "<base58>" }`,
 * not Solana CLI arrays. Do not assume `JSON.parse` yields a number[].
 */
export const loadKeypair = (path = process.env.KEYPAIR_PATH): Keypair => {
  if (!path) throw new Error("KEYPAIR_PATH is not set (see .env.example)");
  const raw = readFileSync(path, "utf-8").trim();

  const decode = (input: unknown): Uint8Array => {
    if (Array.isArray(input)) return Uint8Array.from(input as number[]);
    if (typeof input === "string") {
      let s = input.trim().replace(/\s+/g, "");
      // Common paste mistake: a leading ASCII '0' before an otherwise-valid base58 secret.
      if (s.startsWith("0") && /^0[1-9A-HJ-NP-Za-km-z]+$/.test(s)) {
        s = s.slice(1);
      }
      const looksBase58 = /^[1-9A-HJ-NP-Za-km-z]+$/.test(s);
      if (looksBase58) return bs58.decode(s);
    }
    throw new Error("unrecognized key material");
  };

  let bytes: Uint8Array;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed) || typeof parsed === "string") {
      bytes = decode(parsed);
    } else if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      const candidate = obj.secretKey ?? obj.privateKey ?? obj.secret ?? obj.key;
      if (candidate === undefined) {
        throw new Error(
          `${path} is a JSON object with no secretKey/privateKey field. ` +
            "Export as JSON byte array (solana-keygen) or a base58 string.",
        );
      }
      bytes = decode(candidate);
    } else {
      throw new Error("unsupported JSON shape");
    }
  } catch (err) {
    // Not JSON. Treat file body as a base58 string.
    if (err instanceof SyntaxError) bytes = decode(raw);
    else throw err;
  }

  if (bytes.length !== 64) {
    throw new Error(
      `keypair at ${path} decoded to ${bytes.length} bytes; expected 64. ` +
        "Use solana-keygen output or a Phantom base58 export ({ \"privateKey\": \"...\" }).",
    );
  }
  return Keypair.fromSecretKey(bytes);
};

export const getConnection = (): Connection =>
  new Connection(getRpcUrl(), "confirmed");

export const getUmi = (payer: Keypair): Umi =>
  createUmi(getRpcUrl())
    .use(mplTokenMetadata())
    .use(keypairIdentity(fromWeb3JsKeypair(payer)));

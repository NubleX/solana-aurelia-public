import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  createSetAuthorityInstruction,
  getAssociatedTokenAddressSync,
  AuthorityType,
} from "@solana/spl-token";
import {
  createFungible,
  findMetadataPda,
  mplTokenMetadata,
} from "@metaplex-foundation/mpl-token-metadata";
import {
  createSignerFromKeypair,
  none,
  percentAmount,
  publicKey,
  signerIdentity,
  some,
} from "@metaplex-foundation/umi";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import {
  fromWeb3JsKeypair,
  toWeb3JsPublicKey,
} from "@metaplex-foundation/umi-web3js-adapters";
import {
  getCluster,
  getConnection,
  getRpcUrl,
  getWalletPubkey,
  loadKeypair,
} from "../lib/connection.js";

type Allocation = {
  bucket: string;
  label: string;
  percent: number;
  amount: number;
  wallet: string;
  note?: string;
  release?: Record<string, unknown>;
  hold?: Record<string, unknown>;
};

type Tokenomics = {
  name: string;
  symbol: string;
  decimals: number;
  totalSupply: number;
  description: string;
  metadataUri: string;
  imagePath: string;
  allocations: Allocation[];
  authorities: { revokeMint: boolean; revokeFreeze: boolean };
};

type DeployResult = {
  cluster: string;
  mint: string;
  decimals: number;
  totalSupply: number;
  metadataUri: string;
  allocations: Array<{ bucket: string; amount: number; wallet: string }>;
  revokedMint: boolean;
  revokedFreeze: boolean;
  explorer: string;
};

const ROOT = resolve(import.meta.dirname, "../..");

const loadTokenomics = (): Tokenomics => {
  const path = resolve(ROOT, "config/tokenomics.json");
  return JSON.parse(readFileSync(path, "utf-8")) as Tokenomics;
};

const assertMainnetGate = (): void => {
  if (getCluster() !== "mainnet-beta") return;
  if (process.env.CONFIRM_MAINNET !== "I_UNDERSTAND") {
    throw new Error(
      "Refusing mainnet mint. Set CONFIRM_MAINNET=I_UNDERSTAND and CLUSTER=mainnet-beta only after explicit review.",
    );
  }
};

const assertAllocations = (cfg: Tokenomics): void => {
  const sumPct = cfg.allocations.reduce((s, a) => s + a.percent, 0);
  const sumAmt = cfg.allocations.reduce((s, a) => s + a.amount, 0);
  if (sumPct !== 100) throw new Error(`allocation percents sum to ${sumPct}, expected 100`);
  if (sumAmt !== cfg.totalSupply) {
    throw new Error(`allocation amounts sum to ${sumAmt}, expected ${cfg.totalSupply}`);
  }

  const wallets = new Set<string>();
  for (const allocation of cfg.allocations) {
    const wallet = new PublicKey(allocation.wallet).toBase58();
    if (wallets.has(wallet)) {
      throw new Error(`duplicate allocation wallet: ${wallet}`);
    }
    wallets.add(wallet);
  }
};

const isLive = (): boolean =>
  process.argv.includes("--live") || process.env.LIVE === "1";

const ensureAllocationWallets = (cfg: Tokenomics, payer: Keypair): Tokenomics => {
  const keysDir = resolve(ROOT, "keys");
  mkdirSync(keysDir, { recursive: true });

  const next = structuredClone(cfg);
  for (const alloc of next.allocations) {
    if (alloc.wallet && alloc.wallet.length > 0) continue;
    // Devnet convenience: park each bucket under a derived sub-wallet keyed by bucket name.
    // On mainnet, set real destination wallets in config/tokenomics.json before minting.
    const path = resolve(keysDir, `alloc-${alloc.bucket}.json`);
    let kp: Keypair;
    if (existsSync(path)) {
      kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf-8")) as number[]));
    } else {
      kp = Keypair.generate();
      writeFileSync(path, JSON.stringify(Array.from(kp.secretKey)));
      console.log(`generated allocation wallet ${alloc.bucket}: ${kp.publicKey.toBase58()} -> ${path}`);
    }
    alloc.wallet = kp.publicKey.toBase58();
  }

  // Keep payer as community source of truth for airdrop dry-runs if unset at top level
  void payer;
  writeFileSync(resolve(ROOT, "config/tokenomics.json"), JSON.stringify(next, null, 2) + "\n");
  return next;
};

const toRawAmount = (ui: number, decimals: number): bigint => {
  const factor = 10n ** BigInt(decimals);
  return BigInt(ui) * factor;
};

/**
 * Create the mint account AND its Metaplex metadata in a single transaction.
 * Uses createFungible (createV1 with TokenStandard.Fungible) so the mint
 * keypair signs the SystemProgram.createAccount instruction internally.
 */
const createMintWithMetadata = async (
  payer: Keypair,
  mint: Keypair,
  cfg: Tokenomics,
): Promise<{ metadataUri: string; metadataPda: string }> => {
  const umi = createUmi(getRpcUrl()).use(mplTokenMetadata());
  const umiPayer = createSignerFromKeypair(umi, fromWeb3JsKeypair(payer));
  const umiMint = createSignerFromKeypair(umi, fromWeb3JsKeypair(mint));
  umi.use(signerIdentity(umiPayer));

  const metadataUri =
    cfg.metadataUri && cfg.metadataUri.length > 0
      ? cfg.metadataUri
      : buildOfflineMetadataUri(cfg);

  await createFungible(umi, {
    mint: umiMint,
    authority: umiPayer,
    payer: umiPayer,
    updateAuthority: umiPayer,
    name: cfg.name,
    symbol: cfg.symbol,
    uri: metadataUri,
    sellerFeeBasisPoints: percentAmount(0),
    decimals: some(cfg.decimals),
    creators: none(),
    collectionDetails: none(),
    printSupply: none(),
  }).sendAndConfirm(umi);

  const mintPk = publicKey(mint.publicKey.toBase58());
  const [metadataPda] = findMetadataPda(umi, { mint: mintPk });
  const metadataPdaStr = toWeb3JsPublicKey(metadataPda).toBase58();
  console.log(`metadata pda: ${metadataPdaStr}`);
  console.log(`metadata uri: ${metadataUri}`);

  return { metadataUri, metadataPda: metadataPdaStr };
};

const mintAndDistribute = async (
  payer: Keypair,
  mint: PublicKey,
  cfg: Tokenomics,
): Promise<Array<{ bucket: string; amount: number; wallet: string }>> => {
  const connection = getConnection();
  const results: Array<{ bucket: string; amount: number; wallet: string }> = [];

  for (const alloc of cfg.allocations) {
    const dest = new PublicKey(alloc.wallet);
    const ata = getAssociatedTokenAddressSync(mint, dest);
    const raw = toRawAmount(alloc.amount, cfg.decimals);

    const tx = new Transaction().add(
      createAssociatedTokenAccountInstruction(payer.publicKey, ata, dest, mint),
      createMintToInstruction(mint, ata, payer.publicKey, raw),
    );
    const sig = await sendAndConfirmTransaction(connection, tx, [payer]);
    console.log(`distributed ${alloc.amount} ${cfg.symbol} -> ${alloc.bucket} (${dest.toBase58()}) sig=${sig}`);
    results.push({ bucket: alloc.bucket, amount: alloc.amount, wallet: dest.toBase58() });
  }
  return results;
};


/**
 * Ensure local metadata JSON exists for review. Never clobber a curated
 * `assets/token-metadata.json` - dry-runs used to rewrite it from a stale
 * hard-coded template (wrong socials, tags, no video).
 *
 * Before mainnet:
 *   1. `npm run publish:assets` copies logo + this JSON to idarti-com.
 *   2. Deploy the site so `metadataUri` returns 200.
 *   3. `npm run publish:assets:verify`.
 */
const buildOfflineMetadataUri = (cfg: Tokenomics): string => {
  const outPath = resolve(ROOT, "assets/token-metadata.json");
  const imageUrl =
    cfg.metadataUri.length > 0
      ? cfg.metadataUri.replace(/\/[^/]+$/, "/logo.png")
      : existsSync(resolve(ROOT, cfg.imagePath))
        ? `file://${resolve(ROOT, cfg.imagePath)}`
        : "";

  if (existsSync(outPath)) {
    const existing = JSON.parse(readFileSync(outPath, "utf-8")) as Record<string, unknown>;
    existing.name = cfg.name;
    existing.symbol = cfg.symbol;
    if (imageUrl) {
      existing.image = imageUrl;
      const props = existing.properties as { files?: Array<{ uri: string; type: string }> } | undefined;
      const logo = props?.files?.find((f) => f.type.startsWith("image/"));
      if (logo) logo.uri = imageUrl;
    }
    writeFileSync(outPath, JSON.stringify(existing, null, 2) + "\n");
  } else {
    const json = {
      name: cfg.name,
      symbol: cfg.symbol,
      description: cfg.description,
      image: imageUrl,
      external_url: "https://www.idarti.com/aurelia/video/",
      tags: ["art", "community", "worldbuilding", "cosmichorror", "surrealism", "solana"],
      extensions: {
        website: "https://idarti.com/",
        instagram: "https://www.instagram.com/id.artcraft/",
        linkedin: "https://www.linkedin.com/in/igordunaev/",
        github: "https://github.com/NubleX/",
        video: "https://www.idarti.com/aurelia/video/",
        roadmap: "https://idarti.com/aurelia/chain/roadmap.html",
      },
      properties: {
        files: [{ uri: imageUrl, type: "image/png" }],
        category: "image",
      },
    };
    writeFileSync(outPath, JSON.stringify(json, null, 2) + "\n");
  }

  return cfg.metadataUri.length > 0
    ? cfg.metadataUri
    : `https://aurelia.local/token-metadata.json`;
};

const revokeAuthorities = async (
  payer: Keypair,
  mint: PublicKey,
  cfg: Tokenomics,
): Promise<{ revokedMint: boolean; revokedFreeze: boolean }> => {
  const connection = getConnection();
  let revokedMint = false;
  let revokedFreeze = false;

  if (cfg.authorities.revokeMint) {
    const tx = new Transaction().add(
      createSetAuthorityInstruction(
        mint,
        payer.publicKey,
        AuthorityType.MintTokens,
        null,
      ),
    );
    await sendAndConfirmTransaction(connection, tx, [payer]);
    revokedMint = true;
    console.log("mint authority revoked");
  }

  if (cfg.authorities.revokeFreeze) {
    const tx = new Transaction().add(
      createSetAuthorityInstruction(
        mint,
        payer.publicKey,
        AuthorityType.FreezeAccount,
        null,
      ),
    );
    await sendAndConfirmTransaction(connection, tx, [payer]);
    revokedFreeze = true;
    console.log("freeze authority revoked");
  }

  return { revokedMint, revokedFreeze };
};

const main = async (): Promise<void> => {
  const live = isLive();
  if (live) assertMainnetGate();
  let cfg = loadTokenomics();
  assertAllocations(cfg);

  console.log(`cluster: ${getCluster()}`);
  console.log(`mode:    ${live ? "LIVE (will send transactions)" : "dry-run (no transactions)"}`);
  console.log(`token:   ${cfg.name} ($${cfg.symbol})`);
  console.log(`supply:  ${cfg.totalSupply.toLocaleString()} / ${cfg.decimals} decimals`);
  for (const alloc of cfg.allocations) {
    const dest = alloc.wallet.length > 0 ? alloc.wallet : "(unset - generated only on --live)";
    console.log(`  - ${alloc.bucket}: ${alloc.amount.toLocaleString()} -> ${dest}`);
  }

  if (!live) {
    buildOfflineMetadataUri(cfg);
    console.log("\ndry-run complete. No mint, no distribution, no keys written.");
    console.log("When ready for a live mint: npm run token:create:live");
    return;
  }

  const payer = loadKeypair();
  const expectedPayer = getWalletPubkey();
  if (expectedPayer && payer.publicKey.toBase58() !== expectedPayer) {
    throw new Error(
      `KEYPAIR_PATH resolves to ${payer.publicKey.toBase58()}, expected WALLET_PUBKEY ${expectedPayer}`,
    );
  }
  const connection = getConnection();
  const bal = await connection.getBalance(payer.publicKey);
  console.log(`payer:   ${payer.publicKey.toBase58()} (${bal / 1e9} SOL)`);

  if (bal < 0.05 * 1e9) {
    throw new Error(`payer balance too low (${bal / 1e9} SOL). Fund the payer before minting.`);
  }

  cfg = ensureAllocationWallets(cfg, payer);

  const mint = Keypair.generate();
  console.log(`mint:    ${mint.publicKey.toBase58()}`);
  const pendingPath = resolve(ROOT, "assets/deploy-pending.json");
  writeFileSync(
    pendingPath,
    JSON.stringify(
      {
        cluster: getCluster(),
        mint: mint.publicKey.toBase58(),
        metadataUri: cfg.metadataUri,
        startedAt: new Date().toISOString(),
      },
      null,
      2,
    ) + "\n",
  );

  const { metadataUri } = await createMintWithMetadata(payer, mint, cfg);
  console.log(`mint + metadata created`);

  const allocations = await mintAndDistribute(payer, mint.publicKey, cfg);
  const { revokedMint, revokedFreeze } = await revokeAuthorities(payer, mint.publicKey, cfg);

  const explorer =
    getCluster() === "mainnet-beta"
      ? `https://explorer.solana.com/address/${mint.publicKey.toBase58()}`
      : `https://explorer.solana.com/address/${mint.publicKey.toBase58()}?cluster=devnet`;

  const result: DeployResult = {
    cluster: getCluster(),
    mint: mint.publicKey.toBase58(),
    decimals: cfg.decimals,
    totalSupply: cfg.totalSupply,
    metadataUri,
    allocations,
    revokedMint,
    revokedFreeze,
    explorer,
  };

  mkdirSync(resolve(ROOT, "assets"), { recursive: true });
  writeFileSync(resolve(ROOT, "assets/deploy-result.json"), JSON.stringify(result, null, 2) + "\n");
  unlinkSync(pendingPath);
  console.log("\n=== deploy complete ===");
  console.log(JSON.stringify(result, null, 2));
};

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

/**
 * Publish the AURA logo + off-chain token metadata to a self-hosted
 * static path (idarti.com by default) and rewrite the local configs
 * to point at those URLs.
 *
 * No IPFS. No pinning service. No SOL fees. Just files served by the
 * same static site the studio already runs.
 *
 * Flow:
 *   1. Copy the logo from tokenomics.imagePath into PUBLISH_DIR/logo.png
 *   2. Rewrite assets/token-metadata.json with the public image URL
 *   3. Copy the updated metadata JSON into PUBLISH_DIR/metadata.json
 *   4. Write metadataUri back into config/tokenomics.json
 *   5. Optional --verify: fetch both URLs and assert 200 + correct MIME
 *
 * Env overrides:
 *   PUBLISH_DIR       target directory on disk (default: idarti-com/public/aurelia/chain)
 *   PUBLISH_BASE_URL  public URL prefix that serves PUBLISH_DIR
 *                     (default: https://idarti.com/aurelia/chain)
 *
 * Usage:
 *   npm run publish:assets           # copy + rewrite configs
 *   npm run publish:assets -- --verify  # also HTTP-check the deployed URLs
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnv } from "../lib/connection.js";

loadEnv();

const ROOT = resolve(process.cwd());

const DEFAULT_PUBLISH_DIR = "/home/muscle/projects/idarti-com/public/aurelia/chain";
const DEFAULT_BASE_URL = "https://idarti.com/aurelia/chain";
const LOGO_FILENAME = "logo.png";
const METADATA_FILENAME = "metadata.json";

const publishDir = process.env.PUBLISH_DIR ?? DEFAULT_PUBLISH_DIR;
const baseUrl = (process.env.PUBLISH_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, "");
const shouldVerify = process.argv.includes("--verify");

type Tokenomics = {
  imagePath: string;
  metadataUri: string;
  [k: string]: unknown;
};

type MetadataFile = { uri: string; type: string };
type Metadata = {
  image: string;
  properties: { files: MetadataFile[]; category: string };
  [k: string]: unknown;
};

const joinUrl = (base: string, filename: string): string => `${base}/${filename}`;

const copyLogo = (src: string, dest: string): void => {
  mkdirSync(publishDir, { recursive: true });
  copyFileSync(src, dest);
  console.log(`logo:     ${src}`);
  console.log(`       -> ${dest}`);
};

const rewriteMetadata = (
  metadataPath: string,
  imageUrl: string,
): Metadata => {
  const raw = readFileSync(metadataPath, "utf-8");
  const metadata = JSON.parse(raw) as Metadata;
  metadata.image = imageUrl;
  const files = metadata.properties?.files ?? [];
  const logo = files.find((f) => f.type.startsWith("image/"));
  if (logo) logo.uri = imageUrl;
  else files.unshift({ uri: imageUrl, type: "image/png" });
  if (!metadata.properties) metadata.properties = { files, category: "image" };
  else metadata.properties.files = files;
  writeFileSync(metadataPath, JSON.stringify(metadata, null, 2) + "\n");
  console.log(`metadata: ${metadataPath} (image URI synced)`);
  return metadata;
};

const publishMetadata = (metadata: Metadata, dest: string): void => {
  writeFileSync(dest, JSON.stringify(metadata, null, 2) + "\n");
  console.log(`       -> ${dest}`);
};

const writeTokenomicsUri = (tokenomicsPath: string, metadataUri: string): void => {
  const tokenomics = JSON.parse(readFileSync(tokenomicsPath, "utf-8")) as Tokenomics;
  tokenomics.metadataUri = metadataUri;
  writeFileSync(tokenomicsPath, JSON.stringify(tokenomics, null, 2) + "\n");
  console.log(`config:   ${tokenomicsPath} (metadataUri set)`);
};

const verifyUrl = async (url: string, expectedType: string): Promise<boolean> => {
  try {
    const res = await fetch(url, { method: "GET", redirect: "follow" });
    const ctype = res.headers.get("content-type") ?? "";
    const ok = res.ok && ctype.toLowerCase().startsWith(expectedType);
    console.log(`  ${ok ? "OK " : "BAD"} ${res.status} ${ctype}  ${url}`);
    return ok;
  } catch (err) {
    console.log(`  ERR    -   ${url}  (${err instanceof Error ? err.message : String(err)})`);
    return false;
  }
};

const main = async (): Promise<void> => {
  const tokenomicsPath = resolve(ROOT, "config/tokenomics.json");
  const metadataPath = resolve(ROOT, "assets/token-metadata.json");

  const tokenomics = JSON.parse(readFileSync(tokenomicsPath, "utf-8")) as Tokenomics;
  const logoSrc = resolve(ROOT, tokenomics.imagePath);
  if (!existsSync(logoSrc)) throw new Error(`logo not found: ${logoSrc}`);
  if (!existsSync(metadataPath)) throw new Error(`metadata template not found: ${metadataPath}`);

  const logoDest = resolve(publishDir, LOGO_FILENAME);
  const metadataDest = resolve(publishDir, METADATA_FILENAME);
  const imageUrl = joinUrl(baseUrl, LOGO_FILENAME);
  const metadataUrl = joinUrl(baseUrl, METADATA_FILENAME);

  console.log(`publish dir: ${publishDir}`);
  console.log(`base URL:    ${baseUrl}`);
  console.log("");

  copyLogo(logoSrc, logoDest);
  const metadata = rewriteMetadata(metadataPath, imageUrl);
  publishMetadata(metadata, metadataDest);
  writeTokenomicsUri(tokenomicsPath, metadataUrl);

  console.log("");
  console.log("=== published ===");
  console.log(`image:    ${imageUrl}`);
  console.log(`metadata: ${metadataUrl}`);
  console.log("");
  console.log("Next: commit + deploy the idarti-com static site, then re-run with --verify.");

  if (shouldVerify) {
    console.log("");
    console.log("verifying live URLs:");
    const [imgOk, metaOk] = await Promise.all([
      verifyUrl(imageUrl, "image/"),
      verifyUrl(metadataUrl, "application/json"),
    ]);
    if (!imgOk || !metaOk) {
      console.error("verification failed - deploy the site or fix headers before minting");
      process.exit(1);
    }
    console.log("both URLs healthy.");
  }
};

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

/**
 * Create a Squads v4 multisig (2-of-3: payer / team / treasury).
 * Vault index 0 is the Streamflow recipient. configAuthority = null.
 *
 *   KEYPAIR_PATH=./keys/payer.json npm run vest:squads:create
 *   KEYPAIR_PATH=./keys/payer.json CONFIRM_MAINNET=I_UNDERSTAND npm run vest:squads:create:live
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import * as multisig from "@sqds/multisig";
import {
  getCluster,
  getConnection,
  loadEnv,
  loadKeypair,
} from "../lib/connection.js";
import { MINT, ROOT } from "./shared.js";
import {
  THRESHOLD,
  VAULT_INDEX,
  assertFeeMath,
  defaultMembers,
  saveSquadsState,
  vaultAtaFor,
  type SquadsState,
} from "./squads.js";

loadEnv();

const isLive = (): boolean =>
  process.argv.includes("--live") || process.env.LIVE === "1";

const main = async (): Promise<void> => {
  assertFeeMath();
  const live = isLive();
  const cluster = getCluster();
  const connection = getConnection();
  const creator = loadKeypair();
  const membersMeta = defaultMembers();

  const createKey = Keypair.generate();
  const [multisigPda] = multisig.getMultisigPda({
    createKey: createKey.publicKey,
  });
  const [vaultPda] = multisig.getVaultPda({
    multisigPda,
    index: VAULT_INDEX,
  });
  const vaultAta = vaultAtaFor(vaultPda);

  const { Permission, Permissions } = multisig.types;
  const members = membersMeta.map((m) => ({
    key: new PublicKey(m.pubkey),
    permissions: Permissions.fromPermissions([
      Permission.Initiate,
      Permission.Vote,
      Permission.Execute,
    ]),
  }));

  console.log(`cluster:     ${cluster}`);
  console.log(`mode:        ${live ? "LIVE" : "dry-run"}`);
  console.log(`createKey:   ${createKey.publicKey.toBase58()}`);
  console.log(`multisigPda: ${multisigPda.toBase58()}`);
  console.log(`vaultPda:    ${vaultPda.toBase58()} (index ${VAULT_INDEX})`);
  console.log(`vault ATA:   ${vaultAta.toBase58()}`);
  console.log(`threshold:   ${THRESHOLD}-of-${members.length}`);
  console.log(`configAuth:  null (immutable membership)`);
  console.log("members:");
  for (const m of membersMeta) {
    console.log(`  ${m.role.padEnd(10)} ${m.pubkey}`);
  }

  const plan: SquadsState = {
    cluster,
    multisigPda: multisigPda.toBase58(),
    vaultPda: vaultPda.toBase58(),
    vaultIndex: VAULT_INDEX,
    createKey: createKey.publicKey.toBase58(),
    threshold: THRESHOLD,
    configAuthority: null,
    members: membersMeta,
    vaultAta: vaultAta.toBase58(),
    dryRun: !live,
  };

  const planPath = resolve(ROOT, "assets/squads-create-plan.json");
  writeFileSync(planPath, JSON.stringify(plan, null, 2) + "\n");
  console.log(`\nwrote ${planPath}`);

  if (!live) {
    // Provisional squads.json so gather/streamflow dry-runs can resolve PDAs.
    // Replaced on live create (new createKey).
    saveSquadsState(plan);
    console.log("wrote assets/squads.json (dryRun provisional)");
    console.log(
      "\nDry-run only. Re-run with --live + CONFIRM_MAINNET=I_UNDERSTAND to create.",
    );
    return;
  }
  if (cluster === "mainnet-beta" && process.env.CONFIRM_MAINNET !== "I_UNDERSTAND") {
    throw new Error("Refusing mainnet live Squads create without CONFIRM_MAINNET=I_UNDERSTAND");
  }

  const [programConfigPda] = multisig.getProgramConfigPda({});
  const programConfig = await multisig.accounts.ProgramConfig.fromAccountAddress(
    connection,
    programConfigPda,
  );
  const treasury = programConfig.treasury;
  console.log(`\nSquads program treasury: ${treasury.toBase58()}`);
  console.log(`creation fee (lamports): ${programConfig.multisigCreationFee.toString()}`);

  console.log("\ncreating multisig…");
  const createSig = await multisig.rpc.multisigCreateV2({
    connection,
    treasury,
    createKey,
    creator,
    multisigPda,
    configAuthority: null,
    threshold: THRESHOLD,
    members,
    timeLock: 0,
    rentCollector: null,
    memo: "AURA 800M Streamflow vault (2-of-3)",
  });
  console.log(`create tx: ${createSig}`);

  // Ensure vault ATA exists (allowOwnerOffCurve) so Streamflow auto-withdraw can credit it.
  console.log("creating vault AURA ATA…");
  const ataTx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(
      creator.publicKey,
      vaultAta,
      vaultPda,
      MINT,
    ),
  );
  const ataSig = await sendAndConfirmTransaction(connection, ataTx, [creator], {
    commitment: "confirmed",
  });
  console.log(`vault ATA tx: ${ataSig}`);

  const state: SquadsState = {
    ...plan,
    dryRun: false,
    createTx: createSig,
    vaultAta: vaultAta.toBase58(),
  };
  saveSquadsState(state);
  console.log(`\nwrote assets/squads.json`);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

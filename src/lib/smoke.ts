import {
  getCluster,
  getConnection,
  getRpcUrl,
  getWalletPubkey,
  loadKeypair,
} from "./connection.js";
import { PublicKey } from "@solana/web3.js";

const main = async (): Promise<void> => {
  const connection = getConnection();
  const version = await connection.getVersion();
  const slot = await connection.getSlot();
  console.log(`cluster: ${getCluster()}`);
  console.log(`rpc:     ${getRpcUrl()}`);
  console.log(`version: ${version["solana-core"]}`);
  console.log(`slot:    ${slot}`);

  const wallet = getWalletPubkey();
  if (wallet) {
    const pk = new PublicKey(wallet);
    const bal = await connection.getBalance(pk);
    console.log(`wallet:  ${wallet}`);
    console.log(`balance: ${bal / 1e9} SOL`);
  }

  if (process.env.KEYPAIR_PATH) {
    try {
      const payer = loadKeypair();
      const balance = await connection.getBalance(payer.publicKey);
      console.log(`payer:   ${payer.publicKey.toBase58()}`);
      console.log(`balance: ${balance / 1e9} SOL`);
      if (wallet && payer.publicKey.toBase58() !== wallet) {
        console.log("note:    KEYPAIR_PATH pubkey does not match WALLET_PUBKEY");
      }
    } catch (err) {
      console.log(`payer:   (no keypair at KEYPAIR_PATH yet - ${String(err)})`);
    }
  }
};

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

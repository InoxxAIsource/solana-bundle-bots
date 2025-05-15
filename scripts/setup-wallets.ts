import { config } from 'dotenv';
import * as path from 'path';
import { WalletManager } from '../app/src/wallet-manager';

// Load environment variables
config();

async function setupWallets() {
  console.log('Setting up wallets...');
  
  try {
    // Create wallet manager
    const walletManager = new WalletManager(
      process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com',
      process.env.MASTER_WALLET_PATH || path.join(__dirname, '../keys/master-wallet.json'),
      process.env.ENCRYPTION_PASSWORD || 'default-password-change-me',
      process.env.WALLET_CONFIG_PATH
    );
    
    console.log('Initializing wallets...');
    await walletManager.initializeWallets(20);
    
    console.log('Getting wallet information...');
    const walletInfo = await walletManager.getWalletInfo();
    
    console.log('\nWallet setup complete!');
    console.log('------------------------');
    console.log(`Master wallet: ${await walletManager.getMasterWalletPublicKey()}`);
    console.log(`Wallets initialized: ${walletInfo.length}`);
    
    console.log('\nIMPORTANT: Make sure to fund your master wallet with SOL!');
    console.log(`You can do this by sending SOL to the master wallet address.`);
  } catch (error) {
    console.error('Error setting up wallets:', error);
    process.exit(1);
  }
}

setupWallets().catch(console.error);

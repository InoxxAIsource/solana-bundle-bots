import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
  SystemProgram,
  LAMPORTS_PER_SOL
} from '@solana/web3.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

interface WalletConfig {
  index: number;
  label: string;
  publicKey: string;
  encryptedPrivateKey: string;
  balanceThresholds: {
    min: number;
    target: number;
    max: number;
  };
}

export class WalletManager {
  private connection: Connection;
  private wallets: Map<number, Keypair> = new Map();
  private walletConfigs: Map<number, WalletConfig> = new Map();
  private masterWallet: Keypair;
  private configPath: string;
  private encryptionKey: Buffer;
  
  constructor(
    rpcEndpoint: string,
    masterWalletPath: string,
    encryptionPassword: string,
    configDirectoryPath?: string
  ) {
    this.connection = new Connection(rpcEndpoint, 'confirmed');
    this.configPath = configDirectoryPath || path.join(os.homedir(), '.bundlebot', 'wallets.json');
    this.encryptionKey = crypto.scryptSync(encryptionPassword, 'salt', 32);
    
    // Load master wallet
    if (fs.existsSync(masterWalletPath)) {
      const masterWalletJson = JSON.parse(fs.readFileSync(masterWalletPath, 'utf-8'));
      this.masterWallet = Keypair.fromSecretKey(
        Uint8Array.from(Buffer.from(masterWalletJson, 'base64'))
      );
    } else {
      // Create new master wallet if none exists
      this.masterWallet = Keypair.generate();
      const keyDir = path.dirname(masterWalletPath);
      
      if (!fs.existsSync(keyDir)) {
        fs.mkdirSync(keyDir, { recursive: true });
      }
      
      fs.writeFileSync(
        masterWalletPath,
        Buffer.from(this.masterWallet.secretKey).toString('base64')
      );
      
      console.log(`Created new master wallet: ${this.masterWallet.publicKey.toString()}`);
      console.log('YOU MUST FUND THIS WALLET BEFORE USING THE SYSTEM');
    }
    
    // Ensure config directory exists
    const configDir = path.dirname(this.configPath);
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    
    // Load existing wallet configs if available
    this.loadWalletConfigs();
  }
  
  private loadWalletConfigs(): void {
    try {
      if (fs.existsSync(this.configPath)) {
        const configData = JSON.parse(fs.readFileSync(this.configPath, 'utf-8'));
        
        for (const config of configData) {
          this.walletConfigs.set(config.index, config);
        }
        
        console.log(`Loaded ${this.walletConfigs.size} wallet configurations`);
      }
    } catch (error) {
      console.error('Error loading wallet configurations:', error);
    }
  }
  
  private saveWalletConfigs(): void {
    try {
      const configData = Array.from(this.walletConfigs.values());
      fs.writeFileSync(this.configPath, JSON.stringify(configData, null, 2));
      console.log('Wallet configurations saved');
    } catch (error) {
      console.error('Error saving wallet configurations:', error);
    }
  }
  
  async initializeWallets(count: number = 20): Promise<void> {
    // Create new wallets if needed
    const existingCount = this.walletConfigs.size;
    const newWalletsNeeded = Math.max(0, count - existingCount);
    
    console.log(`Initializing wallets: ${existingCount} existing, ${newWalletsNeeded} new needed`);
    
    if (newWalletsNeeded > 0) {
      for (let i = 0; i < newWalletsNeeded; i++) {
        const index = existingCount + i;
        await this.createNewWallet(index);
      }
    }
    
    // Load all wallets into memory
    for (let i = 0; i < count; i++) {
      const config = this.walletConfigs.get(i);
      if (config) {
        const decryptedKey = this.decryptPrivateKey(config.encryptedPrivateKey);
        const wallet = Keypair.fromSecretKey(decryptedKey);
        this.wallets.set(i, wallet);
      }
    }
    
    console.log(`${this.wallets.size} wallets loaded into memory`);
  }
  
  private async createNewWallet(index: number): Promise<void> {
    try {
      // Create new keypair
      const wallet = Keypair.generate();
      
      // Fund the wallet from master wallet
      const fundingAmount = 0.05 * LAMPORTS_PER_SOL; // 0.05 SOL
      
      const transaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: this.masterWallet.publicKey,
          toPubkey: wallet.publicKey,
          lamports: fundingAmount,
        })
      );
      
      await sendAndConfirmTransaction(
        this.connection,
        transaction,
        [this.masterWallet]
      );
      
      // Save wallet config
      const walletConfig: WalletConfig = {
        index,
        label: `Bot Wallet ${index}`,
        publicKey: wallet.publicKey.toString(),
        encryptedPrivateKey: this.encryptPrivateKey(wallet.secretKey),
        balanceThresholds: {
          min: 0.01,  // SOL
          target: 0.05, // SOL
          max: 0.1,   // SOL
        }
      };
      
      this.walletConfigs.set(index, walletConfig);
      this.wallets.set(index, wallet);
      
      console.log(`Created and funded wallet ${index}: ${wallet.publicKey.toString()}`);
      
      // Save updated configs
      this.saveWalletConfigs();
      
    } catch (error) {
      console.error(`Error creating wallet ${index}:`, error);
      throw error;
    }
  }
  
  private encryptPrivateKey(privateKey: Uint8Array): string {
    // Encrypt the private key using AES-256-GCM
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    
    const encryptedKey = Buffer.concat([
      cipher.update(Buffer.from(privateKey)),
      cipher.final()
    ]);
    
    const authTag = cipher.getAuthTag();
    
    // Return as base64 encoded string: iv + authTag + encryptedKey
    return Buffer.concat([iv, authTag, encryptedKey]).toString('base64');
  }
  
  private decryptPrivateKey(encryptedKey: string): Uint8Array {
    // Decode the base64 string
    const encryptedBuffer = Buffer.from(encryptedKey, 'base64');
    
    // Extract iv, authTag, and encrypted data
    const iv = encryptedBuffer.subarray(0, 16);
    const authTag = encryptedBuffer.subarray(16, 32);
    const encryptedData = encryptedBuffer.subarray(32);
    
    // Decrypt
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.encryptionKey, iv);
    decipher.setAuthTag(authTag);
    
    const decryptedKey = Buffer.concat([
      decipher.update(encryptedData),
      decipher.final()
    ]);
    
    return Uint8Array.from(decryptedKey);
  }
  
  async getWallet(index: number): Promise<Keypair | null> {
    return this.wallets.get(index) || null;
  }
  
  async getWalletPublicKey(index: number): Promise<PublicKey | null> {
    const wallet = this.wallets.get(index);
    return wallet ? wallet.publicKey : null;
  }
  
  async balanceCheck(): Promise<Map<number, number>> {
    const balances = new Map<number, number>();
    
    for (const [index, wallet] of this.wallets.entries()) {
      try {
        const balance = await this.connection.getBalance(wallet.publicKey);
        const solBalance = balance / LAMPORTS_PER_SOL;
        balances.set(index, solBalance);
        
        // Check if rebalance is needed
        const config = this.walletConfigs.get(index);
        if (config && solBalance < config.balanceThresholds.min) {
          console.log(`Wallet ${index} balance (${solBalance} SOL) below minimum threshold, needs funding`);
        }
      } catch (error) {
        console.error(`Error checking balance for wallet ${index}:`, error);
      }
    }
    
    return balances;
  }
  
  async rebalanceWallets(): Promise<void> {
    try {
      const masterBalance = await this.connection.getBalance(this.masterWallet.publicKey) / LAMPORTS_PER_SOL;
      console.log(`Master wallet balance: ${masterBalance} SOL`);
      
      for (const [index, wallet] of this.wallets.entries()) {
        const config = this.walletConfigs.get(index);
        if (!config) continue;
        
        const balance = await this.connection.getBalance(wallet.publicKey) / LAMPORTS_PER_SOL;
        
        if (balance < config.balanceThresholds.min) {
          const topUpAmount = (config.balanceThresholds.target - balance) * LAMPORTS_PER_SOL;
          
          if (masterBalance > (topUpAmount / LAMPORTS_PER_SOL) + 0.01) {
            const transaction = new Transaction().add(
              SystemProgram.transfer({
                fromPubkey: this.masterWallet.publicKey,
                toPubkey: wallet.publicKey,
                lamports: topUpAmount,
              })
            );
            
            await sendAndConfirmTransaction(
              this.connection,
              transaction,
              [this.masterWallet]
            );
            
            console.log(`Topped up wallet ${index} with ${topUpAmount / LAMPORTS_PER_SOL} SOL`);
          } else {
            console.warn(`Master wallet has insufficient funds to top up wallet ${index}`);
          }
        } else if (balance > config.balanceThresholds.max) {
          const returnAmount = (balance - config.balanceThresholds.target) * LAMPORTS_PER_SOL;
          
          const transaction = new Transaction().add(
            SystemProgram.transfer({
              fromPubkey: wallet.publicKey,
              toPubkey: this.masterWallet.publicKey,
              lamports: returnAmount,
            })
          );
          
          await sendAndConfirmTransaction(
            this.connection,
            transaction,
            [wallet]
          );
          
          console.log(`Returned ${returnAmount / LAMPORTS_PER_SOL} SOL from wallet ${index} to master wallet`);
        }
      }
    } catch (error) {
      console.error('Error rebalancing wallets:', error);
      throw error;
    }
  }
  
  async getWalletInfo(): Promise<any[]> {
    const walletInfo = [];
    
    for (const [index, wallet] of this.wallets.entries()) {
      try {
        const balance = await this.connection.getBalance(wallet.publicKey);
        const solBalance = balance / LAMPORTS_PER_SOL;
        const config = this.walletConfigs.get(index);
        
        walletInfo.push({
          index,
          label: config?.label || `Wallet ${index}`,
          publicKey: wallet.publicKey.toString(),
          balance: solBalance,
          thresholds: config?.balanceThresholds,
        });
      } catch (error) {
        console.error(`Error getting info for wallet ${index}:`, error);
      }
    }
    
    return walletInfo;
  }
  
  async getMasterWalletPublicKey(): Promise<string> {
    return this.masterWallet.publicKey.toString();
  }
}

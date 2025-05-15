import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { config } from 'dotenv';
import { Connection, PublicKey, TransactionInstruction } from '@solana/web3.js';
import { WalletManager } from './wallet-manager';
import { BundleExecutionManager } from './bundle-manager';
import * as path from 'path';

// Load environment variables
config();

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(helmet());
app.use(express.json());

// Rate limiting
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: process.env.API_RATE_LIMIT ? parseInt(process.env.API_RATE_LIMIT) : 100,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use('/api/', apiLimiter);

// Initialize managers
const walletManager = new WalletManager(
  process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com',
  process.env.MASTER_WALLET_PATH || path.join(__dirname, '../../keys/master-wallet.json'),
  process.env.ENCRYPTION_PASSWORD || 'default-password-change-me',
  process.env.WALLET_CONFIG_PATH
);

const bundleManager = new BundleExecutionManager(
  process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com',
  walletManager,
  {
    commitment: 'confirmed'
  }
);

// Initialize app
async function initializeApp() {
  try {
    await walletManager.initializeWallets(20); // Initialize 20 wallets
    console.log('Application initialized successfully');
  } catch (error) {
    console.error('Error initializing application:', error);
    process.exit(1);
  }
}

// API Routes

// Health check
app.get('/api/health', (req, res) => {
  res.json({ success: true, status: 'ok' });
});

// Get wallet information
app.get('/api/wallets', async (req, res) => {
  try {
    const walletInfo = await walletManager.getWalletInfo();
    res.json({ success: true, data: walletInfo });
  } catch (error) {
    console.error('Error getting wallet info:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get master wallet public key
app.get('/api/master-wallet', async (req, res) => {
  try {
    const publicKey = await walletManager.getMasterWalletPublicKey();
    res.json({ success: true, data: { publicKey } });
  } catch (error) {
    console.error('Error getting master wallet:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Rebalance wallets
app.post('/api/wallets/rebalance', async (req, res) => {
  try {
    await walletManager.rebalanceWallets();
    res.json({ success: true });
  } catch (error) {
    console.error('Error rebalancing wallets:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Add instruction to wallet
app.post('/api/instructions', async (req, res) => {
  try {
    const { walletIndex, programId, keys, data, priority } = req.body;
    
    if (typeof walletIndex !== 'number' || walletIndex < 0 || walletIndex >= 20) {
      return res.status(400).json({ success: false, error: 'Invalid wallet index' });
    }
    
    if (!programId) {
      return res.status(400).json({ success: false, error: 'Program ID is required' });
    }
    
    if (!Array.isArray(keys)) {
      return res.status(400).json({ success: false, error: 'Keys must be an array' });
    }
    
    if (!data) {
      return res.status(400).json({ success: false, error: 'Instruction data is required' });
    }
    
    const instruction = new TransactionInstruction({
      programId: new PublicKey(programId),
      keys: keys.map(k => ({
        pubkey: new PublicKey(k.pubkey),
        isSigner: !!k.isSigner,
isWritable: !!k.isWritable
      })),
      data: Buffer.from(data, 'base64')
    });
    
    const instructionId = await bundleManager.addInstruction(
      walletIndex,
      instruction,
      priority || 1
    );
    
    res.json({ success: true, data: { instructionId } });
  } catch (error) {
    console.error('Error adding instruction:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Create bundle
app.post('/api/bundles', async (req, res) => {
  try {
    const { privacyLevel, groupByTarget, maxInstructionsPerTransaction } = req.body;
    
    const bundleId = await bundleManager.createBundle({
      privacyLevel,
      groupByTarget,
      maxInstructionsPerTransaction
    });
    
    res.json({ success: true, data: { bundleId } });
  } catch (error) {
    console.error('Error creating bundle:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Execute bundle
app.post('/api/bundles/:bundleId/execute', async (req, res) => {
  try {
    const { bundleId } = req.params;
    
    if (!bundleId) {
      return res.status(400).json({ success: false, error: 'Bundle ID is required' });
    }
    
    const result = await bundleManager.executeBundle(bundleId);
    
    res.json({
      success: true,
      data: {
        bundleId,
        status: result.success ? 'completed' : 'failed',
        transactionsCompleted: result.transactionResults.filter(r => r.success).length,
        totalTransactions: result.transactionResults.length,
        signatures: result.transactionResults
          .filter(r => r.success && r.signature)
          .map(r => r.signature)
      }
    });
  } catch (error) {
    console.error(`Error executing bundle:`, error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Set bundle priority
app.post('/api/bundles/:bundleId/priority', async (req, res) => {
  try {
    const { bundleId } = req.params;
    const { priority } = req.body;
    
    if (!bundleId) {
      return res.status(400).json({ success: false, error: 'Bundle ID is required' });
    }
    
    if (!priority || !['normal', 'high', 'maximum'].includes(priority)) {
      return res.status(400).json({ success: false, error: 'Invalid priority. Must be normal, high, or maximum' });
    }
    
    bundleManager.setExecutionPriority(bundleId, priority);
    
    res.json({ success: true, data: { bundleId, priority } });
  } catch (error) {
    console.error('Error setting bundle priority:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get bundle status
app.get('/api/bundles/:bundleId', async (req, res) => {
  try {
    const { bundleId } = req.params;
    
    if (!bundleId) {
      return res.status(400).json({ success: false, error: 'Bundle ID is required' });
    }
    
    const bundle = await bundleManager.getBundleStatus(bundleId);
    
    if (!bundle) {
      return res.status(404).json({ success: false, error: 'Bundle not found' });
    }
    
    const result = await bundleManager.getBundleResult(bundleId);
    
    res.json({
      success: true,
      data: {
        ...bundle,
        result: result || undefined
      }
    });
  } catch (error) {
    console.error('Error getting bundle status:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get all bundles
app.get('/api/bundles', async (req, res) => {
  try {
    const bundles = await bundleManager.getAllBundles();
    res.json({ success: true, data: bundles });
  } catch (error) {
    console.error('Error getting bundles:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get pending instructions count
app.get('/api/instructions/pending/count', async (req, res) => {
  try {
    const count = await bundleManager.getPendingInstructionsCount();
    res.json({ success: true, data: { count } });
  } catch (error) {
    console.error('Error getting pending instructions count:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Start server
initializeApp()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  })
  .catch(error => {
    console.error('Failed to start server:', error);
  });

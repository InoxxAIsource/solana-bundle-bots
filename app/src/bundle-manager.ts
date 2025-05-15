import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  ComputeBudgetProgram,
  sendAndConfirmTransaction,
  SystemProgram,
  Commitment
} from '@solana/web3.js';
import { WalletManager } from './wallet-manager';
import { v4 as uuidv4 } from 'uuid';

interface InstructionWithMetadata {
  id: string;
  walletIndex: number;
  instruction: TransactionInstruction;
  priority: number;
  addedAt: number;
  status: InstructionStatus;
  bundleId?: string;
  executedAt?: number;
  error?: string;
}

interface WalletTransaction {
  walletIndex: number;
  transaction: Transaction;
}

interface TransactionResult {
  walletIndex: number;
  signature?: string;
  success: boolean;
  error?: string;
}

interface BundleExecutionResult {
  bundleId: string;
  startTime: number;
  endTime: number;
  success: boolean;
  transactionResults: TransactionResult[];
  error?: string;
}

interface BundleOptions {
  privacyLevel?: 'none' | 'basic' | 'maximum';
  groupByTarget?: boolean;
  maxInstructionsPerTransaction?: number;
}

enum InstructionStatus {
  PENDING = 'pending',
  BUNDLED = 'bundled',
  EXECUTED = 'executed',
  FAILED = 'failed'
}

class Bundle {
  id: string;
  transactions: WalletTransaction[] = [];
  createdAt: number;
  status: 'pending' | 'executing' | 'completed' | 'failed';
  executedAt?: number;
  errorMessage?: string;
  options: BundleOptions;
  
  constructor(id: string = uuidv4(), options: BundleOptions = {}) {
    this.id = id;
    this.createdAt = Date.now();
    this.status = 'pending';
    this.options = options;
  }
  
  addTransaction(transaction: Transaction, walletIndex: number): void {
    this.transactions.push({ walletIndex, transaction });
  }
  
  hasHighPriority(): boolean {
    return this.options.privacyLevel === 'maximum';
  }
}

export class BundleExecutionManager {
  private connection: Connection;
  private walletManager: WalletManager;
  private pendingInstructions: Map<string, InstructionWithMetadata> = new Map();
  private bundles: Bundle[] = [];
  private executionResults: Map<string, BundleExecutionResult> = new Map();
  private commitment: Commitment = 'confirmed';
  
  constructor(
    rpcEndpoint: string,
    walletManager: WalletManager,
    options: {
      commitment?: Commitment;
    } = {}
  ) {
    this.connection = new Connection(rpcEndpoint, options.commitment || this.commitment);
    this.walletManager = walletManager;
  }
  
  async addInstruction(walletIndex: number, instruction: TransactionInstruction, priority: number = 1): Promise<string> {
    // Validate wallet index
    const wallet = await this.walletManager.getWallet(walletIndex);
    if (!wallet) {
      throw new Error(`Invalid wallet index: ${walletIndex}`);
    }
    
    const id = uuidv4();
    
    this.pendingInstructions.set(id, {
      id,
      walletIndex,
      instruction,
      priority,
      addedAt: Date.now(),
      status: InstructionStatus.PENDING
    });
    
    console.log(`Added instruction ${id} for wallet ${walletIndex} with priority ${priority}`);
    
    return id;
  }
  
  async createBundle(options: BundleOptions = {}): Promise<string> {
    if (this.pendingInstructions.size === 0) {
      throw new Error('No pending instructions to bundle');
    }
    
    const bundle = new Bundle(uuidv4(), options);
    
    // Group instructions by wallet
    const instructionsByWallet = new Map<number, InstructionWithMetadata[]>();
    
    for (const instruction of this.pendingInstructions.values()) {
      if (!instructionsByWallet.has(instruction.walletIndex)) {
        instructionsByWallet.set(instruction.walletIndex, []);
      }
      instructionsByWallet.get(instruction.walletIndex)!.push(instruction);
    }
    
    // Sort instructions by priority (high to low) within each wallet
    for (const walletInstructions of instructionsByWallet.values()) {
      walletInstructions.sort((a, b) => b.priority - a.priority);
    }
    
    // Create transactions for each wallet
    for (const [walletIndex, instructions] of instructionsByWallet.entries()) {
      const wallet = await this.walletManager.getWallet(walletIndex);
      if (!wallet) continue;
      
      // Determine max instructions per transaction
      const maxInstructionsPerTx = options.maxInstructionsPerTransaction || 10;
      
      // Split instructions into chunks to avoid transaction size limits
      for (let i = 0; i < instructions.length; i += maxInstructionsPerTx) {
        const instructionChunk = instructions.slice(i, i + maxInstructionsPerTx);
        
        const transaction = new Transaction();
        
        // Add compute budget instruction for priority fees
        if (instructionChunk.some(instr => instr.priority > 2)) {
          transaction.add(
            ComputeBudgetProgram.setComputeUnitPrice({
              microLamports: 20000 // Base fee + priority
            })
          );
        }
        
        // Add all instructions in this chunk
        for (const instr of instructionChunk) {
          transaction.add(instr.instruction);
          
          // Update instruction status
          this.pendingInstructions.set(instr.id, {
            ...instr,
            status: InstructionStatus.BUNDLED,
            bundleId: bundle.id
          });
        }
        
        bundle.addTransaction(transaction, walletIndex);
      }
    }
    
    if (bundle.transactions.length === 0) {
      throw new Error('Failed to create any valid transactions for the bundle');
    }
    
    this.bundles.push(bundle);
    console.log(`Created bundle ${bundle.id} with ${bundle.transactions.length} transactions`);
    
    return bundle.id;
  }
  
  async executeBundle(bundleId: string): Promise<BundleExecutionResult> {
    const bundle = this.bundles.find(b => b.id === bundleId);
    if (!bundle) {
      throw new Error(`Bundle not found: ${bundleId}`);
    }
    
    if (bundle.status !== 'pending') {
      throw new Error(`Bundle already ${bundle.status}`);
    }
    
    const result: BundleExecutionResult = {
      bundleId,
      startTime: Date.now(),
      endTime: 0,
      success: false,
      transactionResults: []
    };
    
    try {
      bundle.status = 'executing';
      
      // Execute each transaction
      for (const { walletIndex, transaction } of bundle.transactions) {
        const wallet = await this.walletManager.getWallet(walletIndex);
        if (!wallet) {
          result.transactionResults.push({
            walletIndex,
            success: false,
            error: 'Wallet not found'
          });
          continue;
        }
        
        try {
          // Get recent blockhash
          const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash();
          transaction.recentBlockhash = blockhash;
          transaction.feePayer = wallet.publicKey;
          
          // Sign with the appropriate wallet
          transaction.sign(wallet);
          
          // Send transaction
          const signature = await sendAndConfirmTransaction(
            this.connection,
            transaction,
            [wallet],
            { commitment: this.commitment }
          );
          
          result.transactionResults.push({
            walletIndex,
            signature,
            success: true
          });
          
          // Update status for instructions in this transaction
          for (const [id, instruction] of this.pendingInstructions.entries()) {
            if (instruction.bundleId === bundleId && instruction.walletIndex === walletIndex) {
              this.pendingInstructions.set(id, {
                ...instruction,
                status: InstructionStatus.EXECUTED,
                executedAt: Date.now()
              });
            }
          }
          
          console.log(`Transaction executed for wallet ${walletIndex}: ${signature}`);
          
        } catch (error) {
          console.error(`Error executing transaction for wallet ${walletIndex}:`, error);
          
          result.transactionResults.push({
            walletIndex,
            success: false,
            error: error.message
          });
          
          // Update status for instructions in this transaction
          for (const [id, instruction] of this.pendingInstructions.entries()) {
            if (instruction.bundleId === bundleId && instruction.walletIndex === walletIndex) {
              this.pendingInstructions.set(id, {
                ...instruction,
                status: InstructionStatus.FAILED,
                error: error.message
              });
            }
          }
        }
      }
      
      // Check overall success
      result.success = result.transactionResults.some(r => r.success);
      
      if (result.success) {
        bundle.status = 'completed';
        bundle.executedAt = Date.now();
      } else {
        bundle.status = 'failed';
        bundle.errorMessage = 'All transactions failed';
      }
      
    } catch (error) {
      console.error(`Error executing bundle ${bundleId}:`, error);
      bundle.status = 'failed';
      bundle.errorMessage = error.message;
      result.error = error.message;
    }
    
    result.endTime = Date.now();
    this.executionResults.set(bundleId, result);
    
    return result;
  }
  
  setExecutionPriority(bundleId: string, priority: 'normal' | 'high' | 'maximum'): void {
    const bundle = this.bundles.find(b => b.id === bundleId);
    if (!bundle) {
      throw new Error(`Bundle not found: ${bundleId}`);
    }
    
    if (bundle.status !== 'pending') {
      throw new Error(`Cannot modify priority of a ${bundle.status} bundle`);
    }
    
    // Apply priority fee to all transactions in the bundle
    for (const { transaction } of bundle.transactions) {
      // Remove any existing compute budget instructions
      transaction.instructions = transaction.instructions.filter(
        instr => !instr.programId.equals(ComputeBudgetProgram.programId)
      );
      
      // Add new compute budget instruction based on priority
      let microLamports: number;
      switch (priority) {
        case 'maximum':
          microLamports = 50000;
          break;
        case 'high':
          microLamports = 25000;
          break;
        case 'normal':
        default:
          microLamports = 10000;
          break;
      }
      
      transaction.instructions.unshift(
        ComputeBudgetProgram.setComputeUnitPrice({
          microLamports
        })
      );
    }
    
    console.log(`Set bundle ${bundleId} priority to ${priority}`);
  }
  
  async getBundleStatus(bundleId: string): Promise<Bundle | null> {
    return this.bundles.find(b => b.id === bundleId) || null;
  }
  
  async getAllBundles(): Promise<Bundle[]> {
    return [...this.bundles];
  }
  
  async getBundleResult(bundleId: string): Promise<BundleExecutionResult | null> {
    return this.executionResults.get(bundleId) || null;
  }
  
  async getPendingInstructionsCount(): Promise<number> {
    return Array.from(this.pendingInstructions.values())
      .filter(i => i.status === InstructionStatus.PENDING)
      .length;
  }
  
  async getOptimalWallet(): Promise<number> {
    // Find the wallet with the highest balance and least activity
    const walletBalances = await this.walletManager.balanceCheck();
    
    // Count pending instructions by wallet
    const instructionCounts = new Map<number, number>();
    for (const instruction of this.pendingInstructions.values()) {
      if (instruction.status === InstructionStatus.PENDING) {
        const count = instructionCounts.get(instruction.walletIndex) || 0;
        instructionCounts.set(instruction.walletIndex, count + 1);
      }
    }
    
    // Sort wallets by balance and instruction count
    const walletIndices = Array.from(walletBalances.keys());
    walletIndices.sort((a, b) => {
      // First prioritize wallets with fewer pending instructions
      const aCount = instructionCounts.get(a) || 0;
      const bCount = instructionCounts.get(b) || 0;
      if (aCount !== bCount) {
        return aCount - bCount;
      }
      
      // Then prioritize wallets with higher balances
      const aBalance = walletBalances.get(a) || 0;
      const bBalance = walletBalances.get(b) || 0;
      return bBalance - aBalance;
    });
    
    return walletIndices[0] || 0;
  }
}

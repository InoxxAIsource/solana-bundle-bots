import { Connection, PublicKey } from '@solana/web3.js';
import {
  DexInfo,
  SOLANA_DEXES,
  TokenInfo,
  ArbitrageOpportunity,
  getPriceQuote,
  getArbitrageInstructions
} from '../utils/dex-utils';
import { BundleExecutionManager } from '../bundle-manager';
import { WalletManager } from '../wallet-manager';

export class ArbitrageDetector {
  private connection: Connection;
  private bundleManager: BundleExecutionManager;
  private walletManager: WalletManager;
  
  constructor(
    connection: Connection,
    bundleManager: BundleExecutionManager,
    walletManager: WalletManager,
    private config: {
      minProfitPercentage: number;
      maxSlippage: number;
      gasCostEstimateSOL: number;
      monitoringInterval: number; // In milliseconds
      enabledTokens: TokenInfo[];
      enabledDexes: string[];
    }
  ) {
    this.connection = connection;
    this.bundleManager = bundleManager;
    this.walletManager = walletManager;
  }
  
  /**
   * Start monitoring for arbitrage opportunities
   */
  async startMonitoring(): Promise<void> {
    console.log('Starting arbitrage monitoring...');
    
    // Set up interval to scan for opportunities
    setInterval(async () => {
      try {
        const opportunities = await this.scanForArbitrageOpportunities();
        
        // Filter profitable opportunities
        const profitableOpportunities = opportunities.filter(
          op => op.profitPercentage >= this.config.minProfitPercentage
        );
        
        // Sort by profit percentage (highest first)
        profitableOpportunities.sort((a, b) => b.profitPercentage - a.profitPercentage);
        
        // Execute the most profitable opportunity if any exist
        if (profitableOpportunities.length > 0) {
          const bestOpportunity = profitableOpportunities[0];
          console.log(`Found profitable arbitrage: ${bestOpportunity.profitPercentage.toFixed(2)}% profit`);
          
          await this.executeArbitrage(bestOpportunity);
        }
      } catch (error) {
        console.error('Error in arbitrage monitoring:', error);
      }
    }, this.config.monitoringInterval);
  }
  
  /**
   * Scan for arbitrage opportunities across supported DEXes
   */
  async scanForArbitrageOpportunities(): Promise<ArbitrageOpportunity[]> {
    const opportunities: ArbitrageOpportunity[] = [];
    
    // Get filtered DEXes
    const dexes = SOLANA_DEXES.filter(
      dex => this.config.enabledDexes.includes(dex.name)
    );
    
    // Check for arbitrage between each pair of tokens across DEXes
    for (let i = 0; i < this.config.enabledTokens.length; i++) {
      const tokenA = this.config.enabledTokens[i];
      
      for (let j = 0; j < this.config.enabledTokens.length; j++) {
        // Skip same token
        if (i === j) continue;
        
        const tokenB = this.config.enabledTokens[j];
        
        // Check triangular arbitrage: tokenA -> tokenB -> tokenA
        const triangularOpportunities = await this.checkTriangularArbitrage(
          tokenA,
          tokenB,
          dexes
        );
        
        opportunities.push(...triangularOpportunities);
      }
    }
    
    return opportunities;
  }
  
  /**
   * Check for triangular arbitrage opportunities: tokenA -> tokenB -> tokenA
   */
  private async checkTriangularArbitrage(
    tokenA: TokenInfo,
    tokenB: TokenInfo,
    dexes: DexInfo[]
  ): Promise<ArbitrageOpportunity[]> {
    const opportunities: ArbitrageOpportunity[] = [];
    const testAmount = 100; // Amount of tokenA to test with
    
    for (const dex1 of dexes) {
      try {
        // Get quote for tokenA -> tokenB on dex1
        const quote1 = await getPriceQuote(
          this.connection,
          dex1,
          tokenA,
          tokenB,
          testAmount
        );
        
        // Check other DEXes for return path
        for (const dex2 of dexes) {
          try {
            // Get quote for tokenB -> tokenA on dex2
            const quote2 = await getPriceQuote(
              this.connection,
              dex2,
              tokenB,
              tokenA,
              quote1.outputAmount.amount
            );
            
            // Calculate profit
            const profit = quote2.outputAmount.amount - testAmount;
            const profitPercentage = (profit / testAmount) * 100;
            
            // Estimate gas cost in tokenA
            const gasCostInTokenA = this.config.gasCostEstimateSOL; // Simplified assumption
            
            // Calculate net profit
            const netProfit = profit - gasCostInTokenA;
            
            // If profitable after gas costs, add to opportunities
            if (netProfit > 0) {
              opportunities.push({
                profit: {
                  amount: profit,
                  token: tokenA
                },
                profitPercentage,
                inputAmount: {
                  amount: testAmount,
                  token: tokenA
                },
                route: [
                  {
                    token: tokenA,
                    dex: dex1.name,
                    expectedOutput: quote1.outputAmount
                  },
                  {
                    token: tokenB,
                    dex: dex2.name,
                    expectedOutput: quote2.outputAmount
                  },
                  {
                    token: tokenA,
                    dex: '',
                    expectedOutput: {
                      amount: quote2.outputAmount.amount,
                      token: tokenA
                    }
                  }
                ],
                estimatedGasCost: gasCostInTokenA,
                netProfit: {
                  amount: netProfit,
                  token: tokenA
                }
              });
            }
          } catch (error) {
            console.debug(`Error checking return path on ${dex2.name}:`, error.message);
          }
        }
      } catch (error) {
        console.debug(`Error checking initial path on ${dex1.name}:`, error.message);
      }
    }
    
    return opportunities;
  }
  
  /**
   * Execute an arbitrage opportunity
   */
  async executeArbitrage(opportunity: ArbitrageOpportunity): Promise<string> {
    // Get optimal wallet for arbitrage
    const walletIndex = await this.bundleManager.getOptimalWallet();
    
    // Get wallet public key
    const wallet = await this.walletManager.getWalletPublicKey(walletIndex);
    if (!wallet) {
      throw new Error(`Wallet not found at index ${walletIndex}`);
    }
    
    // Calculate optimal amount for maximum profit (simplified)
    const scaleFactor = this.calculateOptimalScaleFactor(opportunity);
    const amount = opportunity.inputAmount.amount * scaleFactor;
    
    // Create arbitrage instructions
    const instructions = await getArbitrageInstructions(
      this.connection,
      {
        ...opportunity,
        inputAmount: {
          ...opportunity.inputAmount,
          amount
        }
      },
      wallet
    );
    
    // Add instructions to bundle manager with high priority
    for (const instruction of instructions) {
      await this.bundleManager.addInstruction(walletIndex, instruction, 4);
    }
    
    // Create and execute bundle
    const bundleId = await this.bundleManager.createBundle({
      privacyLevel: 'maximum',
      groupByTarget: true
    });
    
    // Set high priority for quick execution
    this.bundleManager.setExecutionPriority(bundleId, 'maximum');
    
    // Execute bundle immediately
    await this.bundleManager.executeBundle(bundleId);
    
    console.log(`Executed arbitrage opportunity with bundle ID: ${bundleId}`);
    
    return bundleId;
  }
  
  /**
   * Calculate optimal scale factor for maximum profit
   * This is a simplified version - a real implementation would use calculus
   * to find the maximum profit point accounting for price impact
   */
  private calculateOptimalScaleFactor(opportunity: ArbitrageOpportunity): number {
    // Simple scaling based on profit percentage
    // In a real system, this would be much more sophisticated
    if (opportunity.profitPercentage > 5) {
      return 10; // Scale by 10x for very profitable opportunities
    } else if (opportunity.profitPercentage > 2) {
      return 5; // Scale by 5x for moderately profitable opportunities
    } else if (opportunity.profitPercentage > 1) {
      return 2; // Scale by 2x for barely profitable opportunities
    }
    
    return 1; // No scaling for marginally profitable opportunities
  }
}

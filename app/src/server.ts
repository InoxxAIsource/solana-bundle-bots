// MEV Protection Routes
app.post('/api/mev-protection', async (req, res) => {
  try {
    const { walletIndex, instructions, priority } = req.body;
    
    if (typeof walletIndex !== 'number' || walletIndex < 0 || walletIndex >= 20) {
      return res.status(400).json({ success: false, error: 'Invalid wallet index' });
    }
    
    if (!Array.isArray(instructions)) {
      return res.status(400).json({ success: false, error: 'Instructions must be an array' });
    }
    
    // Convert instructions from JSON to TransactionInstruction objects
    const txInstructions = instructions.map(instr => {
      return new TransactionInstruction({
        programId: new PublicKey(instr.programId),
        keys: instr.keys.map(k => ({
          pubkey: new PublicKey(k.pubkey),
          isSigner: !!k.isSigner,
          isWritable: !!k.isWritable
        })),
        data: Buffer.from(instr.data, 'base64')
      });
    });
    
    const bundleId = await mevProtection.protectTransaction(
      walletIndex,
      txInstructions,
      priority || 3
    );
    
    res.json({ success: true, data: { bundleId } });
  } catch (error) {
    console.error('Error applying MEV protection:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Arbitrage Routes
app.post('/api/arbitrage/start', async (req, res) => {
  try {
    await arbitrageDetector.startMonitoring();
    res.json({ success: true, message: 'Arbitrage monitoring started' });
  } catch (error) {
    console.error('Error starting arbitrage monitoring:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/arbitrage/opportunities', async (req, res) => {
  try {
    const opportunities = await arbitrageDetector.scanForArbitrageOpportunities();
    res.json({ success: true, data: opportunities });
  } catch (error) {
    console.error('Error scanning for arbitrage opportunities:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Copy Trading Routes
app.post('/api/copy-trading/wallets', async (req, res) => {
  try {
    const { address, label, settings } = req.body;
    
    if (!address) {
      return res.status(400).json({ success: false, error: 'Wallet address is required' });
    }
    
    if (!label) {
      return res.status(400).json({ success: false, error: 'Wallet label is required' });
    }
    
    await copyTrading.addWalletToMonitor(address, label, settings);
    
    res.json({ success: true, message: `Wallet ${label} added to copy trading` });
  } catch (error) {
    console.error('Error adding wallet to copy trading:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/copy-trading/wallets', async (req, res) => {
  try {
    const wallets = copyTrading.getMonitoredWallets();
    res.json({ success: true, data: wallets });
  } catch (error) {
    console.error('Error getting monitored wallets:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.delete('/api/copy-trading/wallets/:address', async (req, res) => {
  try {
    const { address } = req.params;
    
    copyTrading.removeWalletFromMonitor(address);
    
    res.json({ success: true, message: `Wallet ${address} removed from copy trading` });
  } catch (error) {
    console.error('Error removing wallet from copy trading:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.put('/api/copy-trading/wallets/:address/settings', async (req, res) => {
  try {
    const { address } = req.params;
    const { settings } = req.body;
    
    copyTrading.updateWalletSettings(address, settings);
    
    res.json({ success: true, message: `Settings updated for wallet ${address}` });
  } catch (error) {
    console.error('Error updating wallet settings:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/copy-trading/trades', async (req, res) => {
  try {
    const { status } = req.query;
    
    let trades = [];
    if (status === 'pending') {
      trades = copyTrading.getPendingTrades();
    } else if (status === 'executed') {
      trades = copyTrading.getExecutedTrades();
    } else {
      trades = [
        ...copyTrading.getPendingTrades(),
        ...copyTrading.getExecutedTrades()
      ];
    }
    
    res.json({ success: true, data: trades });
  } catch (error) {
    console.error('Error getting copy trades:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

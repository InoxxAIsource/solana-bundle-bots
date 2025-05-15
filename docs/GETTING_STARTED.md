# Getting Started with Solana Bundle Bots

This guide will walk you through the process of setting up and running your own Solana Bundle Bots system that manages 20 wallets with advanced transaction bundling capabilities.

## Step 1: Clone the Repository

```bash
git clone https://github.com/InoxxAIsource/solana-bundle-bots.git
cd solana-bundle-bots
Step 2: Project Setup
First, ensure you have the prerequisites installed:

Node.js (v16+)
Rust and Cargo
Solana CLI tools
Docker (optional, for containerized deployment)

Install the project dependencies:
bashnpm install
Step 3: Configure Environment
The project uses environment variables for configuration. Copy the example environment file and edit it:
bashcp .env.example .env
Edit the .env file with your preferred editor and set the following variables:
# Solana Network Configuration
SOLANA_RPC_URL=https://api.devnet.solana.com
SOLANA_WEBSOCKET_URL=wss://api.devnet.solana.com
NETWORK=devnet  # mainnet, testnet, or devnet

# Wallet Configuration
MASTER_WALLET_PATH=./keys/master-wallet.json
ADMIN_KEYPAIR_PATH=./keys/admin-wallet.json

# Bundle Program Configuration
BUNDLE_PROGRAM_ID=YourDeployedProgramId

# Server Configuration
PORT=3001
FRONTEND_URL=http://localhost:3000

# Security Configuration
JWT_SECRET=your-jwt-secret-key
API_RATE_LIMIT=100

# Database Configuration (if using)
DATABASE_URL=postgresql://username:password@localhost:5432/bundlebots
Step 4: Generate Wallets
Run the wallet setup script to generate and fund 20 wallets:
bashnpm run setup-wallets
This script will:

Create a master wallet if it doesn't exist
Generate 20 individual wallets
Fund them with SOL from the master wallet
Save wallet information securely

Step 5: Deploy the Solana Program
Deploy the bundle manager program to your preferred Solana cluster:
bashnpm run deploy-program
After deployment, the program ID will be displayed. Copy this ID and update the BUNDLE_PROGRAM_ID in your .env file.
Step 6: Start the Backend Server
Launch the API server that manages wallets and bundles:
bashnpm run server
The server will start on the port specified in your .env file (default: 3001).
Step 7: Start the Frontend Application
In a new terminal, navigate to the frontend directory and start the React application:
bashcd app/frontend
npm install
npm start
The frontend will be available at http://localhost:3000.
Step 8: Create Your First Bundle
Once the system is running, you can create your first bundle:

Navigate to the dashboard at http://localhost:3000
Go to "Create Instruction" and add instructions to specific wallets
Navigate to "Bundles" and click "Create New Bundle"
Select the bundle and click "Execute" to send the bundled transactions

Step 9: Monitoring and Management
The dashboard provides real-time monitoring of:

Wallet balances and status
Bundle execution status
Transaction history
Performance metrics

Advanced Configuration
Wallet Thresholds
You can customize balance thresholds for each wallet in config/wallet-thresholds.json:
json{
  "default": {
    "min": 0.01,
    "target": 0.05,
    "max": 0.1
  },
  "wallets": {
    "0": {
      "min": 0.02,
      "target": 0.08,
      "max": 0.15
    }
  }
}
Priority Fee Settings
Configure priority fee calculation in config/priority-fees.json:
json{
  "baseFee": 5000,
  "maxFee": 50000,
  "congestionMultiplier": 1.5,
  "urgentMultiplier": 2.0
}
MEV Protection
Enable and configure MEV protection in config/mev-protection.json:
json{
  "enabled": true,
  "strategies": ["privateRpc", "priorityFees", "obfuscation"],
  "privateRpcEndpoint": "https://your-private-rpc.example.com"
}
Docker Deployment
For simplified deployment, use Docker Compose:
bashdocker-compose up -d
This will start all necessary services in containers.
Next Steps

Add Agent Communication: Implement the agent-to-agent communication protocol
Set Up Monitoring: Configure alerts for wallet balances and bundle execution
Optimize Fee Strategies: Fine-tune priority fee calculations
Add Custom Strategies: Implement your own bundling strategies

Troubleshooting
Common Issues

RPC Connection Errors: Ensure your Solana RPC URL is valid and accessible
Wallet Funding Failures: Check that your master wallet has sufficient SOL
Bundle Execution Errors: Verify program ID and instruction parameters

Debug Mode
Enable debug mode for verbose logging:
bashDEBUG=bundlebots:* npm run server

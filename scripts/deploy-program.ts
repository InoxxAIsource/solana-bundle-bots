import { config } from 'dotenv';
import { exec } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as util from 'util';

// Convert exec to promise-based
const execPromise = util.promisify(exec);

// Load environment variables
config();

async function deployProgram() {
  console.log('Deploying Solana program...');
  
  const programDir = path.join(__dirname, '../programs/bundle-manager');
  
  try {
    // Check if the program directory exists
    if (!fs.existsSync(programDir)) {
      throw new Error(`Program directory not found: ${programDir}`);
    }
    
    // Check if Cargo.toml exists
    if (!fs.existsSync(path.join(programDir, 'Cargo.toml'))) {
      throw new Error('Cargo.toml not found. Ensure you have created the program files.');
    }
    
    // Build the program
    console.log('Building program...');
    await execPromise('cargo build-bpf', { cwd: programDir });
    
    // Deploy the program
    console.log('Deploying program to Solana...');
    const { stdout, stderr } = await execPromise(
      'solana program deploy ' +
      '--keypair ../../keys/program-keypair.json ' +
      '--url ' + (process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com') + ' ' +
      'target/deploy/bundle_manager.so',
      { cwd: programDir }
    );
    
    if (stderr) {
      console.error('Deploy stderr:', stderr);
    }
    
    console.log('Program deployed successfully!');
    console.log('------------------------------');
    console.log(stdout);
    
    // Extract program ID
    const programIdMatch = stdout.match(/Program Id: ([a-zA-Z0-9]{32,44})/);
    if (programIdMatch && programIdMatch[1]) {
      const programId = programIdMatch[1];
      console.log(`\nProgram ID: ${programId}`);
      console.log('\nUpdate your .env file with:');
      console.log(`BUNDLE_PROGRAM_ID=${programId}`);
    }
    
  } catch (error) {
    console.error('Error deploying program:', error);
    process.exit(1);
  }
}

deployProgram().catch(console.error);

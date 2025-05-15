use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint,
    entrypoint::ProgramResult,
    msg,
    program_error::ProgramError,
    pubkey::Pubkey,
    system_instruction,
    program::{invoke, invoke_signed},
    sysvar::{rent::Rent, Sysvar},
    clock::Clock,
};
use borsh::{BorshDeserialize, BorshSerialize};

// Define the program ID
solana_program::declare_id!("Replace_with_your_program_id_after_deployment");

#[derive(BorshSerialize, BorshDeserialize, Debug)]
pub enum BundleInstruction {
    /// Initialize a new bundle manager
    /// 0. `[signer]` The authority account
    /// 1. `[writable]` The bundle manager account to initialize
    /// 2. `[]` System program
    Initialize {
        bundle_size: u8,
        priority_fee_multiplier: u8,
    },
    
    /// Create a new bundle
    /// 0. `[]` The bundle manager account
    /// 1. `[writable]` The bundle account to create
    /// 2. `[signer]` The authority account that will own this bundle
    /// 3. `[]` System program
    CreateBundle {
        wallet_indexes: Vec<u8>,
        instructions_per_wallet: Vec<u8>,
    },
    
    /// Add an instruction to a bundle
    /// 0. `[writable]` The bundle account
    /// 1. `[writable]` The instruction account to create
    /// 2. `[signer]` The authority account
    /// 3. `[]` System program
    AddInstruction {
        wallet_index: u8,
        instruction_data: Vec<u8>,
        accounts: Vec<InstructionAccountMeta>,
    },
    
    /// Execute a bundle
    /// 0. `[writable]` The bundle manager account
    /// 1. `[writable]` The bundle account
    /// 2. `[]` Recent blockhash info
    /// 3. `[signer]` The authority account
    /// 4. `[]` System program
    ExecuteBundle {
        max_compute_units: u32,
    },
    
    /// Set manager status (pause/unpause)
    /// 0. `[writable]` The bundle manager account
    /// 1. `[signer]` The authority account
    SetManagerStatus {
        is_paused: bool,
    },
}

#[derive(BorshSerialize, BorshDeserialize, Debug, Clone)]
pub struct InstructionAccountMeta {
    pub pubkey: Pubkey,
    pub is_signer: bool,
    pub is_writable: bool,
}

#[derive(BorshSerialize, BorshDeserialize, Debug)]
pub enum BundleStatus {
    Created,
    Executing,
    Executed,
    Failed,
}

#[derive(BorshSerialize, BorshDeserialize, Debug)]
pub struct BundleManager {
    pub authority: Pubkey,
    pub bundle_size: u8,
    pub priority_fee_multiplier: u8,
    pub active_bundles: u16,
    pub total_bundles_executed: u32,
    pub is_paused: bool,
    pub bundle_seed: u32,
}

#[derive(BorshSerialize, BorshDeserialize, Debug)]
pub struct Bundle {
    pub manager: Pubkey,
    pub authority: Pubkey,
    pub bundle_id: u32,
    pub created_at: i64,
    pub execution_started_at: i64,
    pub execution_completed_at: i64,
    pub wallet_count: u8,
    pub wallet_indexes: Vec<u8>,
    pub instructions_per_wallet: Vec<u8>,
    pub status: BundleStatus,
    pub priority_fee: u16,
}

#[derive(BorshSerialize, BorshDeserialize, Debug)]
pub struct BundleInstruction {
    pub bundle: Pubkey,
    pub wallet_index: u8,
    pub instruction_data: Vec<u8>,
    pub accounts: Vec<InstructionAccountMeta>,
    pub executed: bool,
}

// Entry point is the function called when the program is invoked
entrypoint!(process_instruction);

// Program entrypoint's implementation
pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    let instruction = BundleInstruction::try_from_slice(instruction_data)
        .map_err(|_| ProgramError::InvalidInstructionData)?;

    match instruction {
        BundleInstruction::Initialize { bundle_size, priority_fee_multiplier } => {
            process_initialize(program_id, accounts, bundle_size, priority_fee_multiplier)
        },
        BundleInstruction::CreateBundle { wallet_indexes, instructions_per_wallet } => {
            process_create_bundle(program_id, accounts, wallet_indexes, instructions_per_wallet)
        },
        BundleInstruction::AddInstruction { wallet_index, instruction_data, accounts: instr_accounts } => {
            process_add_instruction(program_id, accounts, wallet_index, instruction_data, instr_accounts)
        },
        BundleInstruction::ExecuteBundle { max_compute_units } => {
            process_execute_bundle(program_id, accounts, max_compute_units)
        },
        BundleInstruction::SetManagerStatus { is_paused } => {
            process_set_manager_status(program_id, accounts, is_paused)
        },
    }
}

fn process_initialize(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    bundle_size: u8,
    priority_fee_multiplier: u8,
) -> ProgramResult {
    let account_info_iter = &mut accounts.iter();
    
    let bundle_manager_account = next_account_info(account_info_iter)?;
    let authority = next_account_info(account_info_iter)?;
    let system_program = next_account_info(account_info_iter)?;
    
    // Check that the account is owned by our program
    if bundle_manager_account.owner != program_id {
        // If it's not owned by us yet, we need to create it
        if !authority.is_signer {
            return Err(ProgramError::MissingRequiredSignature);
        }
        
        // Create the bundle manager account
        let rent = Rent::get()?;
        let space = std::mem::size_of::<BundleManager>();
        let lamports = rent.minimum_balance(space);
        
        invoke(
            &system_instruction::create_account(
                authority.key,
                bundle_manager_account.key,
                lamports,
                space as u64,
                program_id,
            ),
            &[
                authority.clone(),
                bundle_manager_account.clone(),
                system_program.clone(),
            ],
        )?;
    }
    
    // Initialize the bundle manager data
    let bundle_manager = BundleManager {
        authority: *authority.key,
        bundle_size,
        priority_fee_multiplier,
        active_bundles: 0,
        total_bundles_executed: 0,
        is_paused: false,
        bundle_seed: 0,
    };
    
    bundle_manager.serialize(&mut *bundle_manager_account.data.borrow_mut())?;
    
    msg!("Bundle Manager initialized with bundle size {} and priority fee multiplier {}",
        bundle_size, priority_fee_multiplier);
    
    Ok(())
}

fn process_create_bundle(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    wallet_indexes: Vec<u8>,
    instructions_per_wallet: Vec<u8>,
) -> ProgramResult {
    let account_info_iter = &mut accounts.iter();
    
    let bundle_manager_account = next_account_info(account_info_iter)?;
    let bundle_account = next_account_info(account_info_iter)?;
    let authority = next_account_info(account_info_iter)?;
    let system_program = next_account_info(account_info_iter)?;
    
    // Check that the bundle manager is owned by our program
    if bundle_manager_account.owner != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }
    
    // Deserialize the bundle manager
    let mut bundle_manager = BundleManager::try_from_slice(&bundle_manager_account.data.borrow())
        .map_err(|_| ProgramError::InvalidAccountData)?;
    
    // Check if manager is paused
    if bundle_manager.is_paused {
        return Err(ProgramError::Custom(1)); // ManagerPaused
    }
    
    // Validate wallet_indexes and instructions_per_wallet
    if wallet_indexes.len() > 20 {
        return Err(ProgramError::Custom(2)); // TooManyWallets
    }
    
    if wallet_indexes.len() != instructions_per_wallet.len() {
        return Err(ProgramError::Custom(3)); // InvalidInstructionCount
    }
    
    // Check that the authority is a signer
    if !authority.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    
    // Create the bundle account if needed
    if bundle_account.owner != program_id {
        let rent = Rent::get()?;
        let space = std::mem::size_of::<Bundle>() + 100; // Extra space for vectors
        let lamports = rent.minimum_balance(space);
        
        invoke(
            &system_instruction::create_account(
                authority.key,
                bundle_account.key,
                lamports,
                space as u64,
                program_id,
            ),
            &[
                authority.clone(),
                bundle_account.clone(),
                system_program.clone(),
            ],
        )?;
    }
    
    // Initialize the bundle data
    let clock = Clock::get()?;
    let bundle = Bundle {
        manager: *bundle_manager_account.key,
        authority: *authority.key,
        bundle_id: bundle_manager.bundle_seed,
        created_at: clock.unix_timestamp,
        execution_started_at: 0,
        execution_completed_at: 0,
        wallet_count: wallet_indexes.len() as u8,
        wallet_indexes,
        instructions_per_wallet,
        status: BundleStatus::Created,
        priority_fee: 0,
    };
    
    bundle.serialize(&mut *bundle_account.data.borrow_mut())?;
    
    // Update the bundle manager
    bundle_manager.active_bundles += 1;
    bundle_manager.bundle_seed += 1;
    bundle_manager.serialize(&mut *bundle_manager_account.data.borrow_mut())?;
    
    msg!("Bundle {} created with {} wallets", bundle.bundle_id, bundle.wallet_count);
    
    Ok(())
}

// Implementation of other methods would follow a similar pattern
// For brevity, we've implemented only the first two methods
// A complete implementation would include all the methods

fn process_add_instruction(
    _program_id: &Pubkey,
    _accounts: &[AccountInfo],
    _wallet_index: u8,
    _instruction_data: Vec<u8>,
    _instr_accounts: Vec<InstructionAccountMeta>,
) -> ProgramResult {
    msg!("AddInstruction: Not fully implemented in this example");
    Ok(())
}

fn process_execute_bundle(
    _program_id: &Pubkey,
    _accounts: &[AccountInfo],
    _max_compute_units: u32,
) -> ProgramResult {
    msg!("ExecuteBundle: Not fully implemented in this example");
    Ok(())
}

fn process_set_manager_status(
    _program_id: &Pubkey,
    _accounts: &[AccountInfo],
    _is_paused: bool,
) -> ProgramResult {
    msg!("SetManagerStatus: Not fully implemented in this example");
    Ok(())
}

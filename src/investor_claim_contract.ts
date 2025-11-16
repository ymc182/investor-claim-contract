import { NearBindgen, near, call, view, initialize, NearPromise, UnorderedMap } from 'near-sdk-js';

const ONE_YOCTO = BigInt(1);
const NO_DEPOSIT = BigInt(0);
const GAS_FOR_FT_TRANSFER = BigInt('50000000000000'); // 50 Tgas
const GAS_FOR_RESOLVE = BigInt('20000000000000'); // 20 Tgas
const BASIS_POINTS_DENOMINATOR = BigInt(10_000);

type GroupConfigInput = {
  id: string;
  cliff_duration_ns: string;
  vesting_duration_ns: string;
  initial_unlock_basis_points?: string;
};

type GroupConfigStored = {
  cliffDurationNs: string;
  vestingDurationNs: string;
  initialUnlockBasisPoints: string;
};

type InvestorInput = {
  account_id: string;
  group_id: string;
  amount: string;
};

type InvestorRecord = {
  groupId: string;
  totalAllocation: string;
  claimed: string;
};

type ClaimArgs = {
  account_id?: string;
};

type WithdrawArgs = {
  amount: string;
  recipient?: string;
  memo?: string;
};

type FtOnTransferArgs = {
  sender_id: string;
  amount: string;
  msg: string;
};

type InitialClaimConfigInput = {
  initial_claim_basis_points?: string;
  initial_claim_available_timestamp_ns?: string;
};


@NearBindgen({ requireInit: true })
class InvestorVesting {
  owner: string = '';
  tokenAccountId: string = '';
  tgeTimestampNs: string = '0';
  initialClaimBasisPoints: string = '0';
  initialClaimAvailableTimestampNs: string = '0';
  totalDeposited: string = '0';
  totalClaimed: string = '0';
  totalWithdrawn: string = '0';
  poolBalance: string = '0';
  groups: UnorderedMap<GroupConfigStored> = new UnorderedMap<GroupConfigStored>('groups:');
  investors: UnorderedMap<InvestorRecord> = new UnorderedMap<InvestorRecord>('investors:');

  @initialize({})
  init({
    owner,
    token_account_id,
    tge_timestamp_ns,
    groups,
    initial_claim_basis_points,
    initial_claim_available_timestamp_ns,
  }: {
    owner?: string;
    token_account_id: string;
    tge_timestamp_ns: string;
    groups: GroupConfigInput[];
    initial_claim_basis_points?: string;
    initial_claim_available_timestamp_ns?: string;
  }): void {
    if (this.owner !== '') {
      throw new Error('Contract already initialized');
    }
    if (!token_account_id) {
      throw new Error('token_account_id is required');
    }
    if (!tge_timestamp_ns) {
      throw new Error('tge_timestamp_ns is required');
    }

    this.owner = owner ?? near.predecessorAccountId();
    this.tokenAccountId = token_account_id;
    this.tgeTimestampNs = tge_timestamp_ns;
    this.setInitialClaimConfig({
      initial_claim_basis_points,
      initial_claim_available_timestamp_ns,
    });
    this.setGroupsInternal(groups);
  }

  @call({})
  configure_groups({ groups }: { groups: GroupConfigInput[] }): void {
    this.assertOwner();
    this.setGroupsInternal(groups);
  }

  @call({})
  configure_initial_claim(args: InitialClaimConfigInput): void {
    this.assertOwner();
    if (
      !args ||
      (args.initial_claim_basis_points === undefined &&
        args.initial_claim_available_timestamp_ns === undefined)
    ) {
      throw new Error('At least one initial claim parameter must be provided');
    }
    this.setInitialClaimConfig(args);
  }

  @call({})
  upsert_investors({ investors }: { investors: InvestorInput[] }): void {
    this.assertOwner();
    if (!Array.isArray(investors) || investors.length === 0) {
      throw new Error('investors array required');
    }

    const seenAccounts = new Set<string>();

    for (const entry of investors) {
      if (!entry.account_id || !entry.group_id || !entry.amount) {
        throw new Error('Each investor must include account_id, group_id, and amount');
      }
      if (seenAccounts.has(entry.account_id)) {
        throw new Error(`Duplicate investor entry for ${entry.account_id}`);
      }
      seenAccounts.add(entry.account_id);
      const group = this.groups.get(entry.group_id);
      if (!group) {
        throw new Error(`Unknown group_id ${entry.group_id}`);
      }
      const amount = BigInt(entry.amount);
      if (amount <= BigInt(0)) {
        throw new Error('Investor amount must be positive');
      }

      const current = this.investors.get(entry.account_id);
      if (current) {
        const alreadyClaimed = BigInt(current.claimed);
        if (amount < alreadyClaimed) {
          throw new Error(`New allocation for ${entry.account_id} cannot be less than claimed amount`);
        }
        this.investors.set(entry.account_id, {
          groupId: entry.group_id,
          totalAllocation: amount.toString(),
          claimed: alreadyClaimed.toString(),
        });
      } else {
        this.investors.set(entry.account_id, {
          groupId: entry.group_id,
          totalAllocation: amount.toString(),
          claimed: '0',
        });
      }
    }
  }

  @call({ payableFunction: true })
  claim({ account_id }: ClaimArgs): NearPromise {
    this.assertOneYocto();
    const claimant = account_id ?? near.predecessorAccountId();
    const isSelfClaim = claimant === near.predecessorAccountId();
    if (!isSelfClaim && near.predecessorAccountId() !== this.owner) {
      throw new Error('Only owner can claim on behalf of investors');
    }

    const record = this.investors.get(claimant);
    if (!record) {
      throw new Error('No allocation found for this account');
    }

    const claimable = this.computeClaimable(claimant, BigInt(near.blockTimestamp()));
    if (claimable <= BigInt(0)) {
      throw new Error('Nothing to claim at this time');
    }

    if (claimable > BigInt(this.poolBalance)) {
      throw new Error('Insufficient available pool balance; try again later');
    }

    this.investors.set(claimant, {
      ...record,
      claimed: (BigInt(record.claimed) + claimable).toString(),
    });
    this.totalClaimed = (BigInt(this.totalClaimed) + claimable).toString();
    this.poolBalance = (BigInt(this.poolBalance) - claimable).toString();

    near.log(`Processing claim of ${claimable.toString()} tokens for ${claimant}`);

    const transfer = NearPromise.new(this.tokenAccountId).functionCall(
      'ft_transfer',
      JSON.stringify({
        receiver_id: claimant,
        amount: claimable.toString(),
        memo: `vesting-claim`,
      }),
      ONE_YOCTO,
      GAS_FOR_FT_TRANSFER,
    );

    const callback = NearPromise.new(near.currentAccountId()).functionCall(
      'on_claim_complete',
      JSON.stringify({
        account_id: claimant,
        amount: claimable.toString(),
      }),
      NO_DEPOSIT,
      GAS_FOR_RESOLVE,
    );

    return transfer.then(callback);
  }

  @call({ payableFunction: true })
  withdraw_unallocated({ amount, recipient, memo }: WithdrawArgs): NearPromise {
    this.assertOwner();
    this.assertOneYocto();
    if (!amount) {
      throw new Error('Amount is required');
    }
    const withdrawal = BigInt(amount);
    if (withdrawal <= BigInt(0)) {
      throw new Error('Withdrawal amount must be positive');
    }
    if (withdrawal > BigInt(this.poolBalance)) {
      throw new Error('Amount exceeds available pool balance');
    }

    const target = recipient ?? this.owner;
    this.poolBalance = (BigInt(this.poolBalance) - withdrawal).toString();
    this.totalWithdrawn = (BigInt(this.totalWithdrawn) + withdrawal).toString();

    near.log(`Withdrawing ${amount} tokens to ${target}`);

    const transfer = NearPromise.new(this.tokenAccountId).functionCall(
      'ft_transfer',
      JSON.stringify({
        receiver_id: target,
        amount,
        memo: memo ?? 'vesting-withdrawal',
      }),
      ONE_YOCTO,
      GAS_FOR_FT_TRANSFER,
    );

    const callback = NearPromise.new(near.currentAccountId()).functionCall(
      'on_withdraw_complete',
      JSON.stringify({
        recipient: target,
        amount,
      }),
      NO_DEPOSIT,
      GAS_FOR_RESOLVE,
    );

    return transfer.then(callback);
  }

  @call({})
  ft_on_transfer({ sender_id, amount, msg }: FtOnTransferArgs): string {
    this.assertTokenCaller();
    if (!amount) {
      throw new Error('Amount is required');
    }
    const deposit = BigInt(amount);
    if (deposit <= BigInt(0)) {
      throw new Error('Deposit amount must be positive');
    }

    this.poolBalance = (BigInt(this.poolBalance) + deposit).toString();
    this.totalDeposited = (BigInt(this.totalDeposited) + deposit).toString();

    near.log(`Received ${amount} tokens from ${sender_id}${msg ? ` (${msg})` : ''}`);
    return '0';
  }

  @call({ privateFunction: true })
  on_claim_complete({ account_id, amount }: { account_id: string; amount: string }): void {
    this.assertSelf();
    try {
      near.promiseResult(0);
    } catch (error) {
      const record = this.investors.get(account_id);
      if (!record) {
        throw new Error('Investor record missing during claim revert');
      }
      const tokenAmount = BigInt(amount);
      this.investors.set(account_id, {
        ...record,
        claimed: (BigInt(record.claimed) - tokenAmount).toString(),
      });
      this.totalClaimed = (BigInt(this.totalClaimed) - tokenAmount).toString();
      this.poolBalance = (BigInt(this.poolBalance) + tokenAmount).toString();
      near.log(`Token transfer failed for ${account_id}, reverting claim`);
      throw new Error('Token transfer failed');
    }
    near.log(`Claim completed for ${account_id}`);
  }

  @call({ privateFunction: true })
  on_withdraw_complete({ recipient, amount }: { recipient: string; amount: string }): void {
    this.assertSelf();
    try {
      near.promiseResult(0);
    } catch (error) {
      const tokenAmount = BigInt(amount);
      this.poolBalance = (BigInt(this.poolBalance) + tokenAmount).toString();
      this.totalWithdrawn = (BigInt(this.totalWithdrawn) - tokenAmount).toString();
      near.log(`Withdrawal transfer failed for ${recipient}, reverting state`);
      throw new Error('Token transfer failed');
    }
    near.log(`Withdrawal completed to ${recipient}`);
  }

  @view({})
  get_state(): {
    owner: string;
    token_account_id: string;
    tge_timestamp_ns: string;
    initial_claim_basis_points: string;
    initial_claim_available_timestamp_ns: string;
    total_deposited: string;
    total_claimed: string;
    total_withdrawn: string;
    pool_balance: string;
    groups: Record<string, GroupConfigStored>;
  } {
    return {
      owner: this.owner,
      token_account_id: this.tokenAccountId,
      tge_timestamp_ns: this.tgeTimestampNs,
      initial_claim_basis_points: this.initialClaimBasisPoints,
      initial_claim_available_timestamp_ns: this.initialClaimAvailableTimestampNs,
      total_deposited: this.totalDeposited,
      total_claimed: this.totalClaimed,
      total_withdrawn: this.totalWithdrawn,
      pool_balance: this.poolBalance,
      groups: this.serializeGroups(),
    };
  }

  @view({})
  get_investor({ account_id }: { account_id: string }): InvestorRecord | null {
    if (!account_id) {
      throw new Error('account_id is required');
    }
    return this.investors.get(account_id);
  }

  @view({})
  get_claimable({ account_id }: { account_id: string }): string {
    if (!account_id) {
      throw new Error('account_id is required');
    }
    return this.computeClaimable(account_id, BigInt(near.blockTimestamp())).toString();
  }

  private computeClaimable(accountId: string, timestamp: bigint): bigint {
    const record = this.investors.get(accountId);
    if (!record) {
      return BigInt(0);
    }
    const group = this.groups.get(record.groupId);
    if (!group) {
      return BigInt(0);
    }

    const total = BigInt(record.totalAllocation);
    const claimed = BigInt(record.claimed);
    if (total === claimed) {
      return BigInt(0);
    }

    const vestable = this.computeVestedAmount(total, group, timestamp);
    if (vestable <= claimed) {
      return BigInt(0);
    }
    return vestable - claimed;
  }

  private computeVestedAmount(
    total: bigint,
    group: GroupConfigStored,
    timestamp: bigint,
  ): bigint {
    const start = BigInt(this.tgeTimestampNs);
    const cliff = BigInt(group.cliffDurationNs);
    const vesting = BigInt(group.vestingDurationNs);
    const initialClaimStart = BigInt(this.initialClaimAvailableTimestampNs);
    const initialClaimBps = BigInt(this.initialClaimBasisPoints ?? '0');
    const postCliffBps = BigInt(group.initialUnlockBasisPoints ?? '0');

    const initialPortionRaw = (total * initialClaimBps) / BASIS_POINTS_DENOMINATOR;
    const initialPortion = initialPortionRaw > total ? total : initialPortionRaw;
    const remainingAfterInitial = total - initialPortion;
    const postCliffPortionRaw = (total * postCliffBps) / BASIS_POINTS_DENOMINATOR;
    const postCliffPortion =
      postCliffPortionRaw > remainingAfterInitial ? remainingAfterInitial : postCliffPortionRaw;
    const linearPortionBase = total - initialPortion - postCliffPortion;

    let vested = BigInt(0);
    if (timestamp >= initialClaimStart) {
      vested += initialPortion;
    }

    if (timestamp < start + cliff) {
      return vested > total ? total : vested;
    }

    if (vesting === BigInt(0)) {
      return total;
    }

    vested += postCliffPortion;
    const elapsed = timestamp - (start + cliff);
    if (elapsed >= vesting) {
      return total;
    }

    const linearVested = (linearPortionBase * elapsed) / vesting;
    vested += linearVested;
    return vested > total ? total : vested;
  }

  private setGroupsInternal(groups: GroupConfigInput[]): void {
    if (!Array.isArray(groups) || groups.length === 0) {
      throw new Error('groups must be a non-empty array');
    }
    const seen = new Set<string>();
    this.groups.clear();
    for (const group of groups) {
      if (!group.id) {
        throw new Error('group id is required');
      }
      if (seen.has(group.id)) {
        throw new Error(`Duplicate group id ${group.id}`);
      }
      seen.add(group.id);
      const cliff = BigInt(group.cliff_duration_ns);
      const vesting = BigInt(group.vesting_duration_ns);
      const initialUnlockRaw = group.initial_unlock_basis_points ?? '0';
      const initialUnlockBps = BigInt(initialUnlockRaw);
      if (cliff < BigInt(0) || vesting < BigInt(0)) {
        throw new Error('Durations must be non-negative');
      }
      if (initialUnlockBps < BigInt(0)) {
        throw new Error('initial_unlock_basis_points must be non-negative');
      }
      if (initialUnlockBps > BASIS_POINTS_DENOMINATOR) {
        throw new Error('initial_unlock_basis_points cannot exceed 100%');
      }
      this.groups.set(group.id, {
        cliffDurationNs: cliff.toString(),
        vestingDurationNs: vesting.toString(),
        initialUnlockBasisPoints: initialUnlockBps.toString(),
      });
    }
  }

  private serializeGroups(): Record<string, GroupConfigStored> {
    const snapshot: Record<string, GroupConfigStored> = {};
    for (const [id, config] of this.groups.toArray()) {
      snapshot[id] = config;
    }
    return snapshot;
  }

  private setInitialClaimConfig({
    initial_claim_basis_points,
    initial_claim_available_timestamp_ns,
  }: InitialClaimConfigInput = {}): void {
    const basisSource = initial_claim_basis_points ?? this.initialClaimBasisPoints ?? '0';
    const basisRaw = basisSource === '' ? '0' : basisSource;
    const basis = BigInt(basisRaw);
    if (basis < BigInt(0) || basis > BASIS_POINTS_DENOMINATOR) {
      throw new Error('initial_claim_basis_points must be between 0 and 10000');
    }
    this.initialClaimBasisPoints = basis.toString();

    const timestampSource =
      initial_claim_available_timestamp_ns ??
      this.initialClaimAvailableTimestampNs ??
      this.tgeTimestampNs ??
      '0';
    const timestampRaw = timestampSource === '' ? '0' : timestampSource;
    const timestamp = BigInt(timestampRaw);
    if (timestamp < BigInt(0)) {
      throw new Error('initial_claim_available_timestamp_ns must be non-negative');
    }
    if (basis > BigInt(0) && timestamp === BigInt(0)) {
      throw new Error('initial_claim_available_timestamp_ns must be provided when basis > 0');
    }
    this.initialClaimAvailableTimestampNs = timestamp.toString();
  }

  private assertOwner(): void {
    if (near.predecessorAccountId() !== this.owner) {
      throw new Error('Only owner can call this function');
    }
  }

  private assertOneYocto(): void {
    if (near.attachedDeposit() !== ONE_YOCTO) {
      throw new Error('Requires attached deposit of exactly 1 yoctoNEAR');
    }
  }

  private assertSelf(): void {
    if (near.predecessorAccountId() !== near.currentAccountId()) {
      throw new Error('Only the contract may call this function');
    }
  }

  private assertTokenCaller(): void {
    if (near.predecessorAccountId() !== this.tokenAccountId) {
      throw new Error('Only the configured token contract can deposit funds');
    }
  }
}

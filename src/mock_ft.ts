import { NearBindgen, near, call, view, initialize, NearPromise } from 'near-sdk-js';

const ONE_YOCTO = BigInt(1);
const NO_DEPOSIT = BigInt(0);
const GAS_FOR_FT_ON_TRANSFER = BigInt('50000000000000');
const GAS_FOR_RESOLVE = BigInt('20000000000000');

type StorageBalance = {
  total: string;
  available: string;
};

type Metadata = {
  spec: string;
  name: string;
  symbol: string;
  icon: string | null;
  reference: string | null;
  reference_hash: string | null;
  decimals: number;
};

function assertOneYocto(): void {
  if (near.attachedDeposit() !== ONE_YOCTO) {
    throw new Error('Requires attached deposit of exactly 1 yoctoNEAR');
  }
}

@NearBindgen({})
class MockFungibleToken {
  ownerId: string = '';
  totalSupply: string = '0';
  balances: Record<string, string> = {};
  metadata: Metadata = {
    spec: 'ft-1.0.0',
    name: '',
    symbol: '',
    icon: null,
    reference: null,
    reference_hash: null,
    decimals: 18,
  };

  @initialize({})
  init({
    owner_id,
    total_supply,
    name,
    symbol,
    decimals,
  }: {
    owner_id: string;
    total_supply: string;
    name: string;
    symbol: string;
    decimals: number;
  }): void {
    if (this.ownerId !== '') {
      throw new Error('Already initialized');
    }
    if (!owner_id || !total_supply) {
      throw new Error('owner_id and total_supply are required');
    }
    const supply = BigInt(total_supply);
    if (supply <= BigInt(0)) {
      throw new Error('total_supply must be positive');
    }

    this.ownerId = owner_id;
    this.totalSupply = supply.toString();
    this.metadata = {
      ...this.metadata,
      name,
      symbol,
      decimals,
    };

    this.setBalance(owner_id, supply);
    near.log(`Minted ${total_supply} tokens to ${owner_id}`);
  }

  @view({})
  ft_metadata(): Metadata {
    return this.metadata;
  }

  @view({})
  ft_total_supply(): string {
    return this.totalSupply;
  }

  @view({})
  ft_balance_of({ account_id }: { account_id: string }): string {
    return this.getBalance(account_id).toString();
  }

  @view({})
  storage_balance_of({ account_id }: { account_id: string }): StorageBalance | null {
    if (!account_id) {
      throw new Error('account_id is required');
    }
    if (!(account_id in this.balances)) {
      return null;
    }
    return { total: '0', available: '0' };
  }

  @view({})
  storage_balance_bounds(): { min: string; max: string | null } {
    return { min: '0', max: null };
  }

  @call({ payableFunction: true })
  storage_deposit({
    account_id,
  }: {
    account_id?: string;
    registration_only?: boolean;
  }): StorageBalance {
    const target = account_id ?? near.predecessorAccountId();
    if (!(target in this.balances)) {
      this.balances[target] = '0';
    }
    near.log(`Registered ${target}`);
    return { total: '0', available: '0' };
  }

  @call({ payableFunction: true })
  ft_transfer({
    receiver_id,
    amount,
    memo,
  }: {
    receiver_id: string;
    amount: string;
    memo?: string;
  }): void {
    assertOneYocto();
    const sender = near.predecessorAccountId();
    const transferAmount = BigInt(amount);
    if (transferAmount <= BigInt(0)) {
      throw new Error('Transfer amount must be positive');
    }
    this.internalTransfer(sender, receiver_id, transferAmount);
    near.log(`Transfer ${amount} from ${sender} to ${receiver_id}${memo ? ` (${memo})` : ''}`);
  }

  @call({ payableFunction: true })
  ft_transfer_call({
    receiver_id,
    amount,
    memo,
    msg,
  }: {
    receiver_id: string;
    amount: string;
    memo?: string;
    msg: string;
  }): NearPromise {
    assertOneYocto();
    const sender = near.predecessorAccountId();
    const transferAmount = BigInt(amount);
    if (transferAmount <= BigInt(0)) {
      throw new Error('Transfer amount must be positive');
    }

    this.internalTransfer(sender, receiver_id, transferAmount);
    near.log(
      `Transfer call of ${amount} from ${sender} to ${receiver_id}${memo ? ` (${memo})` : ''}`,
    );

    const promise = NearPromise.new(receiver_id).functionCall(
      'ft_on_transfer',
      JSON.stringify({
        sender_id: sender,
        amount,
        msg,
      }),
      NO_DEPOSIT,
      GAS_FOR_FT_ON_TRANSFER,
    );

    const resolve = NearPromise.new(near.currentAccountId()).functionCall(
      'ft_resolve_transfer',
      JSON.stringify({
        sender_id: sender,
        receiver_id,
        amount,
      }),
      NO_DEPOSIT,
      GAS_FOR_RESOLVE,
    );

    return promise.then(resolve);
  }

  @call({ privateFunction: true })
  ft_resolve_transfer({
    sender_id,
    receiver_id,
    amount,
  }: {
    sender_id: string;
    receiver_id: string;
    amount: string;
  }): string {
    this.assertSelf();
    const transferred = BigInt(amount);
    let unused = BigInt(0);

    try {
      const result = near.promiseResult(0);
      let parsed: bigint;
      try {
        parsed = BigInt(result);
      } catch {
        const json = JSON.parse(result);
        if (typeof json === 'string' || typeof json === 'number') {
          parsed = BigInt(json);
        } else {
          parsed = BigInt(json ?? 0);
        }
      }
      unused = parsed;
    } catch (error) {
      unused = transferred;
    }

    if (unused > transferred) {
      unused = transferred;
    }

    if (unused > BigInt(0)) {
      this.internalTransfer(receiver_id, sender_id, unused);
      near.log(`Refunded ${unused.toString()} tokens to ${sender_id}`);
    }

    const used = transferred - unused;
    near.log(`Resolved transfer. Used: ${used.toString()}, Unused: ${unused.toString()}`);
    return used.toString();
  }

  private internalTransfer(sender: string, receiver: string, amount: bigint): void {
    if (sender === receiver) {
      throw new Error('Transfer to self is not allowed');
    }
    const senderBalance = this.getBalance(sender);
    if (senderBalance < amount) {
      throw new Error('Insufficient balance');
    }
    this.setBalance(sender, senderBalance - amount);
    const receiverBalance = this.getBalance(receiver);
    this.setBalance(receiver, receiverBalance + amount);
  }

  private getBalance(accountId: string): bigint {
    const stored = this.balances[accountId];
    if (stored === undefined) {
      this.balances[accountId] = '0';
      return BigInt(0);
    }
    return BigInt(stored);
  }

  private setBalance(accountId: string, amount: bigint): void {
    this.balances[accountId] = amount.toString();
  }

  private assertSelf(): void {
    if (near.predecessorAccountId() !== near.currentAccountId()) {
      throw new Error('Only the contract may call this method');
    }
  }
}

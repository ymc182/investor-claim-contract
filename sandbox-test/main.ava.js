import anyTest from 'ava';
import { Worker } from 'near-workspaces';
import { setDefaultResultOrder } from 'dns';

setDefaultResultOrder('ipv4first');

/**
 * @typedef {import('near-workspaces').NearAccount} NearAccount
 * @type {import('ava').TestFn<{worker: Worker, accounts: Record<string, NearAccount>, ft: NearAccount, contract: NearAccount}>}
 */
const test = anyTest;

const ONE_YOCTO = '1';
const ONE_TOKEN = BigInt('1000000000000000000');
const FT_WASM_PATH = './build/mock_ft.wasm';
const MONTH = 30n * 24n * 60n * 60n * 1_000_000_000n;

async function currentTimestamp(worker) {
  const block = await worker.provider.block({ finality: 'final' });
  const ts = block.header.timestamp_nanosec ?? block.header.timestamp;
  return BigInt(ts);
}

test.beforeEach(async (t) => {
  const worker = await Worker.init();
  t.context.worker = worker;

  const root = worker.rootAccount;

  const ft = await root.createSubAccount('token');
  await ft.deploy(FT_WASM_PATH);
  await ft.call(ft, 'init', {
    owner_id: root.accountId,
    total_supply: (ONE_TOKEN * 1_000_000n).toString(),
    name: 'Test Token',
    symbol: 'TEST',
    decimals: 18,
  });

  const contract = await root.createSubAccount('vesting');
  await contract.deploy(process.argv[2]);

  // Register accounts on the token contract
  await root.call(
    ft,
    'storage_deposit',
    { account_id: contract.accountId },
    { attachedDeposit: '1000000000000000000000' },
  );
  await root.call(
    ft,
    'storage_deposit',
    { account_id: root.accountId },
    { attachedDeposit: '1000000000000000000000' },
  );

  t.context.accounts = { root, ft, contract };
});

test.afterEach.always(async (t) => {
  await t.context.worker.tearDown().catch((error) => {
    console.log('Failed to stop the Sandbox:', error);
  });
});

test('investor cannot claim before cliff, owner can configure groups', async (t) => {
  const { worker, accounts } = t.context;
  const { root, ft, contract } = accounts;

  const now = await currentTimestamp(worker);

  const groups = [
    {
      id: 'seed',
      cliff_duration_ns: (12n * MONTH).toString(),
      vesting_duration_ns: (12n * MONTH).toString(),
    },
    {
      id: 'strategic',
      cliff_duration_ns: (12n * MONTH).toString(),
      vesting_duration_ns: (18n * MONTH).toString(),
    },
    {
      id: 'private',
      cliff_duration_ns: (12n * MONTH).toString(),
      vesting_duration_ns: (12n * MONTH).toString(),
    },
  ];

  await root.call(contract, 'init', {
    owner: root.accountId,
    token_account_id: ft.accountId,
    tge_timestamp_ns: now.toString(),
    groups,
  });

  await root.call(contract, 'upsert_investors', {
    investors: [
      {
        account_id: 'alice.test.near',
        group_id: 'seed',
        amount: (5n * ONE_TOKEN).toString(),
      },
    ],
  });

  await root.call(
    ft,
    'ft_transfer_call',
    {
      receiver_id: contract.accountId,
      amount: (5n * ONE_TOKEN).toString(),
      memo: 'seed funding',
      msg: '',
    },
    { attachedDeposit: ONE_YOCTO, gas: '150000000000000' },
  );

  await t.throwsAsync(
    async () => {
      await root.call(
        contract,
        'claim',
        { account_id: 'alice.test.near' },
        { gas: '150000000000000', attachedDeposit: ONE_YOCTO },
      );
    },
    { message: /nothing to claim/i },
  );

  const state = await contract.view('get_state', {});
  t.deepEqual(Object.keys(state.groups), ['seed', 'strategic', 'private']);
  t.is(state.total_deposited, (5n * ONE_TOKEN).toString());
});

test('investor claims linearly after cliff, pool accounting adjusts', async (t) => {
  const { worker, accounts } = t.context;
  const { root, ft, contract } = accounts;

  const now = await currentTimestamp(worker);
  const cliff = 12n * MONTH;
  const vesting = 12n * MONTH;
  const halfVesting = vesting / 2n;

  const tge = now - (cliff + halfVesting);

  await root.call(contract, 'init', {
    owner: root.accountId,
    token_account_id: ft.accountId,
    tge_timestamp_ns: tge.toString(),
    groups: [
      {
        id: 'seed',
        cliff_duration_ns: cliff.toString(),
        vesting_duration_ns: vesting.toString(),
      },
      {
        id: 'strategic',
        cliff_duration_ns: cliff.toString(),
        vesting_duration_ns: (18n * MONTH).toString(),
      },
      {
        id: 'private',
        cliff_duration_ns: cliff.toString(),
        vesting_duration_ns: vesting.toString(),
      },
    ],
  });

  const alice = await root.createSubAccount('alice');
  await root.call(
    ft,
    'storage_deposit',
    { account_id: alice.accountId },
    { attachedDeposit: '1000000000000000000000' },
  );

  const allocation = 12n * ONE_TOKEN;

  await root.call(contract, 'upsert_investors', {
    investors: [
      {
        account_id: alice.accountId,
        group_id: 'seed',
        amount: allocation.toString(),
      },
    ],
  });

  await root.call(
    ft,
    'ft_transfer_call',
    {
      receiver_id: contract.accountId,
      amount: (allocation * 2n).toString(),
      memo: 'seed funding',
      msg: '',
    },
    { attachedDeposit: ONE_YOCTO, gas: '150000000000000' },
  );

  const claimable = BigInt(await contract.view('get_claimable', { account_id: alice.accountId }));
  t.true(claimable > BigInt(0));
  const expectedHalf = allocation / 2n;
  const diff = claimable > expectedHalf ? claimable - expectedHalf : expectedHalf - claimable;
  t.true(diff <= allocation / 200n); // within 0.5% tolerance

  await alice.call(contract, 'claim', {}, { gas: '150000000000000', attachedDeposit: ONE_YOCTO });

  const investor = await contract.view('get_investor', { account_id: alice.accountId });
  const claimedAmount = BigInt(investor.claimed);
  t.true(claimedAmount >= claimable);

  const balance = await ft.view('ft_balance_of', { account_id: alice.accountId });
  t.is(balance, claimedAmount.toString());

  const state = await contract.view('get_state', {});
  t.is(state.total_claimed, claimedAmount.toString());
  t.is(state.pool_balance, ((allocation * 2n - claimedAmount)).toString());

  const remainingClaimable = BigInt(
    await contract.view('get_claimable', { account_id: alice.accountId }),
  );
  t.true(remainingClaimable <= allocation / 10000n);
});

test('investor receives instant unlock percentage after cliff', async (t) => {
  const { worker, accounts } = t.context;
  const { root, ft, contract } = accounts;

  const now = await currentTimestamp(worker);
  const cliff = 6n * MONTH;
  const vesting = 24n * MONTH;
  const initialUnlockBps = 1000n; // 10%
  const tge = now - cliff;

  await root.call(contract, 'init', {
    owner: root.accountId,
    token_account_id: ft.accountId,
    tge_timestamp_ns: tge.toString(),
    groups: [
      {
        id: 'saft',
        cliff_duration_ns: cliff.toString(),
        vesting_duration_ns: vesting.toString(),
        initial_unlock_basis_points: initialUnlockBps.toString(),
      },
    ],
  });

  const carol = await root.createSubAccount('carol');
  await root.call(
    ft,
    'storage_deposit',
    { account_id: carol.accountId },
    { attachedDeposit: '1000000000000000000000' },
  );

  const allocation = 50n * ONE_TOKEN;
  await root.call(contract, 'upsert_investors', {
    investors: [
      {
        account_id: carol.accountId,
        group_id: 'saft',
        amount: allocation.toString(),
      },
    ],
  });

  await root.call(
    ft,
    'ft_transfer_call',
    {
      receiver_id: contract.accountId,
      amount: allocation.toString(),
      memo: 'saft funding',
      msg: '',
    },
    { attachedDeposit: ONE_YOCTO, gas: '150000000000000' },
  );

  const claimable = BigInt(await contract.view('get_claimable', { account_id: carol.accountId }));
  const expectedInstant = (allocation * initialUnlockBps) / 10000n;
  t.true(claimable >= expectedInstant);
  const extra = claimable - expectedInstant;
  t.true(extra <= allocation / 1000n); // small linear accrual since vesting just started

  await carol.call(contract, 'claim', {}, { gas: '150000000000000', attachedDeposit: ONE_YOCTO });
  const balance = await ft.view('ft_balance_of', { account_id: carol.accountId });
  t.true(BigInt(balance) >= expectedInstant);

  const investor = await contract.view('get_investor', { account_id: carol.accountId });
  t.true(BigInt(investor.claimed) >= expectedInstant);
});

test('initial claim gated by global start date', async (t) => {
  const { worker, accounts } = t.context;
  const { root, ft, contract } = accounts;

  const now = await currentTimestamp(worker);
  const cliff = 12n * MONTH;
  const vesting = 24n * MONTH;
  const initialBasis = 500n; // 5%
  const initialStart = now + MONTH;

  await root.call(contract, 'init', {
    owner: root.accountId,
    token_account_id: ft.accountId,
    tge_timestamp_ns: now.toString(),
    groups: [
      {
        id: 'round-a',
        cliff_duration_ns: cliff.toString(),
        vesting_duration_ns: vesting.toString(),
        initial_unlock_basis_points: '1000',
      },
    ],
    initial_claim_basis_points: initialBasis.toString(),
    initial_claim_available_timestamp_ns: initialStart.toString(),
  });

  const dave = await root.createSubAccount('dave');
  await root.call(
    ft,
    'storage_deposit',
    { account_id: dave.accountId },
    { attachedDeposit: '1000000000000000000000' },
  );

  const allocation = 20n * ONE_TOKEN;
  await root.call(contract, 'upsert_investors', {
    investors: [
      {
        account_id: dave.accountId,
        group_id: 'round-a',
        amount: allocation.toString(),
      },
    ],
  });

  await root.call(
    ft,
    'ft_transfer_call',
    {
      receiver_id: contract.accountId,
      amount: allocation.toString(),
      memo: 'round a funding',
      msg: '',
    },
    { attachedDeposit: ONE_YOCTO, gas: '150000000000000' },
  );

  const beforeStart = await contract.view('get_claimable', { account_id: dave.accountId });
  t.is(beforeStart, '0');

  await t.throwsAsync(
    () =>
      dave.call(contract, 'claim', {}, { gas: '150000000000000', attachedDeposit: ONE_YOCTO }),
    { message: /nothing to claim/i },
  );

  await root.call(contract, 'configure_initial_claim', {
    initial_claim_available_timestamp_ns: (now - MONTH).toString(),
  });

  const claimable = BigInt(await contract.view('get_claimable', { account_id: dave.accountId }));
  const expectedInitial = (allocation * initialBasis) / 10000n;
  t.true(claimable >= expectedInitial);
  t.true(claimable - expectedInitial <= allocation / 1000n);

  await dave.call(contract, 'claim', {}, { gas: '150000000000000', attachedDeposit: ONE_YOCTO });
  const daveBalance = BigInt(await ft.view('ft_balance_of', { account_id: dave.accountId }));
  t.true(daveBalance >= expectedInitial);
});

test('initial claim at 0% behaves like disabled', async (t) => {
  const { worker, accounts } = t.context;
  const { root, ft, contract } = accounts;

  const now = await currentTimestamp(worker);
  const cliff = 6n * MONTH;
  const vesting = 18n * MONTH;

  await root.call(contract, 'init', {
    owner: root.accountId,
    token_account_id: ft.accountId,
    tge_timestamp_ns: now.toString(),
    groups: [
      {
        id: 'round-b',
        cliff_duration_ns: cliff.toString(),
        vesting_duration_ns: vesting.toString(),
        initial_unlock_basis_points: '0',
      },
    ],
    initial_claim_basis_points: '0',
    initial_claim_available_timestamp_ns: now.toString(),
  });

  const erin = await root.createSubAccount('erin');
  await root.call(
    ft,
    'storage_deposit',
    { account_id: erin.accountId },
    { attachedDeposit: '1000000000000000000000' },
  );

  const allocation = 30n * ONE_TOKEN;
  await root.call(contract, 'upsert_investors', {
    investors: [
      {
        account_id: erin.accountId,
        group_id: 'round-b',
        amount: allocation.toString(),
      },
    ],
  });

  await root.call(
    ft,
    'ft_transfer_call',
    {
      receiver_id: contract.accountId,
      amount: allocation.toString(),
      memo: 'round b funding',
      msg: '',
    },
    { attachedDeposit: ONE_YOCTO, gas: '150000000000000' },
  );

  const initialClaimable = await contract.view('get_claimable', { account_id: erin.accountId });
  t.is(initialClaimable, '0');

  await t.throwsAsync(
    () =>
      erin.call(contract, 'claim', {}, { gas: '150000000000000', attachedDeposit: ONE_YOCTO }),
    { message: /nothing to claim/i },
  );
});

test('owner can adjust investor allocation upwards and withdraw surplus', async (t) => {
  const { worker, accounts } = t.context;
  const { root, ft, contract } = accounts;
  const now = await currentTimestamp(worker);

  const cliff = 12n * MONTH;
  const vesting = 18n * MONTH;
  const tge = now - (cliff + vesting);

  await root.call(contract, 'init', {
    owner: root.accountId,
    token_account_id: ft.accountId,
    tge_timestamp_ns: tge.toString(),
    groups: [
      {
        id: 'strategic',
        cliff_duration_ns: cliff.toString(),
        vesting_duration_ns: vesting.toString(),
      },
    ],
  });

  const bob = await root.createSubAccount('bob');
  await root.call(
    ft,
    'storage_deposit',
    { account_id: bob.accountId },
    { attachedDeposit: '1000000000000000000000' },
  );

  const initialAllocation = 20n * ONE_TOKEN;
  await root.call(contract, 'upsert_investors', {
    investors: [
      {
        account_id: bob.accountId,
        group_id: 'strategic',
        amount: initialAllocation.toString(),
      },
    ],
  });

  await root.call(
    ft,
    'ft_transfer_call',
    {
      receiver_id: contract.accountId,
      amount: (initialAllocation + 10n * ONE_TOKEN).toString(),
      memo: 'strategic funding',
      msg: '',
    },
    { attachedDeposit: ONE_YOCTO, gas: '150000000000000' },
  );

  await bob.call(contract, 'claim', {}, { gas: '150000000000000', attachedDeposit: ONE_YOCTO });
  const bobBalance = await ft.view('ft_balance_of', { account_id: bob.accountId });
  t.is(bobBalance, initialAllocation.toString());

  await root.call(contract, 'upsert_investors', {
    investors: [
      {
        account_id: bob.accountId,
        group_id: 'strategic',
        amount: (initialAllocation + 5n * ONE_TOKEN).toString(),
      },
    ],
  });

  const stateBeforeWithdraw = await contract.view('get_state', {});
  t.is(stateBeforeWithdraw.pool_balance, (10n * ONE_TOKEN).toString());

  await root.call(
    contract,
    'withdraw_unallocated',
    { amount: (10n * ONE_TOKEN).toString(), recipient: root.accountId },
    { gas: '150000000000000', attachedDeposit: ONE_YOCTO },
  );

  const rootBalance = await ft.view('ft_balance_of', { account_id: root.accountId });
  t.true(BigInt(rootBalance) >= 10n * ONE_TOKEN);

  const finalState = await contract.view('get_state', {});
  t.is(finalState.pool_balance, '0');
});

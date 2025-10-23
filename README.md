# Investor Vesting Distributor (NEAR)

This project provides a NEP-141 based vesting contract for investor groups. Administrators configure vesting profiles (e.g., 12‑month cliff followed by 12 or 18 months of linear vesting), assign allocations to accounts, and preload the contract with the required fungible tokens. Investors (or the admin on their behalf) can then claim vested tokens as time unlocks.

The repository ships with integration tests that deploy a mock FT contract and exercise the claim/withdraw flows end to end.

---

## Requirements

- Node.js 18+
- `npm` or `yarn`
- [`near-cli`](https://github.com/near/near-cli) v3 for deployment and manual testing
- A NEAR account capable of deploying contracts (e.g., `vesting.your-project.testnet`)

Install dependencies:

```bash
npm install
```

---

## Build & Test

```bash
# Compile vesting + mock FT contracts
npm run build

# Compile both contracts and run sandbox tests
npm test
```

Tests live in `sandbox-test/main.ava.js` and cover:

- 12-month cliff preventing early claims
- Linear vesting mid-stream (partial unlock after cliff)
- Owner adjustments and recovering surplus tokens

---

## Contract Interface

| Method | Kind | Notes |
| ------ | ---- | ----- |
| `init({ owner?, token_account_id, tge_timestamp_ns, groups })` | `call` (init-only) | Sets the owner (defaults to initializer), target NEP-141 token, TGE timestamp (nanoseconds), and initial group configs. Each group entry needs `{ id, cliff_duration_ns, vesting_duration_ns }`. |
| `configure_groups({ groups })` | `call` (owner) | Replace the group configuration. Existing investors retain their group ids; ensure new configs keep required ids. |
| `upsert_investors({ investors })` | `call` (owner) | Batch assign or update investor allocations. Each item: `{ account_id, group_id, amount }`. Allocation cannot drop below what the investor has already claimed. |
| `claim({ account_id? })` | `call` (requires 1 yocto NEAR) | Investors call without `account_id`. Owner may claim for someone else by supplying `account_id`. Transfers the newly vested amount via `ft_transfer`. |
| `withdraw_unallocated({ amount, recipient?, memo? })` | `call` (owner, 1 yocto NEAR) | Recovers excess tokens from the contract pool. |
| `ft_on_transfer({ sender_id, amount, msg })` | `call` | Funding hook invoked by the NEP-141 token when you call `ft_transfer_call`. Only the configured token contract may call it. |
| `get_state()` | `view` | Owner, token account, TGE timestamp, aggregate totals, pool balance, and group configs. |
| `get_investor({ account_id })` | `view` | Returns `{ groupId, totalAllocation, claimed }` or `null`. |
| `get_claimable({ account_id })` | `view` | Returns the currently claimable amount in token smallest units. |

### Vesting Formula

For an investor in group `G`:

- Nothing unlocks before `tge_timestamp_ns + cliff_duration_ns`.
- After the cliff, the allocation vests linearly over `vesting_duration_ns`. If `vesting_duration_ns` is `0`, the entire allocation unlocks immediately after the cliff.

---

## Typical Workflow

1. **Deploy the Contract**
   ```bash
   npm run build
   near deploy --accountId vesting.your-project.testnet --wasmFile build/investor_vesting.wasm
   ```

2. **Initialize**
   ```bash
   near call vesting.your-project.testnet init '{
     "owner": "treasury.your-project.testnet",
     "token_account_id": "token.your-project.testnet",
     "tge_timestamp_ns": "1735603200000000000",
     "groups": [
       { "id": "seed", "cliff_duration_ns": "31104000000000000", "vesting_duration_ns": "31104000000000000" },
       { "id": "strategic", "cliff_duration_ns": "31104000000000000", "vesting_duration_ns": "46656000000000000" },
       { "id": "private", "cliff_duration_ns": "31104000000000000", "vesting_duration_ns": "31104000000000000" }
     ]
   }' --accountId treasury.your-project.testnet
   ```
   (Durations above use 30-day months × 12 or 18; adjust to your schedule.)

3. **Register Storage on the Token Contract**
   ```bash
   near call token.your-project.testnet storage_deposit '{
     "account_id": "vesting.your-project.testnet"
   }' --accountId treasury.your-project.testnet --amount 0.001
   ```
   Repeat for each investor account if the FT contract requires it.

4. **Assign Investors**
   ```bash
   near call vesting.your-project.testnet upsert_investors '{
     "investors": [
       { "account_id": "seed1.testnet", "group_id": "seed", "amount": "5000000000000000000000000" },
       { "account_id": "strategic1.testnet", "group_id": "strategic", "amount": "7000000000000000000000000" }
     ]
   }' --accountId treasury.your-project.testnet
   ```

5. **Fund the Pool via the NEP-141 Token**
   ```bash
   near call token.your-project.testnet ft_transfer_call '{
     "receiver_id": "vesting.your-project.testnet",
     "amount": "12000000000000000000000000",
     "memo": "Investor vesting pool",
     "msg": ""
   }' --accountId treasury.your-project.testnet --amount 0.000000000000000000000001 --gas 150000000000000
   ```

6. **Investor Claims**
   ```bash
   near call vesting.your-project.testnet claim '{}' \
     --accountId seed1.testnet \
     --amount 0.000000000000000000000001 \
     --gas 150000000000000
   ```
   The contract automatically transfers the vested portion of the investor’s allocation using `ft_transfer`.

7. **Owner Claim on Behalf (Optional)**
   ```bash
   near call vesting.your-project.testnet claim '{
     "account_id": "seed1.testnet"
   }' --accountId treasury.your-project.testnet --amount 0.000000000000000000000001 --gas 150000000000000
   ```

8. **Withdraw Unused Tokens**
   ```bash
   near call vesting.your-project.testnet withdraw_unallocated '{
     "amount": "1000000000000000000000000",
     "recipient": "treasury.your-project.testnet"
   }' --accountId treasury.your-project.testnet --amount 0.000000000000000000000001 --gas 150000000000000
   ```

---

## Tips & Considerations

- **Funding**: Keep enough tokens in the pool to cover all outstanding claimable amounts. The contract will reject claims if the pool balance is insufficient.
- **Group Updates**: Updating group parameters affects future vesting accruals immediately. Use with caution once investors have started vesting.
- **Allocation Changes**: You may raise an investor’s total allocation later (e.g., for bonuses) but you cannot reduce it below what they’ve already claimed.
- **Cliff Enforcement**: Claims before the cliff return `Nothing to claim at this time`. No tokens leave the pool.
- **Security**: `claim` and `withdraw_unallocated` require exactly 1 yoctoNEAR, preventing accidental or cross-contract free calls.

---

## Further Enhancements

- Add per-group metadata (e.g., names, docs URLs) for frontends.
- Support manual vesting pauses or cliffs per account.
- Emit structured event logs (JSON) to streamline off-chain indexing.

Enjoy building your investor vesting flows on NEAR! Run `npm test` after every change to ensure contract + integration behaviour remains correct.***

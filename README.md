# @hemilabs/anvil-fork-setup

[![NPM version](https://img.shields.io/npm/v/@hemilabs/anvil-fork-setup)](https://www.npmjs.com/package/@hemilabs/anvil-fork-setup) [![Package size](https://img.shields.io/bundlephobia/minzip/@hemilabs/anvil-fork-setup)](https://bundlephobia.com/package/@hemilabs/anvil-fork-setup) [![Follow Hemi on X](https://img.shields.io/twitter/url?url=https%3A%2F%2Fx.com%2Fhemi_xyz&style=flat&logo=x&label=%40hemi_xyz&labelColor=%23ff6c15&color=%230a0a0a)](https://x.com/intent/follow?screen_name=hemi_xyz)

A [Vitest](https://vitest.dev/) `globalSetup` factory that starts an [Anvil](https://book.getfoundry.sh/reference/anvil/) fork before your tests and stops it after. If Foundry is not installed, it will be installed automatically.

## Install

```sh
npm add -D @hemilabs/anvil-fork-setup
```

## Setup

### 1. Create a globalSetup file

```ts
// test/e2e/setup.ts
import { anvilFork } from "@hemilabs/anvil-fork-setup";

export default anvilFork({
  chainId: 43111,
  forkUrl: "https://rpc.hemi.network/rpc",
});
```

### 2. Add it to your Vitest config

```ts
// vitest.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["test/e2e/setup.ts"],
    testTimeout: 30_000, // RPC calls can be slow
  },
});
```

### 3. Enable types for `inject`

Create a type declaration file and include it in your `tsconfig.json`:

```ts
// test/e2e/env.d.ts
/// <reference types="@hemilabs/anvil-fork-setup" />
```

```jsonc
// tsconfig.json
{
  "include": ["src/**/*.ts", "test/e2e/env.d.ts"],
}
```

This makes `inject("anvilUrl")` type-safe in your test files.

## Usage

The Anvil fork URL is available in tests via Vitest's `inject`:

```ts
import { inject } from "vitest";

const anvilUrl = inject("anvilUrl");
```

### Example: E2E tests with viem

#### Reading from the fork

```ts
// test/e2e/public.test.ts
import { createTestClient, erc20Abi, http } from "viem";
import { readContract } from "viem/actions";
import { hemi } from "viem/chains";
import { describe, expect, inject, it } from "vitest";

// ERC-20 token address
const tokenAddress = "0x99e3dE3817F6081B2568208337ef83295b7f591D";

describe("public actions e2e", function () {
  it("should read the token name", async function () {
    const client = createTestClient({
      chain: hemi,
      mode: "anvil",
      transport: http(inject("anvilUrl")),
    });

    const name = await readContract(client, {
      address: tokenAddress,
      abi: erc20Abi,
      functionName: "name",
    });

    expect(typeof name).toBe("string");
  });
});
```

#### Writing to the fork

Use `inject("anvilUrl")` as the transport URL and Anvil's default test mnemonic for accounts:

```ts
// test/e2e/wallet.test.ts
import { createTestClient, erc20Abi, http } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import {
  readContract,
  waitForTransactionReceipt,
  writeContract,
} from "viem/actions";
import { hemi } from "viem/chains";
import { describe, expect, inject, it } from "vitest";

const tokenAddress = "0x99e3dE3817F6081B2568208337ef83295b7f591D";
const anvilMnemonic =
  "test test test test test test test test test test test junk";

const account = mnemonicToAccount(anvilMnemonic, { addressIndex: 0 });
const spender = mnemonicToAccount(anvilMnemonic, { addressIndex: 1 });

describe("wallet actions e2e", function () {
  it("should approve and verify allowance", async function () {
    const client = createTestClient({
      account,
      chain: hemi,
      mode: "anvil",
      transport: http(inject("anvilUrl")),
    });

    // Send an approve transaction
    const hash = await writeContract(client, {
      address: tokenAddress,
      abi: erc20Abi,
      functionName: "approve",
      args: [spender.address, 1000n],
    });

    expect(hash).toMatch(/^0x[0-9a-f]{64}$/i);

    // Wait for the receipt and verify
    const receipt = await waitForTransactionReceipt(client, { hash });
    expect(receipt.status).toBe("success");

    // Check the allowance matches the approved amount
    const result = await readContract(client, {
      address: tokenAddress,
      abi: erc20Abi,
      functionName: "allowance",
      args: [account.address, spender.address],
    });
    expect(result).toBe(1000n);
  });
});
```

### Conditional E2E execution

You may want to skip E2E tests locally and only run them in CI. One approach is to gate the globalSetup and test inclusion on an environment variable:

```ts
// vitest.config.ts
import { defineConfig } from "vitest/config";

const isCI = process.env.CI === "true";

export default defineConfig({
  test: {
    clearMocks: true,
    ...(isCI
      ? { globalSetup: ["test/e2e/setup.ts"], testTimeout: 30_000 }
      : { exclude: ["test/e2e/**", "node_modules/**"] }),
  },
});
```

This way `npm test` runs only unit tests locally, while CI (which sets `CI=true`) includes E2E tests with the Anvil fork. You can add a convenience script for running E2E locally:

```json
{
  "scripts": {
    "test": "vitest run",
    "test:e2e": "CI=true vitest run"
  }
}
```

## Options

| Option    | Type     | Required | Default | Description                 |
| --------- | -------- | -------- | ------- | --------------------------- |
| `chainId` | `number` | Yes      | —       | Chain ID for the Anvil fork |
| `forkUrl` | `string` | Yes      | —       | RPC URL to fork from        |
| `port`    | `number` | No       | `8545`  | Port for the Anvil instance |

## License

[MIT](LICENSE)

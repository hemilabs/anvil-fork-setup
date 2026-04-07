import { expect, inject, test } from "vitest";

// Use these tests to ensure that the Anvil fork started correctly
const rpc = (method: string, params: unknown[] = []) =>
  fetch(inject("anvilUrl"), {
    body: JSON.stringify({ id: 1, jsonrpc: "2.0", method, params }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  }).then((r) => r.json() as Promise<{ result: string }>);

test("anvil responds to RPC calls", async () =>
  expect((await rpc("net_version")).result).toBeDefined());

test("chain ID matches configuration", async () =>
  expect(parseInt((await rpc("eth_chainId")).result, 16)).toBe(31337));

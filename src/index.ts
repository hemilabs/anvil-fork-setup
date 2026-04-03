import { type ChildProcess, execSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import type {} from "vitest";
import type { TestProject } from "vitest/node";

// See https://github.com/foundry-rs/foundry/releases/tag/v1.5.1
const FOUNDRY_VERSION = "1.5.1";
const FOUNDRY_COMMIT_SHA = "b0a9dd9ceda36f63e2326ce530c10e6916f4b8a2";

/** Configuration for the Anvil fork instance. */
export interface AnvilForkOptions {
  /** Chain ID for the Anvil fork. */
  chainId: number;
  /** RPC URL to fork from (e.g. `"https://rpc.hemi.network/rpc"`). */
  forkUrl: string;
  /** Port for the Anvil instance. @defaultValue 8545 */
  port?: number;
}

function isAnvilInstalled(): boolean {
  try {
    execSync("anvil --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function verifyAnvilVersion(): void {
  const output = execSync("anvil --version", { encoding: "utf-8" });
  if (
    !output.includes(FOUNDRY_VERSION) ||
    !output.includes(FOUNDRY_COMMIT_SHA)
  ) {
    throw new Error(
      `Foundry version mismatch — possible supply chain attack.\n` +
        `  Expected version ${FOUNDRY_VERSION}, commit ${FOUNDRY_COMMIT_SHA}\n` +
        `  Got: ${output.trim()}`,
    );
  }
}

function installFoundry(): void {
  // eslint-disable-next-line no-console
  console.log(`Anvil not found. Installing Foundry ${FOUNDRY_VERSION}...`);
  execSync("curl -L https://foundry.paradigm.xyz | bash", {
    env: { ...process.env, SHELL: "/bin/bash" },
    stdio: "inherit",
  });
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const foundryBin = `${home}/.foundry/bin`;
  process.env.PATH = `${foundryBin}:${process.env.PATH}`;
  execSync(`foundryup --install ${FOUNDRY_VERSION}`, { stdio: "inherit" });
  verifyAnvilVersion();
}

const checkPortAvailable = (port: number): Promise<void> =>
  new Promise(function (resolve, reject) {
    const server = createServer();
    server.once("error", (err: NodeJS.ErrnoException) =>
      err.code === "EADDRINUSE"
        ? reject(new Error(`Port ${port} is already in use`))
        : reject(err),
    );
    server.once("listening", () => server.close(() => resolve()));
    server.listen(port, "127.0.0.1");
  });

async function waitForAnvil(url: string): Promise<void> {
  const maxAttempts = 15;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const response = await fetch(url, {
        body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "net_version" }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      if (response.ok) return;
    } catch {
      // Not ready yet
    }
    if (i < maxAttempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  throw new Error("Anvil failed to start within 30 seconds");
}

declare module "vitest" {
  export interface ProvidedContext {
    anvilUrl: string;
  }
}

/**
 * Vitest `globalSetup` factory that starts an Anvil fork before tests and
 * stops it after. The fork URL is injected into tests via
 * `inject("anvilUrl")`. If Foundry is not installed, it will be installed
 * automatically.
 *
 * @example
 * ```ts
 * // test/e2e/setup.ts
 * import { anvilFork } from "@hemilabs/anvil-fork-setup";
 *
 * export default anvilFork({
 *   chainId: 43111,
 *   forkUrl: "https://rpc.hemi.network/rpc",
 * });
 * ```
 */
function validateForkUrl(forkUrl: string): void {
  try {
    new URL(forkUrl);
  } catch {
    throw new Error(`Invalid forkUrl: "${forkUrl}"`);
  }
}

export function anvilFork(options: AnvilForkOptions) {
  const { chainId, forkUrl, port = 8545 } = options;
  validateForkUrl(forkUrl);

  let anvilProcess: ChildProcess | undefined;

  return async function ({ provide }: TestProject) {
    if (!isAnvilInstalled()) {
      installFoundry();
    }

    await checkPortAvailable(port);

    anvilProcess = spawn(
      "anvil",
      [
        "--fork-url",
        forkUrl,
        "--port",
        String(port),
        "--chain-id",
        String(chainId),
      ],
      { stdio: "pipe" },
    );

    const startError = new Promise(function (resolve, reject) {
      anvilProcess?.on("error", (err) =>
        reject(new Error(`Failed to start anvil: ${err.message}`)),
      );
      anvilProcess?.on("exit", function (code, signal) {
        if (code !== null && code !== 0) {
          reject(new Error(`Anvil exited with code ${code}`));
        } else if (signal) {
          reject(new Error(`Anvil was killed by signal ${signal}`));
        }
      });
    });

    const url = `http://127.0.0.1:${port}`;
    await Promise.race([waitForAnvil(url), startError]);
    anvilProcess.removeAllListeners("error");
    anvilProcess.removeAllListeners("exit");
    provide("anvilUrl", url);
    // eslint-disable-next-line no-console
    console.log("Anvil fork started successfully");

    return function () {
      if (anvilProcess) {
        anvilProcess.kill();
        anvilProcess = undefined;
        // eslint-disable-next-line no-console
        console.log("Anvil fork stopped");
      }
    };
  };
}

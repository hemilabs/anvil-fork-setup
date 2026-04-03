import {
  type ChildProcess,
  execFileSync,
  execSync,
  spawn,
} from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {} from "vitest";
import type { TestProject } from "vitest/node";

// See https://github.com/foundry-rs/foundry/releases/tag/v1.5.1
const FOUNDRY_VERSION = "1.5.1";

// SHA-256 digests of official release tarballs from GitHub.
// Retrieved via: gh api repos/foundry-rs/foundry/releases/tags/v1.5.1 --jq '.assets[] | {name, digest}'
const FOUNDRY_TARBALL_DIGESTS: Record<string, string> = {
  "darwin-arm64":
    "sha256:b3bf1752be066e0877911721e0624058171c88fc5616e228937fe4620b41c40d",
  "darwin-x64":
    "sha256:a416e79c26d32cd37316232f790b3a1bdeae4dfae09d82627d7a1ace4c281848",
  "linux-arm64":
    "sha256:cccf28bdf202289e837a9e21ed213b2b80dc1e806e12f1717bc98a44315c331e",
  "linux-x64":
    "sha256:73640b01bd9ed29fdb4965085099371f8cf0dbbec3e2086cf54564efc4dcfe88",
};

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

function getAssetName(): string {
  const arch = process.arch === "x64" ? "amd64" : process.arch;
  return `foundry_v${FOUNDRY_VERSION}_${process.platform}_${arch}.tar.gz`;
}

/**
 * Verifies the downloaded tarball against the expected SHA-256 digest
 * hardcoded from the official GitHub release. This ensures we always install
 * the exact binary published by foundry-rs, guarding against tampering or
 * supply chain attacks.
 *
 * Digests are retrieved via the GitHub API's `digest` field on release assets
 * and must be updated manually when bumping `FOUNDRY_VERSION`.
 */
function verifyAnvilIntegrity(tarballPath: string): void {
  const key = `${process.platform}-${process.arch}`;
  const expected = FOUNDRY_TARBALL_DIGESTS[key];
  if (!expected) {
    throw new Error(`Unsupported platform: ${key}`);
  }
  const fileBuffer = readFileSync(tarballPath);
  const actual = `sha256:${createHash("sha256").update(fileBuffer).digest("hex")}`;
  if (actual !== expected) {
    throw new Error(
      `Foundry tarball integrity check failed.\n` +
        `  Expected: ${expected}\n` +
        `  Got: ${actual}`,
    );
  }
}

function installFoundry(): void {
  const asset = getAssetName();
  const tarballPath = join(tmpdir(), asset);
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (!home) {
    throw new Error(
      "Cannot determine home directory (HOME/USERPROFILE not set)",
    );
  }
  const foundryBin = join(home, ".foundry", "bin");

  console.info(`Anvil not found. Installing Foundry ${FOUNDRY_VERSION}...`);
  execFileSync(
    "curl",
    [
      "-fsSL",
      "-o",
      tarballPath,
      `https://github.com/foundry-rs/foundry/releases/download/v${FOUNDRY_VERSION}/${asset}`,
    ],
    { stdio: "inherit" },
  );
  verifyAnvilIntegrity(tarballPath);
  console.info("Tarball integrity verified successfully");
  mkdirSync(foundryBin, { recursive: true });
  execFileSync("tar", ["xzf", tarballPath, "-C", foundryBin], {
    stdio: "inherit",
  });
  rmSync(tarballPath);
  process.env.PATH = `${foundryBin}:${process.env.PATH}`;
  console.info(`Foundry ${FOUNDRY_VERSION} installed successfully`);
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
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(url, {
        body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "net_version" }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
        signal: controller.signal,
      });
      if (response.ok) return;
    } catch {
      // Not ready yet
    } finally {
      clearTimeout(timeout);
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
      { stdio: "ignore" },
    );

    const startError = new Promise(function (_resolve, reject) {
      anvilProcess?.on("error", (err) =>
        reject(new Error(`Failed to start anvil: ${err.message}`)),
      );
      anvilProcess?.on("exit", (code, signal) =>
        reject(
          new Error(
            `Anvil exited before becoming ready (code: ${code}, signal: ${signal})`,
          ),
        ),
      );
    });

    const url = `http://127.0.0.1:${port}`;
    try {
      await Promise.race([waitForAnvil(url), startError]);
    } catch (error) {
      anvilProcess?.removeAllListeners("error");
      anvilProcess?.removeAllListeners("exit");
      if (anvilProcess && !anvilProcess.killed) {
        anvilProcess.kill();
      }
      anvilProcess = undefined;
      throw error;
    }
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

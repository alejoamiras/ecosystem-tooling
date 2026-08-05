/**
 * Self-provisions a DISPOSABLE local Aztec network for the warp suite.
 *
 * Time-travel warps are global and irreversible — a warped chain later fails
 * everything with "Invalid expiration timestamp" — so this suite NEVER runs
 * against a shared network (plan D5.3, mechanical quarantine). Both the anvil
 * L1 and the Aztec node are spawned here on ephemeral-picked ports, in their
 * own process groups, with a real-disk data directory, and torn down by owned
 * pgid. Runs identically locally and in CI (no port registry needed: ports
 * are picked by binding 0).
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import net from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import pkg from '../../../../package.json' with { type: 'json' };

const AZTEC_VERSION = pkg.version; // lockstep: the package version IS the Aztec version

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function waitHttp(url: string, tries: number, delayMs: number): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error(`${url} never became ready`);
}

/** Anvil answers JSON-RPC POSTs, not GETs — probe with eth_chainId. */
async function waitAnvil(url: string, tries: number, delayMs: number): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}',
      });
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error(`anvil at ${url} never became ready`);
}

function spawnOwned(cmd: string, args: string[], env: Record<string, string>): ChildProcess {
  const child = spawn(cmd, args, {
    detached: true, // own process group, so teardown kills EXACTLY this tree
    stdio: 'ignore',
    env: { ...process.env, ...env },
  });
  child.unref();
  return child;
}

function killGroup(child: ChildProcess | undefined) {
  if (child?.pid) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
}

export default async function setup(): Promise<() => Promise<void>> {
  const versionDir = join(homedir(), '.aztec', 'versions', AZTEC_VERSION);
  const aztecBin = join(versionDir, 'bin', 'aztec');
  const internalBin = join(versionDir, 'internal-bin');

  const anvilPort = await freePort();
  const nodePort = await freePort();
  const adminPort = await freePort();
  const dataDir = join(homedir(), '.cache', 'quota-paymaster-warp', `run-${process.pid}-${anvilPort}`);
  mkdirSync(dataDir, { recursive: true });

  console.log(`[warp-setup] disposable network: node :${nodePort}, anvil :${anvilPort}, data ${dataDir}`);

  const anvil = spawnOwned(
    join(internalBin, 'anvil'),
    ['--port', String(anvilPort), '--host', '127.0.0.1', '--chain-id', '31337', '--silent'],
    {},
  );
  let node: ChildProcess | undefined;
  const teardown = async () => {
    killGroup(node);
    killGroup(anvil);
    rmSync(dataDir, { recursive: true, force: true });
    console.log('[warp-setup] disposable network torn down');
  };

  try {
    await waitAnvil(`http://127.0.0.1:${anvilPort}`, 40, 250);
    node = spawnOwned(
      aztecBin,
      [
        'start',
        '--local-network',
        '--port',
        String(nodePort),
        '--admin-port',
        String(adminPort),
        '--l1-rpc-urls',
        `http://127.0.0.1:${anvilPort}`,
        '--data-directory',
        dataDir,
      ],
      {
        SEQ_MIN_TX_PER_BLOCK: '0',
        FORGE_BIN: join(internalBin, 'forge'),
        ANVIL_BIN: join(internalBin, 'anvil'),
        CAST_BIN: join(internalBin, 'cast'),
      },
    );
    await waitHttp(`http://127.0.0.1:${nodePort}/status`, 120, 5_000);
  } catch (err) {
    await teardown();
    throw err;
  }

  // globalSetup runs in the main process BEFORE workers fork, so these reach
  // the harness in every test worker.
  process.env.NODE_URL = `http://127.0.0.1:${nodePort}`;
  process.env.L1_RPC_URL = `http://127.0.0.1:${anvilPort}`;
  console.log(`[warp-setup] ready at ${process.env.NODE_URL}`);

  return teardown;
}

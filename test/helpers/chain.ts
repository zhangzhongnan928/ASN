/**
 * Integration harness: spins up anvil, deploys the real ASN stack + Coinbase Smart Wallet factory,
 * and exposes viem helpers. Used by the functional M0/M1 milestone tests to prove the off-chain
 * services (indexer, encryption oracle) are wired to the REAL contracts.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  http,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";

const ROOT = new URL("../../", import.meta.url);
const artifact = (sol: string, name: string): { abi: Abi; bytecode: Hex } => {
  const p = fileURLToPath(new URL(`out/${sol}/${name}.json`, ROOT));
  const j = JSON.parse(readFileSync(p, "utf8"));
  return { abi: j.abi as Abi, bytecode: j.bytecode.object as Hex };
};

// Deterministic anvil test keys (mnemonic "test test ... junk").
export const ANVIL_KEYS: Hex[] = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
];

export interface ChainHarness {
  rpcUrl: string;
  publicClient: PublicClient;
  keys: Hex[];
  abis: {
    AgentID: Abi;
    CapabilityToken: Abi;
    Publications: Abi;
    ASNPaymaster: Abi;
    ASNTokenBoundAccount: Abi;
    TBAKeyRegistry: Abi;
    ERC6551Registry: Abi;
    CoinbaseSmartWallet: Abi;
    CoinbaseSmartWalletFactory: Abi;
  };
  addr: {
    agentID: Address;
    capabilityToken: Address;
    publications: Address;
    paymaster: Address;
    erc6551Registry: Address;
    tbaImpl: Address;
    tbaKeyRegistry: Address;
    factory: Address;
    implementation: Address;
  };
  createWallet(ownerKey: Hex, salt: bigint): Promise<Address>;
  execute(ownerKey: Hex, wallet: Address, target: Address, data: Hex): Promise<void>;
  /** Generic write from an arbitrary key (e.g. deployer admin calls). */
  send(key: Hex, address: Address, abi: Abi, fn: string, args: unknown[], value?: bigint): Promise<void>;
  /** Deterministic TBA address for an AgentId (ERC-6551 registry.account). */
  tbaAddress(agentId: bigint): Promise<Address>;
  /** Deploy the TBA for an AgentId. */
  createTBA(agentId: bigint): Promise<Address>;
  /** Produce a CBSW ERC-1271 control proof for `challenge` (signs replaySafeHash, wraps). */
  erc1271Proof(ownerKey: Hex, wallet: Address, challenge: Hex): Promise<Hex>;
  blockNumber(): Promise<bigint>;
  stop(): Promise<void>;
}

const ENTRYPOINT_V06: Address = "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789";

function waitPort(rpcUrl: string, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const res = await fetch(rpcUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
        });
        if (res.ok) return resolve();
      } catch {
        /* not up yet */
      }
      if (Date.now() - start > timeoutMs) return reject(new Error("anvil did not start"));
      setTimeout(tick, 150);
    };
    tick();
  });
}

export async function startChain(): Promise<ChainHarness> {
  const port = 8545 + Math.floor((Date.now() % 1000) + Math.random() * 5000);
  const rpcUrl = `http://127.0.0.1:${port}`;
  const proc: ChildProcess = spawn("anvil", ["--port", String(port), "--silent", "--accounts", "10"], {
    stdio: "ignore",
  });
  await waitPort(rpcUrl);

  const transport = http(rpcUrl);
  const publicClient = createPublicClient({ chain: foundry, transport });
  const deployer = privateKeyToAccount(ANVIL_KEYS[0]!);
  const wallet = createWalletClient({ account: deployer, chain: foundry, transport });

  const A = {
    AgentID: artifact("AgentID.sol", "AgentID"),
    CapabilityToken: artifact("CapabilityToken.sol", "CapabilityToken"),
    Publications: artifact("Publications.sol", "Publications"),
    ASNPaymaster: artifact("ASNPaymaster.sol", "ASNPaymaster"),
    ASNTokenBoundAccount: artifact("ASNTokenBoundAccount.sol", "ASNTokenBoundAccount"),
    TBAKeyRegistry: artifact("TBAKeyRegistry.sol", "TBAKeyRegistry"),
    ERC6551Registry: artifact("ERC6551Registry.sol", "ERC6551Registry"),
    CoinbaseSmartWallet: artifact("CoinbaseSmartWallet.sol", "CoinbaseSmartWallet"),
    CoinbaseSmartWalletFactory: artifact("CoinbaseSmartWalletFactory.sol", "CoinbaseSmartWalletFactory"),
  };

  const deploy = async (art: { abi: Abi; bytecode: Hex }, args: unknown[]): Promise<Address> => {
    const hash = await wallet.deployContract({ abi: art.abi, bytecode: art.bytecode, args } as never);
    const rcpt = await publicClient.waitForTransactionReceipt({ hash });
    if (!rcpt.contractAddress) throw new Error("deploy failed");
    return getAddress(rcpt.contractAddress);
  };

  const agentID = await deploy(A.AgentID, ["ipfs://asn/agent/"]);
  const capabilityToken = await deploy(A.CapabilityToken, [agentID]);
  const publications = await deploy(A.Publications, [agentID, capabilityToken]);
  // wire publications into the capability token
  {
    const hash = await wallet.writeContract({
      address: capabilityToken,
      abi: A.CapabilityToken.abi,
      functionName: "setPublications",
      args: [publications],
    });
    await publicClient.waitForTransactionReceipt({ hash });
  }
  const paymaster = await deploy(A.ASNPaymaster, [ENTRYPOINT_V06, deployer.address]);
  const erc6551Registry = await deploy(A.ERC6551Registry, []);
  const tbaImpl = await deploy(A.ASNTokenBoundAccount, []);
  const tbaKeyRegistry = await deploy(A.TBAKeyRegistry, []);
  const implementation = await deploy(A.CoinbaseSmartWallet, []);
  const factory = await deploy(A.CoinbaseSmartWalletFactory, [implementation]);
  const chainId = BigInt(await publicClient.getChainId());
  const TBA_SALT = ("0x" + "00".repeat(32)) as Hex;

  const tbaAddress = async (agentId: bigint): Promise<Address> =>
    (await publicClient.readContract({
      address: erc6551Registry,
      abi: A.ERC6551Registry.abi,
      functionName: "account",
      args: [tbaImpl, TBA_SALT, chainId, agentID, agentId],
    })) as Address;

  const createTBA = async (agentId: bigint): Promise<Address> => {
    const hash = await wallet.writeContract({
      address: erc6551Registry,
      abi: A.ERC6551Registry.abi,
      functionName: "createAccount",
      args: [tbaImpl, TBA_SALT, chainId, agentID, agentId],
    });
    await publicClient.waitForTransactionReceipt({ hash });
    return tbaAddress(agentId);
  };

  // CBSW ERC-1271 control proof: sign replaySafeHash(challenge), wrap in SignatureWrapper.
  const erc1271Proof = async (ownerKey: Hex, walletAddr: Address, challenge: Hex): Promise<Hex> => {
    const rsh = (await publicClient.readContract({
      address: walletAddr,
      abi: A.CoinbaseSmartWallet.abi,
      functionName: "replaySafeHash",
      args: [challenge],
    })) as Hex;
    const account = privateKeyToAccount(ownerKey);
    const sig = await account.sign({ hash: rsh }); // serialized 65-byte ECDSA
    return encodeAbiParameters(
      [{ type: "tuple", components: [{ name: "ownerIndex", type: "uint256" }, { name: "signatureData", type: "bytes" }] }],
      [{ ownerIndex: 0n, signatureData: sig }],
    ) as Hex;
  };

  const send = async (key: Hex, address: Address, abi: Abi, fn: string, args: unknown[], value?: bigint): Promise<void> => {
    const acct = privateKeyToAccount(key);
    const wc = createWalletClient({ account: acct, chain: foundry, transport });
    const hash = await wc.writeContract({ address, abi, functionName: fn, args, ...(value !== undefined ? { value } : {}) } as never);
    await publicClient.waitForTransactionReceipt({ hash });
  };

  const ownersBytes = (owner: Address): Hex[] => [encodeAbiParameters([{ type: "address" }], [owner])];

  const createWallet = async (ownerKey: Hex, salt: bigint): Promise<Address> => {
    const owner = privateKeyToAccount(ownerKey).address;
    const owners = ownersBytes(owner);
    const predicted = (await publicClient.readContract({
      address: factory,
      abi: A.CoinbaseSmartWalletFactory.abi,
      functionName: "getAddress",
      args: [owners, salt],
    })) as Address;
    const hash = await wallet.writeContract({
      address: factory,
      abi: A.CoinbaseSmartWalletFactory.abi,
      functionName: "createAccount",
      args: [owners, salt],
    });
    await publicClient.waitForTransactionReceipt({ hash });
    return getAddress(predicted);
  };

  const execute = async (ownerKey: Hex, walletAddr: Address, target: Address, data: Hex): Promise<void> => {
    const ownerAccount = privateKeyToAccount(ownerKey);
    const wc = createWalletClient({ account: ownerAccount, chain: foundry, transport });
    const hash = await wc.writeContract({
      address: walletAddr,
      abi: A.CoinbaseSmartWallet.abi,
      functionName: "execute",
      args: [target, 0n, data],
    });
    await publicClient.waitForTransactionReceipt({ hash });
  };

  const stop = async (): Promise<void> => {
    proc.kill("SIGKILL");
  };

  return {
    rpcUrl,
    publicClient,
    keys: ANVIL_KEYS,
    abis: {
      AgentID: A.AgentID.abi,
      CapabilityToken: A.CapabilityToken.abi,
      Publications: A.Publications.abi,
      ASNPaymaster: A.ASNPaymaster.abi,
      ASNTokenBoundAccount: A.ASNTokenBoundAccount.abi,
      TBAKeyRegistry: A.TBAKeyRegistry.abi,
      ERC6551Registry: A.ERC6551Registry.abi,
      CoinbaseSmartWallet: A.CoinbaseSmartWallet.abi,
      CoinbaseSmartWalletFactory: A.CoinbaseSmartWalletFactory.abi,
    },
    addr: { agentID, capabilityToken, publications, paymaster, erc6551Registry, tbaImpl, tbaKeyRegistry, factory, implementation },
    createWallet,
    execute,
    send,
    tbaAddress,
    createTBA,
    erc1271Proof,
    blockNumber: async () => publicClient.getBlockNumber(),
    stop,
  };
}

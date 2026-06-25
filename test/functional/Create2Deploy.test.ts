/**
 * Validates the frontend's CREATE2-factory deploy path (used so deployment works from any account
 * type — EOA, EIP-7702 EOA, or smart wallet). Etches the canonical deterministic deployer on anvil,
 * deploys the contracts exactly as the dApp does (encodeDeployData + getContractAddress + a CALL to
 * the deployer), wires setPublications from the deployer (the constructor-supplied admin), and
 * gated-publishes (which exercises registerResource → proves the wiring + admin are correct).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createWalletClient,
  http,
  concat,
  encodeDeployData,
  getContractAddress,
  keccak256,
  stringToBytes,
  toHex,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { startChain, type ChainHarness } from "../helpers/chain.js";

const CREATE2_DEPLOYER: Address = "0x4e59b44847b379578588920cA78FbF26c0B4956C";
const ENTRYPOINT_V06: Address = "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789";
const root = new URL("../../", import.meta.url);
const art = (sol: string, name: string) => {
  const j = JSON.parse(readFileSync(fileURLToPath(new URL(`out/${sol}/${name}.json`, root)), "utf8"));
  return { abi: j.abi as Abi, bytecode: j.bytecode.object as Hex };
};

describe("frontend CREATE2 deploy path", () => {
  let chain: ChainHarness;
  beforeAll(async () => {
    chain = await startChain();
  }, 60_000);
  afterAll(async () => {
    await chain?.stop();
  });

  it("deploys via the deterministic factory, wires, and gated-publishes", async () => {
    const { publicClient, rpcUrl, keys } = chain;
    // etch the canonical deterministic deployer on anvil (present on Base Sepolia for real).
    const deployerCode = readFileSync(fileURLToPath(new URL("test/fixtures/create2_deployer.hex", root)), "utf8").trim();
    await publicClient.request({ method: "anvil_setCode" as never, params: [CREATE2_DEPLOYER, deployerCode] as never });

    const account = privateKeyToAccount(keys[1]!);
    const user = account.address;
    const wallet = createWalletClient({ account, chain: foundry, transport: http(rpcUrl) });
    const salt = toHex(crypto.getRandomValues(new Uint8Array(32)));

    const AgentID = art("AgentID.sol", "AgentID");
    const Capability = art("CapabilityToken.sol", "CapabilityToken");
    const Publications = art("Publications.sol", "Publications");

    // exact dApp logic: initcode + deterministic address, deploy via a CALL to the factory.
    const plan = (a: { abi: Abi; bytecode: Hex }, args: unknown[]) => {
      const initcode = encodeDeployData({ abi: a.abi, bytecode: a.bytecode, args } as never) as Hex;
      const address = getContractAddress({ opcode: "CREATE2", from: CREATE2_DEPLOYER, salt, bytecode: initcode });
      return { initcode, address };
    };
    const deploy = async (initcode: Hex, expected: Address) => {
      const hash = await wallet.sendTransaction({ to: CREATE2_DEPLOYER, data: concat([salt, initcode]) });
      await publicClient.waitForTransactionReceipt({ hash });
      const code = await publicClient.getCode({ address: expected });
      expect(code && code !== "0x").toBeTruthy();
    };

    const agentID = plan(AgentID, ["ipfs://asn/agent/"]);
    const capability = plan(Capability, [agentID.address, user]); // user is the wiring admin
    const publications = plan(Publications, [agentID.address, capability.address]);

    await deploy(agentID.initcode, agentID.address);
    await deploy(capability.initcode, capability.address);
    await deploy(publications.initcode, publications.address);

    // wire (caller = user = the constructor-supplied wirer; a factory-deployed contract would have
    // recorded the factory if it used msg.sender — this proves the constructor-arg fix).
    const wireHash = await wallet.writeContract({
      address: capability.address,
      abi: Capability.abi,
      functionName: "setPublications",
      args: [publications.address],
    });
    await publicClient.waitForTransactionReceipt({ hash: wireHash });
    expect(((await publicClient.readContract({ address: capability.address, abi: Capability.abi, functionName: "publications" })) as Address).toLowerCase()).toBe(publications.address.toLowerCase());

    // mint an identity + gated publish → registerResource runs (only works if wiring succeeded).
    await publicClient.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: agentID.address, abi: AgentID.abi, functionName: "mint", args: [] }) });
    const agentId = (await publicClient.readContract({ address: agentID.address, abi: AgentID.abi, functionName: "totalMinted" })) as bigint;
    const bodyHash = keccak256(stringToBytes("secret body"));
    await publicClient.waitForTransactionReceipt({
      hash: await wallet.writeContract({ address: publications.address, abi: Publications.abi, functionName: "publish", args: [agentId, "bafyGatedCid", bodyHash, 1] }),
    });
    const rid = (await publicClient.readContract({ address: publications.address, abi: Publications.abi, functionName: "resourceIdOf", args: [agentId, 1n] })) as Hex;
    const controller = (await publicClient.readContract({ address: capability.address, abi: Capability.abi, functionName: "resourceController", args: [rid] })) as bigint;
    expect(controller).toBe(agentId); // registerResource succeeded → wiring + admin correct
  });
});

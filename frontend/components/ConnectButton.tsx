"use client";

import { useAccount, useConnect, useDisconnect, useSwitchChain, useChainId } from "wagmi";
import { baseSepolia } from "wagmi/chains";
import { short } from "@/lib/asn";

export function ConnectButton() {
  const { address, isConnected } = useAccount();
  const { connectors, connect, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain } = useSwitchChain();
  const chainId = useChainId();

  if (!isConnected) {
    const cb = connectors.find((c) => c.id === "coinbaseWalletSDK") ?? connectors[0];
    const injected = connectors.find((c) => c.id === "injected");
    return (
      <div className="row">
        {cb && (
          <button onClick={() => connect({ connector: cb })} disabled={isPending}>
            Connect Coinbase Wallet
          </button>
        )}
        {injected && injected.id !== cb?.id && (
          <button className="ghost" onClick={() => connect({ connector: injected })} disabled={isPending}>
            Browser wallet
          </button>
        )}
      </div>
    );
  }

  const wrongChain = chainId !== baseSepolia.id;
  return (
    <div className="row">
      {wrongChain ? (
        <button className="ghost" onClick={() => switchChain({ chainId: baseSepolia.id })}>
          Switch to Base Sepolia
        </button>
      ) : (
        <span className="pill ok">● Base Sepolia</span>
      )}
      <span className="pill mono">{short(address)}</span>
      <button className="ghost" onClick={() => disconnect()}>
        Disconnect
      </button>
    </div>
  );
}

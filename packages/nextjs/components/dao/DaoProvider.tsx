"use client";

import { type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import type { Address, WalletClient } from "viem";
import { useAccount, useSwitchChain, useWalletClient } from "wagmi";
import { FIXTURES_ENABLED, HEDERA_CHAIN_ID, deployment, explorer } from "~~/lib/dao/config";
import { errorMessage } from "~~/lib/dao/errors";
import type { FixtureWorld } from "~~/lib/dao/fixtures/world";
import { createLiveSource } from "~~/lib/dao/live/source";
import type { DaoSource } from "~~/lib/dao/source";
import type { DaoTx, TxResult } from "~~/lib/dao/types";

export type DaoWallet = {
  address?: Address;
  chainId?: number;
  connected: boolean;
  wrongNetwork: boolean;
  connect: () => void;
  switchToHedera: () => void;
};

type DaoContextValue = {
  source: DaoSource;
  /** Changes whenever fixture state changes, so query keys refetch. */
  version: number;
  scenario: string | null;
  wallet: DaoWallet;
  /** Sends a transaction with toasts and refetches afterwards; resolves to null if it failed. */
  run: (tx: DaoTx, label: string) => Promise<TxResult | null>;
  /** Labels of transactions waiting for the wallet or the network. */
  pending: ReadonlySet<string>;
};

const DaoContext = createContext<DaoContextValue | null>(null);

export const useDao = () => {
  const value = useContext(DaoContext);
  if (!value) throw new Error("useDao outside DaoProvider");
  return value;
};

function useLiveWallet(): { wallet: DaoWallet; walletClient?: WalletClient } {
  const { address, chainId, isConnected } = useAccount();
  const { openConnectModal } = useConnectModal();
  const { switchChain } = useSwitchChain();
  const { data: walletClient } = useWalletClient();
  return {
    walletClient,
    wallet: {
      address,
      chainId,
      connected: isConnected,
      wrongNetwork: isConnected && chainId !== HEDERA_CHAIN_ID,
      connect: () => openConnectModal?.(),
      switchToHedera: () => switchChain({ chainId: HEDERA_CHAIN_ID }),
    },
  };
}

/** Fixture worlds load on demand so the scenarios never ship in a normal build's page code. */
function useFixtureWorld(): { world: FixtureWorld | null; scenario: string | null } {
  const [state, setState] = useState<{ world: FixtureWorld | null; scenario: string | null }>({
    world: null,
    scenario: null,
  });
  useEffect(() => {
    if (!FIXTURES_ENABLED) return;
    const name = new URLSearchParams(window.location.search).get("scenario");
    import("~~/lib/dao/fixtures/scenarios").then(({ SCENARIOS, DEFAULT_SCENARIO }) => {
      const scenario = name && SCENARIOS[name] ? name : DEFAULT_SCENARIO;
      const world = SCENARIOS[scenario]();
      (window as unknown as { __dao: unknown }).__dao = world.hooks();
      setState({ world, scenario });
    });
  }, []);
  return state;
}

export function DaoProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const live = useLiveWallet();
  const fixture = useFixtureWorld();
  const walletClientRef = useRef<WalletClient | undefined>(undefined);
  walletClientRef.current = live.walletClient;
  const [version, setVersion] = useState(0);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());

  const liveSource = useMemo(() => createLiveSource(deployment.hedera, () => walletClientRef.current), []);
  const source: DaoSource = fixture.world ?? liveSource;

  useEffect(() => {
    if (!fixture.world) return;
    return fixture.world.subscribe(() => setVersion(v => v + 1));
  }, [fixture.world]);

  const wallet: DaoWallet = useMemo(() => {
    const world = fixture.world;
    if (!world) return live.wallet;
    const address = world.wallet.address ?? undefined;
    return {
      address,
      chainId: world.wallet.chainId,
      connected: !!address,
      wrongNetwork: !!address && world.wallet.chainId !== HEDERA_CHAIN_ID,
      connect: () => world.connect(),
      switchToHedera: () => world.switchToHedera(),
    };
    // version: the world mutates in place
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fixture.world, live.wallet.address, live.wallet.chainId, live.wallet.connected, version]);

  const run = useCallback(
    async (tx: DaoTx, label: string) => {
      if (!wallet.address) {
        wallet.connect();
        return null;
      }
      setPending(p => new Set(p).add(label));
      const id = toast.loading(`${label}: checking, then confirm in your wallet…`);
      try {
        const result = await source.send(tx, wallet.address);
        const link = source.kind === "live" ? explorer.hederaTx(result.hash) : null;
        if (result.ok) {
          toast.success(
            <span>
              {label}: done.{" "}
              {link && (
                <a href={link} target="_blank" rel="noreferrer">
                  HashScan ↗
                </a>
              )}
            </span>,
            { id },
          );
        } else {
          toast.error(
            <span>
              {label}: the transaction reverted.{" "}
              {link && (
                <a href={link} target="_blank" rel="noreferrer">
                  HashScan ↗
                </a>
              )}
            </span>,
            { id },
          );
        }
        await queryClient.invalidateQueries({ queryKey: ["dao"] });
        return result.ok ? result : null;
      } catch (error) {
        toast.error(`${label}: ${errorMessage(error)}`, { id });
        return null;
      } finally {
        setPending(p => {
          const next = new Set(p);
          next.delete(label);
          return next;
        });
      }
    },
    [queryClient, source, wallet],
  );

  // In fixture mode, wait for the scenario so the first render already shows it.
  if (FIXTURES_ENABLED && !fixture.world) return null;

  return (
    <DaoContext.Provider value={{ source, version, scenario: fixture.scenario, wallet, run, pending }}>
      {children}
    </DaoContext.Provider>
  );
}

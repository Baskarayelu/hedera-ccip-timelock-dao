"use client";

import { type ReactNode, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useDao } from "./DaoProvider";
import { Logo } from "./ui";
import { useTheme } from "next-themes";
import { MoonIcon, SunIcon } from "@heroicons/react/24/outline";
import { deployment, explorer } from "~~/lib/dao/config";
import { shortAddress } from "~~/lib/dao/units";

const LINKS = [
  { href: "/", label: "Proposals", short: "Proposals" },
  { href: "/proposals/new", label: "New proposal", short: "New" },
  { href: "/voting-power", label: "Voting power", short: "Voting power" },
];

function isCurrent(pathname: string, href: string) {
  if (href === "/") return pathname === "/" || (pathname.startsWith("/proposals/") && pathname !== "/proposals/new");
  return pathname === href;
}

function ThemeToggle({ className = "" }: { className?: string }) {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const dark = mounted && resolvedTheme === "dark";
  return (
    <button
      type="button"
      className={`icon-btn theme-toggle ${className}`}
      aria-label={dark ? "Use the light theme" : "Use the dark theme"}
      onClick={() => setTheme(dark ? "light" : "dark")}
    >
      {dark ? <SunIcon width={20} height={20} /> : <MoonIcon width={20} height={20} />}
    </button>
  );
}

function WalletButton() {
  const { wallet } = useDao();
  if (!wallet.connected || !wallet.address) {
    return (
      <button type="button" className="dbtn dbtn-primary" onClick={wallet.connect}>
        Connect wallet
      </button>
    );
  }
  return (
    <a
      className="dbtn dbtn-mono"
      href={explorer.hederaAccount(wallet.address)}
      target="_blank"
      rel="noreferrer"
      title="Your account on HashScan"
    >
      {shortAddress(wallet.address)}
    </a>
  );
}

function Nav({ className, short }: { className: string; short?: boolean }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Main" className={`nav ${className}`}>
      {LINKS.map(link => (
        <Link key={link.href} href={link.href} aria-current={isCurrent(pathname, link.href) ? "page" : undefined}>
          {short ? link.short : link.label}
        </Link>
      ))}
    </nav>
  );
}

function WrongNetwork() {
  const { wallet } = useDao();
  if (!wallet.wrongNetwork) return null;
  return (
    <div role="alert" className="network-alert">
      <div className="vstack">
        <span style={{ fontWeight: 600 }}>Your wallet is on another network (chain {wallet.chainId})</span>
        <span className="small muted">
          This DAO lives on Hedera testnet (chain 296). Reading still works; voting and proposing need the switch.
        </span>
      </div>
      <button type="button" className="dbtn dbtn-bad" onClick={wallet.switchToHedera}>
        Switch to Hedera testnet
      </button>
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const { wallet, source } = useDao();
  return (
    <div className="dao">
      <header className="dao-header">
        <Link href="/" className="brand">
          <Logo />
          <span>
            <span className="brand-name">CCIP Timelock DAO</span>
            <span className="brand-sub">Hedera testnet · Base Sepolia</span>
          </span>
        </Link>
        <Nav className="nav-wide" />
        <div className="header-right">
          <span className="net-chip">
            <span className={`dot ${wallet.wrongNetwork ? "bad" : ""}`} />
            {wallet.wrongNetwork ? "Wrong network" : "Hedera testnet"}
          </span>
          <ThemeToggle />
          <WalletButton />
        </div>
      </header>
      <Nav className="nav-narrow" short />
      <WrongNetwork />
      {children}
      <footer className="dao-footer">
        <span>
          {source.kind === "fixture" ? "Fixture data for tests. " : ""}
          Governor and timelock on Hedera; executor on Base Sepolia at{" "}
          <a href={explorer.baseAddress(deployment.base.executor)} target="_blank" rel="noreferrer" className="mono">
            {shortAddress(deployment.base.executor)}
          </a>
          .
        </span>
        <nav aria-label="More" style={{ alignItems: "center" }}>
          <ThemeToggle />
          {source.addresses && (
            <a href={explorer.hederaContract(source.addresses.governor)} target="_blank" rel="noreferrer">
              Governor on HashScan
            </a>
          )}
          <Link href="/debug">Debug contracts</Link>
          <a href="https://github.com/Baskarayelu/hedera-ccip-timelock-dao" target="_blank" rel="noreferrer">
            Source
          </a>
        </nav>
      </footer>
    </div>
  );
}

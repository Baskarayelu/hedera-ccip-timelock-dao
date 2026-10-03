import { type ReactNode, useEffect, useState } from "react";
import type { Banner as BannerView, Chip as ChipName, Tone } from "~~/lib/dao/derive";
import type { TextPart } from "~~/lib/dao/proposal";

const ICONS: Record<Tone, string> = { ok: "✓", info: "i", warn: "!", bad: "×", neutral: "–" };

export function Banner({
  banner,
  role = "status",
  children,
}: {
  banner: BannerView;
  role?: string;
  children?: ReactNode;
}) {
  return (
    <div role={role} className={`banner tone-${banner.tone}`} data-testid="banner">
      <span aria-hidden="true" className="banner-icon">
        {ICONS[banner.tone]}
      </span>
      <div className="banner-text">
        <span className="banner-title">{banner.title}</span>
        {banner.body && <span className="banner-body">{banner.body}</span>}
        {children}
      </div>
    </div>
  );
}

export const Chip = ({ name }: { name: ChipName }) => <span className={`chip chip-${name}`}>{name}</span>;

export const Parts = ({ parts }: { parts: TextPart[] }) => (
  <>
    {parts.map((p, i) =>
      p.mono ? (
        <span key={i} className="mono">
          {p.text}
        </span>
      ) : (
        <span key={i}>{p.text}</span>
      ),
    )}
  </>
);

export const ClockIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
    <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.5" />
    <path d="M8 4.5V8l2.5 1.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);

export const PlusIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>
);

export const CloseIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
  </svg>
);

export const Logo = () => (
  <svg width="32" height="32" viewBox="0 0 32 32" fill="none" aria-hidden="true" style={{ color: "var(--accent)" }}>
    <rect x="1" y="1" width="30" height="30" rx="8" stroke="currentColor" strokeWidth="2" />
    <circle cx="11" cy="16" r="4" stroke="currentColor" strokeWidth="2" />
    <circle cx="22" cy="16" r="4" stroke="currentColor" strokeWidth="2" />
    <path d="M15 16h3" stroke="currentColor" strokeWidth="2" />
  </svg>
);

/** Shown while a query loads or when it failed. */
export function LoadState({ error, label }: { error: unknown; label: string }) {
  if (error) {
    return (
      <Banner
        banner={{
          tone: "bad",
          title: `Could not load ${label}`,
          body: `${(error as Error).message ?? String(error)}. It retries every few seconds.`,
        }}
      />
    );
  }
  return <Loading label={label} />;
}

/** After 15 s of loading, say so: a public testnet service is slow and the page is still retrying. */
const SLOW_MS = 15_000;

function Loading({ label }: { label: string }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), SLOW_MS);
    return () => clearTimeout(timer);
  }, []);
  return (
    <div className="vstack-lg" aria-busy="true" aria-label={`Loading ${label}`}>
      {slow && (
        <p className="small muted" data-testid="still-loading" style={{ margin: 0 }}>
          Still loading {label}: a testnet service is slow to answer, and the page keeps retrying.
        </p>
      )}
      <div className="ghost" />
      <div className="ghost" />
    </div>
  );
}

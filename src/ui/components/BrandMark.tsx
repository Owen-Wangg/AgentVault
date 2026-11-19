/**
 * The AgentVault mark (telemetry-dashboard UI-28): the tab icon's
 * two-tone shield with an agent's two eyes, colored from the theme
 * tokens so Kiroween mode recolors it. Decorative: the link it sits in is
 * named by the app name beside it.
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" focusable="false" className={className}>
      <path d="M16 3.5 5 7.6v6.7c0 6.5 4.6 11.9 11 13.9 6.4-2 11-7.4 11-13.9V7.6L16 3.5Z" fill="var(--accent-soft)" />
      <path d="M16 3.5 5 7.6v6.7c0 6.5 4.6 11.9 11 13.9Z" fill="var(--accent)" />
      <path d="M12 12.5v3.4M20 12.5v3.4" stroke="var(--accent-text)" strokeWidth="2.7" strokeLinecap="round" />
    </svg>
  );
}

export function LineaLogo({ size = 34, className = "" }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 34 34" fill="none" className={className} aria-hidden="true">
      <rect x="0.5" y="0.5" width="33" height="33" rx="10" fill="rgba(166,255,94,0.14)" stroke="rgba(166,255,94,0.25)" />
      <g transform="translate(7 8.8) scale(0.909)">
        <path d="M2 13 C5 4, 9 4, 11 9 C13 14, 17 14, 20 5" stroke="#a6ff5e" strokeWidth="2.6" strokeLinecap="round" fill="none" />
      </g>
    </svg>
  );
}
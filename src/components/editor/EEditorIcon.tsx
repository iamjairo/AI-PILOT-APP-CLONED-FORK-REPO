/**
 * @file e-Editor brand icon — inline SVG (flat monitor + code + pencil),
 * mirrors resources/e-editor-icon.svg without the background tile.
 */
export function EEditorIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="180 180 700 700" aria-hidden="true">
      <rect x="464" y="716" width="96" height="80" fill="#1c4467" />
      <rect x="384" y="782" width="256" height="52" rx="26" fill="#2d6390" />
      <rect x="222" y="220" width="580" height="512" rx="46" fill="#2d6390" />
      <rect x="262" y="256" width="500" height="440" rx="26" fill="#58aede" />
      <rect x="282" y="274" width="460" height="404" rx="16" fill="#14395f" />
      <path d="M282 290 a16 16 0 0 1 16 -16 h428 a16 16 0 0 1 16 16 v54 h-460 Z" fill="#f2b32c" />
      <circle cx="322" cy="301" r="11" fill="#c93646" />
      <circle cx="360" cy="301" r="11" fill="#58aede" />
      <circle cx="398" cy="301" r="11" fill="#1c4467" />
      <g stroke="#ffffff" strokeWidth="34" strokeLinecap="round" strokeLinejoin="round" fill="none">
        <path d="M418 436 L352 508 L418 580" />
        <path d="M556 436 L622 508 L556 580" />
        <path d="M512 424 L462 592" />
      </g>
      <g transform="rotate(45 700 560)">
        <rect x="668" y="330" width="86" height="238" rx="10" fill="#58aede" />
        <rect x="668" y="330" width="86" height="46" rx="10" fill="#7fc4ea" />
        <rect x="668" y="300" width="86" height="48" rx="18" fill="#c93646" />
        <path d="M668 568 h86 L724 660 a14 14 0 0 1 -26 0 Z" fill="#f0cba4" />
        <path d="M718 634 L724 660 a14 14 0 0 1 -26 0 L704 634 Z" fill="#16395c" />
      </g>
    </svg>
  );
}

export default EEditorIcon;

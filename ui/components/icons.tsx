// Inline SVG icon set (Lucide-derived, MIT). Replaces emoji used as UI icons
// across the app so glyphs render identically on every platform, inherit
// `currentColor` for theming, and scale crisply. Stroke-based, 1.75px, 24-grid.
//
// Usage: <Check className="w-4 h-4" />  — size + color come from Tailwind classes
// on the element (width/height via w-*/h-*, color via text-*). Decorative by
// default (aria-hidden); pass a `title` to make an icon meaningful to AT.

import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { title?: string };

function Base({ title, children, ...props }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      width="1em"
      height="1em"
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
      {...props}
    >
      {title ? <title>{title}</title> : null}
      {children}
    </svg>
  );
}

export const Check = (p: IconProps) => (
  <Base {...p}><path d="M20 6 9 17l-5-5" /></Base>
);

export const X = (p: IconProps) => (
  <Base {...p}><path d="M18 6 6 18M6 6l12 12" /></Base>
);

export const ArrowRight = (p: IconProps) => (
  <Base {...p}><path d="M5 12h14M13 5l7 7-7 7" /></Base>
);

export const ArrowLeft = (p: IconProps) => (
  <Base {...p}><path d="M19 12H5M11 19l-7-7 7-7" /></Base>
);

export const Clock = (p: IconProps) => (
  <Base {...p}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></Base>
);

export const Sun = (p: IconProps) => (
  <Base {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
  </Base>
);

export const Moon = (p: IconProps) => (
  <Base {...p}><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z" /></Base>
);

export const Info = (p: IconProps) => (
  <Base {...p}><circle cx="12" cy="12" r="9" /><path d="M12 16v-4M12 8h.01" /></Base>
);

export const Lock = (p: IconProps) => (
  <Base {...p}><rect x="4" y="11" width="16" height="9" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></Base>
);

export const Calendar = (p: IconProps) => (
  <Base {...p}><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M16 3v4M8 3v4M3 10h18" /></Base>
);

export const Bolt = (p: IconProps) => (
  <Base {...p}><path d="M13 2 4.5 13.5H11l-1 8.5 8.5-11.5H12l1-8.5Z" /></Base>
);

export const ShieldCheck = (p: IconProps) => (
  <Base {...p}><path d="M12 3 5 6v5c0 4.5 3 8.3 7 9.5 4-1.2 7-5 7-9.5V6l-7-3Z" /><path d="m9 12 2 2 4-4" /></Base>
);

export const Terminal = (p: IconProps) => (
  <Base {...p}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m7 9 3 3-3 3M13 15h4" /></Base>
);

export const Layers = (p: IconProps) => (
  <Base {...p}><path d="m12 2 9 5-9 5-9-5 9-5Z" /><path d="m3 12 9 5 9-5M3 17l9 5 9-5" /></Base>
);

export const Activity = (p: IconProps) => (
  <Base {...p}><path d="M22 12h-4l-3 9L9 3l-3 9H2" /></Base>
);

export const Spinner = ({ className = "", ...p }: IconProps) => (
  <svg
    viewBox="0 0 24 24"
    width="1em"
    height="1em"
    aria-hidden
    className={`animate-spin ${className}`}
    {...p}
  >
    <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth={2.5} opacity={0.25} />
    <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" />
  </svg>
);

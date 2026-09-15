import type { ReactNode, SVGProps } from "react";

type IconName =
  | "archive" | "audio" | "back" | "check" | "chevron" | "clock" | "code"
  | "download" | "edit" | "export" | "eye" | "file" | "folder" | "heart" | "history"
  | "image" | "info" | "grid" | "list" | "location" | "more" | "open" | "play" | "refresh"
  | "search" | "settings" | "shield" | "spark" | "star" | "trash" | "video" | "warning";

const paths: Record<IconName, ReactNode> = {
  archive: <><path d="M4 7h16v13H4z"/><path d="M3 4h18v4H3zM9 12h6"/></>,
  audio: <><path d="M9 18V5l10-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="16" cy="16" r="3"/></>,
  back: <path d="m15 18-6-6 6-6"/>,
  check: <path d="m5 12 4 4L19 6"/>,
  chevron: <path d="m8 10 4 4 4-4"/>,
  clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
  code: <><path d="m8 9-4 3 4 3M16 9l4 3-4 3M14 5l-4 14"/></>,
  download: <><path d="M12 3v12m-5-5 5 5 5-5"/><path d="M5 20h14"/></>,
  edit: <><path d="m4 20 4-1 10-10-3-3L5 16z"/><path d="m13 8 3 3"/></>,
  export: <><path d="M14 3h7v7M10 14 21 3"/><path d="M18 13v7H4V6h7"/></>,
  eye: <><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></>,
  file: <><path d="M6 2h8l4 4v16H6z"/><path d="M14 2v5h5"/></>,
  folder: <path d="M3 6h7l2 2h9v11H3z"/>,
  heart: <path d="M20.8 8.6c0 5.3-8.8 10.4-8.8 10.4S3.2 13.9 3.2 8.6A4.6 4.6 0 0 1 12 6.7a4.6 4.6 0 0 1 8.8 1.9Z"/>,
  history: <><path d="M4 7v5h5"/><path d="M5.5 16a8 8 0 1 0-.8-8"/></>,
  image: <><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m4 17 5-4 4 3 3-2 4 3"/></>,
  info: <><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/></>,
  grid: <><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></>,
  list: <path d="M9 5h12M9 12h12M9 19h12M3 5h1M3 12h1M3 19h1"/>,
  location: <><path d="M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/></>,
  more: <><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></>,
  open: <><path d="M14 4h6v6M11 13l9-9"/><path d="M18 13v7H4V6h7"/></>,
  play: <path d="m9 6 9 6-9 6z"/>,
  refresh: <><path d="M20 7v5h-5"/><path d="M18 16a8 8 0 1 1 1-7l1 3"/></>,
  search: <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></>,
  settings: <><circle cx="12" cy="12" r="3"/><path d="M19 13.5v-3l-2-.7-.7-1.7.9-1.9-2.1-2.1-1.9.9-1.7-.7L10.5 2h-3l-.7 2-1.7.7-1.9-.9-2.1 2.1.9 1.9-.7 1.7-2 .7v3l2 .7.7 1.7-.9 1.9 2.1 2.1 1.9-.9 1.7.7.7 2h3l.7-2 1.7-.7 1.9.9 2.1-2.1-.9-1.9.7-1.7z" transform="translate(1.5) scale(.88)"/></>,
  shield: <><path d="M12 3 20 6v5c0 5-3.5 8-8 10-4.5-2-8-5-8-10V6z"/><path d="m8.5 12 2 2 4.5-5"/></>,
  spark: <><path d="m12 3 1.5 5.5L19 10l-5.5 1.5L12 17l-1.5-5.5L5 10l5.5-1.5z"/><path d="m19 16 .7 2.3L22 19l-2.3.7L19 22l-.7-2.3L16 19l2.3-.7z"/></>,
  star: <path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9z" />,
  trash: <><path d="M4 7h16M9 3h6l1 4H8zM6 7l1 14h10l1-14"/><path d="M10 11v6M14 11v6"/></>,
  video: <><rect x="3" y="5" width="14" height="14" rx="2"/><path d="m17 10 4-2v8l-4-2z"/></>,
  warning: <><path d="M12 3 2.8 20h18.4z"/><path d="M12 9v4M12 17h.01"/></>,
};

export function Icon({ name, ...props }: { name: IconName } & SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...props}>
      {paths[name]}
    </svg>
  );
}

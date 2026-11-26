import type { SVGProps } from "react";

import { cn } from "../../lib/utils";
import { formatMemoBadgeCount } from "./memoLaunch.logic";

// Font sizes are in viewBox units (24 units = 16px), tuned so each length stays
// inside the note body and clear of the folded corner.
const COUNT_FONT_SIZE_BY_LENGTH: Record<number, number> = { 1: 11, 2: 9, 3: 7 };

export interface MemoSidebarIconProps extends Omit<SVGProps<SVGSVGElement>, "children"> {
  readonly count: number;
}

export function MemoSidebarIcon({ count, className, ...props }: MemoSidebarIconProps) {
  const countText = formatMemoBadgeCount(count);

  return (
    <svg
      aria-hidden="true"
      className={cn("size-4", className)}
      data-memo-count={count}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <path d="M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v11l-5 5H5a2 2 0 0 1-2-2z" />
      <path d="M16 21v-3a2 2 0 0 1 2-2h3" />
      {countText === null ? (
        <g data-memo-face="smile">
          <path d="M9 9h.01" />
          <path d="M15 9h.01" />
          <path d="M8.5 12.75q3.5 2.75 7 0" />
        </g>
      ) : (
        <text
          data-memo-face="count"
          dominantBaseline="central"
          fill="currentColor"
          fontSize={COUNT_FONT_SIZE_BY_LENGTH[countText.length] ?? 7}
          fontWeight={700}
          letterSpacing={countText.length > 2 ? -0.4 : 0}
          stroke="none"
          style={{ fontVariantNumeric: "tabular-nums" }}
          textAnchor="middle"
          x={11.5}
          y={11.25}
        >
          {countText}
        </text>
      )}
    </svg>
  );
}

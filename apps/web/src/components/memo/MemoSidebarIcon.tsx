import type { SVGProps } from "react";

import { cn } from "../../lib/utils";
import { formatMemoBadgeCount } from "./memoLaunch.logic";

// Font sizes are in viewBox units (24 units = 16px), tuned so each length stays
// inside the note body and clear of the folded corner.
const COUNT_FONT_SIZE_BY_LENGTH: Record<number, number> = { 1: 11.5, 2: 9.25, 3: 7.25 };

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
      strokeWidth={1.75}
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <path d="M2.5 4.75a2.25 2.25 0 0 1 2.25-2.25h14.5a2.25 2.25 0 0 1 2.25 2.25v11.5l-5.25 5.25H4.75a2.25 2.25 0 0 1-2.25-2.25z" />
      <path d="M16.25 21.5v-3a2.25 2.25 0 0 1 2.25-2.25h3" />
      {countText === null ? (
        <g data-memo-face="smile">
          <path d="M9 9.25h.01" />
          <path d="M15 9.25h.01" />
          <path d="M8.5 13q3.5 2.75 7 0" />
        </g>
      ) : (
        <text
          data-memo-face="count"
          dominantBaseline="central"
          fill="currentColor"
          fontSize={COUNT_FONT_SIZE_BY_LENGTH[countText.length] ?? 7.25}
          fontWeight={650}
          letterSpacing={countText.length > 2 ? -0.35 : 0}
          stroke="none"
          style={{ fontVariantNumeric: "tabular-nums" }}
          textAnchor="middle"
          x={11.75}
          y={11.5}
        >
          {countText}
        </text>
      )}
    </svg>
  );
}

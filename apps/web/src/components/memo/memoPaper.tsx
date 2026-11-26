import type { MemoColor } from "@t3tools/contracts";

import { cn } from "~/lib/utils";

export const MEMO_COLORS: ReadonlyArray<MemoColor> = ["amber", "sage", "sky", "rose", "lavender"];

export interface MemoPaperPalette {
  /** Paper body: a soft top-to-bottom tint plus a hairline inset edge. */
  readonly paper: string;
  /** Underside of the dog-eared corner, layered over the paper tint. */
  readonly fold: string;
  /** Composer focus halo. */
  readonly focus: string;
  /** Solid-ish chip used by the color swatch picker. */
  readonly swatch: string;
}

/**
 * Sticky-note tints mapped onto declared semantic tokens (`warning` amber, `success` sage,
 * `info` sky, `error` rose, `guest` lavender). Translucent tints sit on the popover surface,
 * so light mode reads as pale pastel paper and dark mode as low-glare tinted card stock.
 */
export const MEMO_PAPER_PALETTE: Readonly<Record<MemoColor, MemoPaperPalette>> = {
  amber: {
    paper:
      "bg-linear-to-b from-warning/16 to-warning/9 ring-warning/28 dark:from-warning/18 dark:to-warning/10 dark:ring-warning/22",
    fold: "to-warning/40 dark:to-warning/30",
    focus: "focus-within:ring-warning/55",
    swatch: "bg-warning/75",
  },
  sage: {
    paper:
      "bg-linear-to-b from-success/15 to-success/8 ring-success/26 dark:from-success/16 dark:to-success/9 dark:ring-success/22",
    fold: "to-success/38 dark:to-success/28",
    focus: "focus-within:ring-success/50",
    swatch: "bg-success/70",
  },
  sky: {
    paper:
      "bg-linear-to-b from-info/14 to-info/7 ring-info/26 dark:from-info/16 dark:to-info/9 dark:ring-info/22",
    fold: "to-info/36 dark:to-info/28",
    focus: "focus-within:ring-info/50",
    swatch: "bg-info/70",
  },
  rose: {
    paper:
      "bg-linear-to-b from-error/13 to-error/7 ring-error/24 dark:from-error/15 dark:to-error/8 dark:ring-error/22",
    fold: "to-error/34 dark:to-error/26",
    focus: "focus-within:ring-error/45",
    swatch: "bg-error/65",
  },
  lavender: {
    paper:
      "bg-linear-to-b from-guest/13 to-guest/7 ring-guest/24 dark:from-guest/15 dark:to-guest/8 dark:ring-guest/22",
    fold: "to-guest/34 dark:to-guest/26",
    focus: "focus-within:ring-guest/45",
    swatch: "bg-guest/65",
  },
};

/** Matte translucent washi tape holding the note to the surface. */
export function MemoPaperTape({ className }: { readonly className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute -top-2 left-1/2 h-3.5 w-14 -translate-x-1/2 -rotate-2 rounded-xs bg-background/60 shadow-2xs ring-1 ring-foreground/6 backdrop-blur-xs dark:bg-foreground/12 dark:ring-foreground/8",
        className,
      )}
    />
  );
}

/**
 * Dog-eared top-right corner. The upper half repaints the popover surface so the paper
 * looks cut, which means notes must sit directly on a `bg-popover` surface.
 */
export function MemoPaperFold({ fold }: { readonly fold: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute top-0 right-0 size-4 rounded-bl-md bg-linear-to-bl from-popover from-50% to-50%",
        fold,
      )}
    />
  );
}

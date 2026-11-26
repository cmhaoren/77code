import type { EnvironmentId, Memo } from "@t3tools/contracts";
import { useParams } from "@tanstack/react-router";
import { AsyncResult, Atom } from "effect/reactivity";
import { create } from "zustand";

import { useEnvironments, usePrimaryEnvironmentId } from "./state/environments";

interface MemoDrawerState {
  readonly isOpen: boolean;
  readonly open: () => void;
  readonly close: () => void;
  readonly setOpen: (open: boolean) => void;
  readonly toggleOpen: () => void;
}

export const useMemoDrawerStore = create<MemoDrawerState>((set) => ({
  isOpen: false,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
  setOpen: (open) => set({ isOpen: open }),
  toggleOpen: () => set((state) => ({ isOpen: !state.isOpen })),
}));

export const EMPTY_MEMOS_ATOM = Atom.make<
  AsyncResult.AsyncResult<{ readonly memos: ReadonlyArray<Memo> }>
>(AsyncResult.success({ memos: [] })).pipe(Atom.withLabel("memos:empty"));

export const ALLOW_OPERATE_ATOM = Atom.make(false).pipe(Atom.withLabel("memos:no-env-permission"));

/** Prefer the active thread route's environment, else primary, else the first connected environment. */
export function useActiveMemoEnvironmentId(): EnvironmentId | null {
  const params = useParams({ strict: false }) as { readonly environmentId?: string };
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  if (params.environmentId) {
    const matched = environments.find((entry) => entry.environmentId === params.environmentId);
    if (matched) return matched.environmentId;
  }
  if (primaryEnvironmentId !== null) return primaryEnvironmentId;
  const connected = environments.find((entry) => entry.connection.phase === "connected");
  return connected?.environmentId ?? environments[0]?.environmentId ?? null;
}

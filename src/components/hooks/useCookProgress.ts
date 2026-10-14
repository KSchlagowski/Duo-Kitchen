import { useMemo, useState, useSyncExternalStore } from "react";
import type { CookModeView } from "@/types";
import { cookPath } from "@/lib/services/cook-mode";

// The current step and the per-device done ticks of one cook-mode session (S-11, D1). Nothing reaches
// the server: the step lives in the `step` URL parameter (replaced, never pushed, so Back leaves the
// page) and the ticks in localStorage under `duo-kitchen:cook:<planId>:<sessionKey>`, as step ids.
// Storage is read through useSyncExternalStore with a null server snapshot, so the server render and
// the hydrating render agree and the ticks appear right after. Blocked storage (private mode) falls
// back to memory for the page's lifetime.

const listeners = new Set<() => void>();
const memory = new Map<string, string>();

function readRaw(key: string): string | null {
  try {
    return window.localStorage.getItem(key) ?? memory.get(key) ?? null;
  } catch {
    return memory.get(key) ?? null;
  }
}

function writeRaw(key: string, value: string) {
  memory.set(key, value);
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Blocked or full storage: the in-memory copy keeps the ticks until the page is left.
  }
  for (const listener of listeners) listener();
}

// Also follows the `storage` event, so a tick made in another tab of the same session shows here.
function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

function parseIds(raw: string | null): string[] {
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

export function useCookProgress(view: CookModeView, initialStep: number) {
  const key = `duo-kitchen:cook:${view.planId}:${view.sessionKey}`;
  const total = view.steps.length;
  const [current, setCurrent] = useState(initialStep);

  const raw = useSyncExternalStore(
    subscribe,
    () => readRaw(key),
    () => null,
  );
  // Ids of steps no longer in the session (a plan edit) are dropped on load.
  const done = useMemo<ReadonlySet<string>>(() => {
    const ids = new Set(view.steps.map((step) => step.id));
    return new Set(parseIds(raw).filter((id) => ids.has(id)));
  }, [raw, view.steps]);

  const save = (next: ReadonlySet<string>) => {
    writeRaw(key, JSON.stringify([...next]));
  };

  const goTo = (n: number) => {
    const step = Math.min(Math.max(n, 1), Math.max(total, 1));
    setCurrent(step);
    window.history.replaceState(window.history.state, "", cookPath(view.startDate, view.sessionKey, step));
  };

  const toggleDone = (stepId: string) => {
    const next = new Set(done);
    if (next.has(stepId)) {
      next.delete(stepId);
    } else {
      next.add(stepId);
    }
    save(next);
  };

  // Marks the current step done and moves on; the last step is only marked.
  const doneAndNext = () => {
    const step = view.steps[current - 1] as (typeof view.steps)[number] | undefined;
    if (step && !done.has(step.id)) save(new Set(done).add(step.id));
    if (current < total) goTo(current + 1);
  };

  return { current, goTo, done, toggleDone, doneAndNext };
}

import type React from "react";
import { useEffect, useRef, useSyncExternalStore } from "react";
import type { CookModeView, SessionSectionKind, StepTiming } from "@/types";
import { useCookProgress } from "@/components/hooks/useCookProgress";
import { useWakeLock } from "@/components/hooks/useWakeLock";
import { cookPath, formatDoneCount, formatStepCounter, formatStepDuration } from "@/lib/services/cook-mode";
import { COOK_MODE_LABELS } from "@/lib/recipe-labels";
import { cn } from "@/lib/utils";

// The step card, navigation and All steps list of /plan/sessions/cook (S-11). Server-rendered with the
// same markup, testids and links as the no-JS page, so every step stays reachable through `?step=N`
// before (and without) hydration. Once hydrated, a plain click switches steps in place, and the Done
// button, the per-step ticks, the done count and Keep screen on appear. It imports only the pure
// cook-mode.ts, never cooking.ts or day-solutions.ts, so no solver, zod or Supabase code reaches the
// browser.
interface Props {
  view: CookModeView;
  initialStep: number;
  labels: { sections: Record<SessionSectionKind, string>; timings: Record<StepTiming, string> };
}

const noSubscribe = () => () => undefined;

const navClass =
  "inline-flex min-h-11 items-center rounded-lg border border-white/20 bg-white/10 px-4 py-2 text-sm transition-colors hover:bg-white/20";

export default function CookMode({ view, initialStep, labels }: Props) {
  const { current: currentNumber, goTo, done, toggleDone, doneAndNext } = useCookProgress(view, initialStep);
  const wakeLock = useWakeLock();
  // False on the server and while hydrating, so both renders match; true right after.
  const hydrated = useSyncExternalStore(
    noSubscribe,
    () => true,
    () => false,
  );
  const heading = useRef<HTMLHeadingElement>(null);
  const focusPending = useRef(false);

  const { steps } = view;
  const current = steps[currentNumber - 1];
  const evening = view.part === "evening";
  const sessionsPath = `/plan/sessions?start=${view.startDate}#${view.sessionKey}`;

  // After an in-place change only (never on load): announce the new step and scroll it into view.
  useEffect(() => {
    if (focusPending.current) {
      focusPending.current = false;
      heading.current?.focus();
    }
  }, [currentNumber]);

  const move = (n: number) => {
    focusPending.current = true;
    goTo(n);
  };

  // A plain left click switches in place; a modified one keeps the link's native behaviour (new tab).
  const onNavigate = (event: React.MouseEvent<HTMLAnchorElement>, n: number) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    move(n);
  };

  const onDone = () => {
    if (current.number < steps.length) focusPending.current = true;
    doneAndNext();
  };

  return (
    <>
      <section
        id="cook-step"
        data-testid="cook-step"
        data-step-id={current.id}
        className="mt-6 rounded-xl border border-purple-300/30 bg-white/5 p-4"
      >
        <p className="text-sm text-blue-100/70" data-testid="cook-step-counter">
          {formatStepCounter(current.number, steps.length)}
        </p>
        {evening && (
          <p className="mt-1 text-xs font-semibold tracking-wide text-purple-200 uppercase">
            {labels.sections[current.sectionKind]}
          </p>
        )}
        <h2 ref={heading} tabIndex={-1} className="mt-2 text-sm text-blue-100/80 focus:outline-none">
          {current.componentName === null ? current.recipeName : `${current.recipeName} · ${current.componentName}`}
        </h2>
        <p className={cn("mt-1 text-xl font-semibold", done.has(current.id) && "text-blue-100/60 line-through")}>
          {current.instruction}
        </p>
        <p className="mt-2 text-xs text-blue-100/60">
          <span
            className={cn(
              "rounded px-1.5 py-0.5",
              current.timing === "make_ahead" ? "bg-purple-500/20 text-purple-200" : "bg-amber-500/20 text-amber-100",
            )}
          >
            {labels.timings[current.timing]}
          </span>
          {` · ${formatStepDuration(current.durationMinutes)}`}
        </p>

        {current.amounts.length > 0 && (
          <div className="mt-4">
            <h3 className="text-sm font-semibold text-purple-200">{COOK_MODE_LABELS.amounts}</h3>
            {current.amounts.map((batch) => (
              <div key={batch.dishId} className="mt-1">
                {batch.heading && <p className="text-xs text-blue-100/70">{batch.heading}</p>}
                <ul className="space-y-0.5 text-sm" data-testid="cook-step-amounts">
                  {batch.ingredients.map((ingredient) => (
                    <li key={ingredient.ingredientId}>
                      <span className="text-white">{ingredient.productName}</span>
                      <span className="text-blue-100/80">{` ${ingredient.amount}`}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}

        {current.portions && (
          <div className="mt-4" data-testid="cook-step-portions">
            <h3 className="text-sm font-semibold text-purple-200">{COOK_MODE_LABELS.portions}</h3>
            {current.portions.map((batch) => (
              <div key={batch.dishId} className="mt-1">
                {batch.heading && <p className="text-xs text-blue-100/70">{batch.heading}</p>}
                {batch.lines.map((line, i) => (
                  <p key={i} className="text-sm text-purple-100">
                    {line.componentName === null ? line.line : `${line.componentName}: ${line.line}`}
                  </p>
                ))}
              </div>
            ))}
          </div>
        )}
      </section>

      <nav className="mt-4 flex flex-wrap justify-between gap-2" aria-label="Steps">
        {current.number > 1 ? (
          <a
            href={cookPath(view.startDate, view.sessionKey, current.number - 1)}
            className={navClass}
            data-testid="cook-prev"
            onClick={(event) => {
              onNavigate(event, current.number - 1);
            }}
          >
            {COOK_MODE_LABELS.previous}
          </a>
        ) : (
          <span />
        )}
        {hydrated && (
          <button
            type="button"
            className={cn(navClass, "border-purple-300/40 bg-purple-500/30 hover:bg-purple-500/40")}
            data-testid="cook-done-next"
            onClick={onDone}
          >
            {COOK_MODE_LABELS.doneNext}
          </button>
        )}
        {current.number < steps.length ? (
          <a
            href={cookPath(view.startDate, view.sessionKey, current.number + 1)}
            className={navClass}
            data-testid="cook-next"
            onClick={(event) => {
              onNavigate(event, current.number + 1);
            }}
          >
            {COOK_MODE_LABELS.next}
          </a>
        ) : (
          <a href={sessionsPath} className={navClass} data-testid="cook-finish">
            {COOK_MODE_LABELS.finish}
          </a>
        )}
      </nav>

      {hydrated && wakeLock.supported && (
        <label className="mt-3 flex min-h-11 items-center gap-2 text-sm" data-testid="cook-wake-lock">
          <input
            type="checkbox"
            className="size-4"
            checked={wakeLock.active}
            onChange={(event) => {
              wakeLock.setActive(event.currentTarget.checked);
            }}
          />
          {COOK_MODE_LABELS.keepScreenOn}
        </label>
      )}

      <section className="mt-6">
        <h2 className="text-lg font-semibold">{COOK_MODE_LABELS.allSteps}</h2>
        {hydrated && (
          <p className="text-sm text-blue-100/70" aria-live="polite" data-testid="cook-done-count">
            {formatDoneCount(done.size, steps.length)}
          </p>
        )}
        <ol className="mt-2 space-y-1 text-sm" data-testid="cook-all-steps">
          {steps.map((step) => {
            const isDone = done.has(step.id);
            return (
              <li key={step.id} data-step-id={step.id} className="flex items-start gap-1">
                {hydrated && (
                  <button
                    type="button"
                    aria-pressed={isDone}
                    aria-label={`Step ${step.number} done`}
                    className={cn(
                      "flex size-8 shrink-0 items-center justify-center rounded border border-white/20 text-base",
                      isDone ? "bg-emerald-500/30 text-emerald-100" : "text-transparent hover:bg-white/10",
                    )}
                    onClick={() => {
                      toggleDone(step.id);
                    }}
                  >
                    ✓
                  </button>
                )}
                <a
                  href={cookPath(view.startDate, view.sessionKey, step.number)}
                  aria-current={step.number === current.number ? "step" : undefined}
                  className={cn(
                    "block min-w-0 flex-1 rounded px-2 py-1 hover:bg-white/10",
                    step.number === current.number && "bg-purple-500/20 font-semibold",
                    isDone && "text-blue-100/50 line-through",
                  )}
                  onClick={(event) => {
                    onNavigate(event, step.number);
                  }}
                >
                  <span className="text-blue-100/60">{`${step.number}. `}</span>
                  {step.instruction}
                  <span className="text-xs text-blue-100/60">{` · ${step.recipeName}`}</span>
                </a>
              </li>
            );
          })}
        </ol>
      </section>
    </>
  );
}

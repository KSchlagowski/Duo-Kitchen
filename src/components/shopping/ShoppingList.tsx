import type React from "react";
import type { ShoppingAisle, StoreAisle } from "@/types";
import { useShoppingChecks } from "@/components/hooks/useShoppingChecks";
import { formatShoppingAmount, formatShoppingSummary } from "@/lib/services/shopping-list";
import { cn } from "@/lib/utils";

// The check-off list of /plan/shopping (S-09). Server-rendered with the same forms, testids and ids as
// the no-JS page, so it works before (and without) hydration; once hydrated it toggles in place. It
// imports only the pure shopping-list.ts, never shopping.ts or day-solutions.ts, so no solver, zod or
// Supabase code reaches the browser. `children` (the source notes) sit between summary and aisles.
interface Props {
  startDate: string;
  aisles: ShoppingAisle[];
  itemCount: number;
  labels: { aisles: Record<StoreAisle, string> };
  children?: React.ReactNode;
}

export default function ShoppingList({ startDate, aisles, itemCount, labels, children }: Props) {
  const { checked, pending, message, checkedCount, toggle } = useShoppingChecks(aisles);

  function handleSubmit(event: React.SubmitEvent<HTMLFormElement>, productId: string) {
    event.preventDefault();
    void toggle(event.currentTarget, productId);
  }

  return (
    <>
      <p className="text-lg font-semibold" data-testid="shopping-summary">
        {formatShoppingSummary({ itemCount, checkedCount })}
      </p>

      {children}

      <p
        aria-live="polite"
        className={cn(message && "mt-4 rounded-lg border border-red-400/30 bg-red-500/10 p-3 text-sm text-red-200")}
        data-testid="shopping-toggle-error"
      >
        {message}
      </p>

      {aisles.map(({ aisle, items }) => (
        <section key={aisle} className="mt-6" data-testid={`aisle-${aisle}`}>
          <h2 className="mb-2 font-semibold">{labels.aisles[aisle]}</h2>
          <ul className="flex flex-col gap-1">
            {items.map((item) => {
              const isChecked = checked[item.productId] ?? item.checked;
              return (
                <li
                  key={item.productId}
                  id={`item-${item.productId}`}
                  data-testid={`item-${item.productId}`}
                  data-checked={isChecked ? "true" : "false"}
                >
                  <form
                    method="POST"
                    action="/api/plan/shopping"
                    onSubmit={(event) => {
                      handleSubmit(event, item.productId);
                    }}
                  >
                    <input type="hidden" name="start_date" value={startDate} />
                    <input type="hidden" name="product_id" value={item.productId} />
                    <input type="hidden" name="checked" value={isChecked ? "0" : "1"} />
                    <button
                      type="submit"
                      aria-pressed={isChecked}
                      disabled={pending.has(item.productId)}
                      className={cn(
                        "flex min-h-11 w-full items-center gap-3 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-left text-sm transition-colors hover:bg-white/10 disabled:opacity-70",
                        isChecked && "text-blue-100/50",
                      )}
                    >
                      <span aria-hidden="true" className="text-lg">
                        {isChecked ? "☑" : "☐"}
                      </span>
                      <span className={cn("min-w-0 flex-1 break-words", isChecked && "line-through")}>
                        {item.productName}
                      </span>
                      <span className={cn("shrink-0", isChecked ? "line-through" : "text-blue-100/80")}>
                        {formatShoppingAmount(item)}
                      </span>
                    </button>
                  </form>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </>
  );
}

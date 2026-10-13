import { useState } from "react";
import type { ShoppingAisle } from "@/types";
import { SHOPPING_SAVE_FAILED } from "@/lib/services/shopping-list";

interface CheckResponse {
  ok?: boolean;
  message?: string;
}

// Optimistic check-offs over POST /api/plan/shopping in its JSON mode (S-09). A toggle flips at once
// and reverts, with a message, if the save fails; while one is in flight that item cannot toggle again.
// The server-rendered list stays the source of truth on reload.
export function useShoppingChecks(aisles: ShoppingAisle[]) {
  const [checked, setChecked] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(aisles.flatMap(({ items }) => items.map((item) => [item.productId, item.checked]))),
  );
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  const [message, setMessage] = useState<string | null>(null);

  const setItem = (productId: string, value: boolean) => {
    setChecked((prev) => ({ ...prev, [productId]: value }));
  };
  const setItemPending = (productId: string, value: boolean) => {
    setPending((prev) => {
      const next = new Set(prev);
      if (value) {
        next.add(productId);
      } else {
        next.delete(productId);
      }
      return next;
    });
  };

  // `form` is the item's no-JS form, so the request carries exactly the fields a plain post would.
  async function toggle(form: HTMLFormElement, productId: string) {
    if (pending.has(productId)) {
      return;
    }
    const target = !checked[productId];
    const body = new FormData(form);
    body.set("checked", target ? "1" : "0");

    setItem(productId, target);
    setItemPending(productId, true);
    setMessage(null);
    try {
      const response = await fetch("/api/plan/shopping", {
        method: "POST",
        body,
        headers: { Accept: "application/json" },
      });
      const payload = (await response.json().catch(() => null)) as CheckResponse | null;
      if (!response.ok || payload?.ok !== true) {
        setItem(productId, !target);
        setMessage(payload?.message ?? SHOPPING_SAVE_FAILED);
      }
    } catch {
      setItem(productId, !target);
      setMessage(SHOPPING_SAVE_FAILED);
    } finally {
      setItemPending(productId, false);
    }
  }

  const checkedCount = Object.values(checked).filter(Boolean).length;
  return { checked, pending, message, checkedCount, toggle };
}

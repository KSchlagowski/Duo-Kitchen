import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// "Monday and Tuesday", "Monday, Tuesday and Wednesday".
export function joinList(weekdays: readonly string[]): string {
  return weekdays.length <= 1 ? (weekdays[0] ?? "") : `${weekdays.slice(0, -1).join(", ")} and ${weekdays.at(-1)}`;
}

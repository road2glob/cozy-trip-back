// Amounts are integer US cents. 990 means USD 9.90. No floating point anywhere.

export function assertCents(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Expected a non-negative integer amount in cents, got ${String(value)}`);
  }
  return value;
}

/** 990 -> "USD 9.90", 149100 -> "USD 1,491.00" */
export function formatUsd(minor: number): string {
  assertCents(minor);
  const dollars = Math.floor(minor / 100);
  const cents = minor % 100;
  const grouped = String(dollars).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `USD ${grouped}.${String(cents).padStart(2, "0")}`;
}

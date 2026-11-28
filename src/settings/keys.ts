// taskbox.json's keys: { "maxAgeDays": N }: the age past which the "Keys" row says a key is due to
// rotate. 0, the default, is off: GitHub App keys don't expire, and a yearly rotation would be hand
// work for no threat. An owner who wants a policy sets it.
export interface KeysSettings {
  maxAgeDays: number;
}
export const MAX_AGE_DAYS_MAX = 3650;

export function checkKeys(c: { keys?: unknown }): void {
  if (!("keys" in c)) return;
  const k = c.keys as Record<string, unknown> | undefined;
  const ok = typeof k === "object" && k !== null && !Array.isArray(k) && Object.keys(k).join(",") === "maxAgeDays" && Number.isInteger(k.maxAgeDays) && (k.maxAgeDays as number) >= 0 && (k.maxAgeDays as number) <= MAX_AGE_DAYS_MAX;
  if (!ok) throw new Error(`taskbox.json: keys is { "maxAgeDays": 0 to ${MAX_AGE_DAYS_MAX} }, 0 for no limit`);
}

export const maxAgeDaysOf = (c: { keys?: KeysSettings }) => c.keys?.maxAgeDays ?? 0;

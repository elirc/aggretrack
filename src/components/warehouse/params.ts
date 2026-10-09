import { zDateISO, zUuid } from "@/lib/validation/common";
import { MOVEMENT_TYPES } from "@/lib/validation/warehouse";

/** Search-param parsing for the warehouse pages. Invalid values are dropped. */

export type SP = Record<string, string | string[] | undefined>;

export function one(sp: SP, key: string): string | undefined {
  const v = sp[key];
  const s = Array.isArray(v) ? v[0] : v;
  return s && s.trim() ? s.trim() : undefined;
}

export function uuidParam(sp: SP, key: string): string | undefined {
  const v = one(sp, key);
  return v && zUuid.safeParse(v).success ? v : undefined;
}

export function dateParam(sp: SP, key: string): string | undefined {
  const v = one(sp, key);
  return v && zDateISO.safeParse(v).success ? v : undefined;
}

export function pageParam(sp: SP): number {
  const n = Number(one(sp, "page"));
  return Number.isInteger(n) && n >= 1 ? n : 1;
}

export function enumParam<T extends string>(sp: SP, key: string, values: readonly T[]): T | undefined {
  const v = one(sp, key);
  return v && (values as readonly string[]).includes(v) ? (v as T) : undefined;
}

export function movementTypeParam(sp: SP) {
  return enumParam(sp, "type", MOVEMENT_TYPES);
}

// Builds Channex-style query strings: nested objects become key[child]=...,
// arrays are comma-joined. Ported from legacy utils/stringify_arguments, typed.

type QueryValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | QueryValue[]
  | { [key: string]: QueryValue };

const isPlainObject = (value: QueryValue): value is Record<string, QueryValue> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const stringifyValue = (value: QueryValue): string => {
  if (Array.isArray(value)) {
    return value.map((item) => encodeURIComponent(String(item))).join(",");
  }
  return encodeURIComponent(String(value));
};

const prefixKey = (key: string, prefix: string | null): string =>
  prefix === null ? key : `${prefix}[${key}]`;

const buildPairs = (args: Record<string, QueryValue>, prefix: string | null): string =>
  Object.entries(args)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) =>
      isPlainObject(value)
        ? buildPairs(value, prefixKey(key, prefix))
        : `${prefixKey(key, prefix)}=${stringifyValue(value)}`,
    )
    .join("&");

export const stringifyArguments = (args?: Record<string, QueryValue>): string => {
  if (!isPlainObject(args ?? null)) {
    return "";
  }
  const query = buildPairs(args as Record<string, QueryValue>, null);
  return query.length > 0 ? `?${query}` : "";
};

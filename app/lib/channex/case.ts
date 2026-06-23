// Deep snake_case <-> camelCase key conversion for Channex API payloads.
// Ported from the legacy utils/case_converter, typed.

type Json = unknown;

const toSnake = (key: string): string =>
  key.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);

const toCamel = (key: string): string =>
  key.replace(/_[a-z]/g, (group) => group[1].toUpperCase());

function convert(converter: (key: string) => string, data: Json): Json {
  if (!data || typeof data !== "object") {
    return data;
  }

  if (Array.isArray(data)) {
    return data.map((entry) => convert(converter, entry));
  }

  return Object.fromEntries(
    Object.entries(data as Record<string, Json>).map(([key, value]) => [
      converter(key),
      convert(converter, value),
    ]),
  );
}

export const convertToCamelCase = <T = unknown>(data: Json): T =>
  convert(toCamel, data) as T;

export const convertToSnakeCase = <T = unknown>(data: Json): T =>
  convert(toSnake, data) as T;

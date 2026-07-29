// The shape of one language's guest labels. Its own module so a locale file can
// name the type without importing i18n.ts — which would pull the translator, the
// date-fns locales and English into every locale chunk.

export type Dict = Record<string, string>;

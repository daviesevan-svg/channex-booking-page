// Shared building blocks for the admin editor forms.
import { useState } from "react";

import { useAdminT } from "~/lib/admin-i18n";

/** Standard text-input styling used across the admin editors. */
export const FIELD_INPUT =
  "mt-1.5 block w-full rounded-[10px] border border-line-alt bg-surface-alt px-3.5 py-[11px] text-[15px] text-ink outline-none focus:border-accent";

/** A labelled text field (input or textarea). When `channexHint` is set and a
 *  placeholder is provided, it renders the "From Channex — leave blank" hint;
 *  otherwise `hint` (if given) renders as a faint help line under the field. */
export function Field({
  name,
  label,
  value,
  placeholder,
  textarea,
  rows = 3,
  channexHint = false,
  hint,
}: {
  name: string;
  label: string;
  value?: string;
  placeholder?: string;
  textarea?: boolean;
  rows?: number;
  channexHint?: boolean;
  hint?: string;
}) {
  return (
    <label className="block text-[13px] font-semibold text-secondary">
      {label}
      {textarea ? (
        <textarea
          name={name}
          rows={rows}
          defaultValue={value}
          placeholder={placeholder}
          className={`${FIELD_INPUT} resize-y`}
        />
      ) : (
        <input name={name} defaultValue={value} placeholder={placeholder} className={FIELD_INPUT} />
      )}
      {channexHint && placeholder ? (
        <span className="mt-1 block text-[11px] font-normal text-faint">
          From Channex: {placeholder} — leave blank to use this.
        </span>
      ) : hint ? (
        <span className="mt-1 block text-[11px] font-normal text-faint">{hint}</span>
      ) : null}
    </label>
  );
}

/** File upload control with translatable labels — the native input renders
 *  browser-chrome text ("Choose file / No file chosen") in the BROWSER's
 *  language, so it's visually hidden behind a styled button. */
export function FilePicker({ name, accept }: { name: string; accept?: string }) {
  const t = useAdminT();
  const [fileName, setFileName] = useState<string | null>(null);
  return (
    <label className="flex cursor-pointer flex-wrap items-center gap-3 text-[13px]">
      <span className="rounded-[8px] border border-line-alt bg-surface px-3 py-1.5 text-[13px] font-semibold text-secondary hover:border-accent">
        {t("chooseFile")}
      </span>
      <span className="min-w-0 truncate text-muted">{fileName ?? t("noFileChosen")}</span>
      <input
        type="file"
        name={name}
        accept={accept}
        className="sr-only"
        onChange={(e) => setFileName(e.currentTarget.files?.[0]?.name ?? null)}
      />
    </label>
  );
}

// Shared building blocks for the admin editor forms.
import { useState } from "react";

import { useAdminT, type AdminT } from "~/lib/admin-i18n";
import { DEFAULT_LANG, langLabel } from "~/lib/content";
import { checkUploadBatch, mb, type UploadBatchProblem } from "~/lib/upload-limits";

/** Standard text-input styling used across the admin editors. */
export const FIELD_INPUT =
  "mt-1.5 block w-full rounded-control border border-line-alt bg-surface-alt px-3.5 py-[11px] text-body-lg text-ink outline-none focus:border-accent";

/** Full-page notice for a feature that doesn't apply to the current property
 *  (e.g. revenue management on a single-unit rental). Caller passes already
 *  translated strings so this stays i18n-agnostic. */
export function FeatureUnavailable({ title, body }: { title: string; body: string }) {
  return (
    <div className="max-w-[560px]">
      <h1 className="mb-2 font-serif text-display-sm font-semibold">{title}</h1>
      <p className="rounded-card border border-line bg-surface px-5 py-4 text-body leading-relaxed text-muted">{body}</p>
    </div>
  );
}

/** Shown at the top of a content editor when a NON-default language is being
 *  edited. Fields there hold that language's raw text and are empty until
 *  translated — deliberately: prefilled or placeholder English made operators
 *  think their translations were overwritten (a partner reported it as a bug).
 *  This note is the one place that explains what an empty field means. */
export function TranslationNote({
  lang,
  /** Editors whose empty fields fall back to something OTHER than the default
   *  language's text (the email templates ship built-in translations) pass
   *  their own message key so the note never lies about the fallback. */
  messageKey = "i18nUntranslatedNote",
}: {
  lang: string;
  messageKey?: string;
}) {
  const t = useAdminT();
  if (lang === DEFAULT_LANG) return null;
  return (
    <p className="mb-5 rounded-[10px] bg-chip px-4 py-2.5 text-[13px] text-secondary">
      {t(messageKey, { lang: langLabel(lang), base: langLabel(DEFAULT_LANG) })}
    </p>
  );
}

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
  const t = useAdminT();
  return (
    <label className="block text-caption font-semibold text-secondary">
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
        <span className="mt-1 block text-micro font-normal text-faint">
          {t("afChannexHint", { value: placeholder })}
        </span>
      ) : hint ? (
        <span className="mt-1 block text-micro font-normal text-faint">{hint}</span>
      ) : null}
    </label>
  );
}

/** File upload control with translatable labels — the native input renders
 *  browser-chrome text ("Choose file / No file chosen") in the BROWSER's
 *  language, so it's visually hidden behind a styled button. */
/** The batch problem as translated copy. The server has its own English
 *  wording (uploadProblemMessage); this is the one an admin normally sees,
 *  because the pick is checked before anything is sent. */
function uploadProblemText(t: AdminT, problem: UploadBatchProblem): string {
  switch (problem.kind) {
    case "count":
      return t("uploadTooMany", { got: problem.got, limit: problem.limit });
    case "file":
      return t("uploadFileTooBig", { name: problem.name, size: mb(problem.size), limit: mb(problem.limit) });
    case "total":
      return t("uploadTotalTooBig", { got: mb(problem.got), limit: mb(problem.limit) });
  }
}

export function FilePicker({ name, accept, multiple }: { name: string; accept?: string; multiple?: boolean }) {
  const t = useAdminT();
  const [fileName, setFileName] = useState<string | null>(null);
  const [problem, setProblem] = useState<UploadBatchProblem | null>(null);
  return (
    <div>
      <label className="flex cursor-pointer flex-wrap items-center gap-3 text-caption">
        <span className="rounded-chip border border-line-alt bg-surface px-3 py-1.5 text-caption font-semibold text-secondary hover:border-accent">
          {t("chooseFile")}
        </span>
        <span className="min-w-0 truncate text-muted">{fileName ?? t("noFileChosen")}</span>
        <input
          type="file"
          name={name}
          accept={accept}
          multiple={multiple}
          className="sr-only"
          onChange={(e) => {
            const input = e.currentTarget;
            const files = Array.from(input.files ?? []);
            // Say so here rather than let the request fail: past the batch
            // limits the body is refused by the platform or exhausts the
            // Worker's memory, and the admin gets a blank "unexpected error"
            // with no hint that the photos were the problem (upload-limits.ts).
            // The pick is dropped too — an input still holding 100 MB would go
            // out on the next submit regardless of the warning shown.
            const found = checkUploadBatch(files);
            setProblem(found);
            if (found) {
              input.value = "";
              setFileName(null);
              return;
            }
            setFileName(files.length ? files.map((f) => f.name).join(", ") : null);
          }}
        />
      </label>
      {problem && (
        <p role="alert" className="mt-1 text-caption text-red-600">
          {uploadProblemText(t, problem)}
        </p>
      )}
    </div>
  );
}

// Multi-photo upload, one request per photo, with real progress.
//
// The old control was `FilePicker multiple` posting every file inside the
// form's own submit. That has two problems no amount of validation fixes: the
// batch has to stay under what a Worker can buffer (upload-limits.ts), and
// while it uploads there is nothing to show — `fetch` and React Router's
// fetchers expose no upload progress, so the Save button read "Saving…" for
// however many minutes the photos took and looked frozen. That is the bug an
// admin reported as "stuck on save".
//
// So each file goes to its own endpoint (room-photo.tsx) via XMLHttpRequest,
// which is the only browser API that reports how much of a request BODY has
// gone out. Uploads run one at a time: total bytes are the same either way, and
// a single moving bar is legible where twelve competing ones are not.
//
// A finished upload is a url — the same thing a room's `images` list already
// holds — parked in a hidden `keepImage` input, so the form's save path needs
// no knowledge of any of this.
import { useCallback, useEffect, useRef, useState } from "react";

import { useAdminT, type AdminT } from "~/lib/admin-i18n";
import { mb, MAX_IMAGE_BYTES } from "~/lib/upload-limits";

type ItemState = "queued" | "uploading" | "done" | "error" | "dropped";

interface Item {
  /** Stable across re-renders and reorderings; File identity is not enough
   *  because the same file can legitimately be attached twice. */
  key: number;
  file: File;
  state: ItemState;
  /** 0-100, only meaningful while uploading. */
  pct: number;
  /** Set once stored. Kept when `dropped` so the save can have it cleaned up. */
  url?: string;
  error?: string;
}

/** Reject what the endpoint would reject, before spending the upload. Size and
 *  type only — the batch limits are gone, which is the point of this control. */
function localProblem(file: File, t: AdminT): string | null {
  if (file.type && !file.type.startsWith("image/")) return t("puNotImage", { name: file.name });
  if (file.size > MAX_IMAGE_BYTES) {
    return t("puTooBig", { name: file.name, size: mb(file.size), limit: mb(MAX_IMAGE_BYTES) });
  }
  return null;
}

/** POST one file, resolving to its stored url. Rejects with the server's own
 *  message where there is one — "Only image files are allowed." tells an admin
 *  what to do; "upload failed" does not. */
function putPhoto(endpoint: string, file: File, onPct: (pct: number) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const body = new FormData();
    body.set("photo", file);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", endpoint);
    xhr.responseType = "json";
    // Progress is the entire reason this is XHR and not fetch.
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onPct(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      // responseType "json" leaves response null on a body that isn't JSON —
      // which is what a platform error page is, the failure mode this whole
      // change exists to make legible.
      const data = xhr.response as { url?: string; error?: string } | null;
      if (xhr.status >= 200 && xhr.status < 300 && data?.url) resolve(data.url);
      else reject(new Error(data?.error || `Upload failed (${xhr.status}).`));
    };
    xhr.onerror = () => reject(new Error("Upload failed — check the connection."));
    xhr.onabort = () => reject(new Error("Upload cancelled."));
    xhr.send(body);
  });
}

export function PhotoUploader({
  endpoint,
  /** Hidden field the stored urls are posted under — the same one the existing
   *  photos use, so the action needs no new branch. */
  name = "keepImage",
  /** Every url this control stored, kept even after the admin drops one, so the
   *  save can hand what it did not keep to the image GC. */
  stagedName = "stagedImage",
  /** Raised while anything is queued or uploading: saving then would drop the
   *  in-flight photos silently, so the caller disables its submit. */
  onBusyChange,
}: {
  endpoint: string;
  name?: string;
  stagedName?: string;
  onBusyChange?: (busy: boolean) => void;
}) {
  const t = useAdminT();
  // The queue lives in a ref and is mirrored into state for rendering. It
  // cannot live in state alone: the drain both reads and writes the list, and
  // an effect keyed on that state cancelled its own in-flight upload on the
  // first patch it made (the upload completed, the row sat at "Uploading… 0%").
  const itemsRef = useRef<Item[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [rejected, setRejected] = useState<string[]>([]);
  const nextKey = useRef(0);
  const running = useRef(false);

  const commit = useCallback((next: Item[]) => {
    itemsRef.current = next;
    setItems(next);
  }, []);

  const patch = useCallback(
    (key: number, changes: Partial<Item>) => {
      commit(itemsRef.current.map((it) => (it.key === key ? { ...it, ...changes } : it)));
    },
    [commit],
  );

  const busy = items.some((it) => it.state === "queued" || it.state === "uploading");
  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);

  /** Upload queued files one at a time until none are left. Safe to call
   *  again while it runs — the ref makes a second call a no-op rather than a
   *  second concurrent drain. */
  const drain = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    try {
      for (;;) {
        const next = itemsRef.current.find((it) => it.state === "queued");
        if (!next) return;
        patch(next.key, { state: "uploading", pct: 0 });
        try {
          const url = await putPhoto(endpoint, next.file, (pct) => patch(next.key, { pct }));
          patch(next.key, { state: "done", pct: 100, url, error: undefined });
        } catch (e) {
          patch(next.key, { state: "error", error: e instanceof Error ? e.message : String(e) });
        }
      }
    } finally {
      running.current = false;
    }
  }, [endpoint, patch]);

  function add(files: File[]) {
    const bad: string[] = [];
    const good: Item[] = [];
    for (const file of files) {
      const problem = localProblem(file, t);
      if (problem) bad.push(problem);
      else good.push({ key: nextKey.current++, file, state: "queued", pct: 0 });
    }
    setRejected(bad);
    if (!good.length) return;
    commit([...itemsRef.current, ...good]);
    void drain();
  }

  return (
    <div>
      <label className="flex cursor-pointer flex-wrap items-center gap-3 text-[13px]">
        <span className="rounded-[10px] border border-line-alt bg-surface px-3.5 py-2 text-[13px] font-semibold text-secondary hover:border-accent hover:text-accent">
          {t("puAdd")}
        </span>
        <input
          type="file"
          accept="image/*"
          multiple
          className="sr-only"
          onChange={(e) => {
            const input = e.currentTarget;
            add(Array.from(input.files ?? []));
            // Cleared so the same file can be picked again after a removal, and
            // so nothing lingers in the input to be re-sent with the form.
            input.value = "";
          }}
        />
        {busy && <span className="text-[12px] text-muted">{t("puBusyHint")}</span>}
      </label>

      {rejected.length > 0 && (
        <ul role="alert" className="mt-2 space-y-1">
          {rejected.map((message) => (
            <li key={message} className="text-[12px] text-red-600">
              {message}
            </li>
          ))}
        </ul>
      )}

      {items.length > 0 && (
        <ul className="mt-3 space-y-2">
          {items.map((it) => (
            <li
              key={it.key}
              className="flex items-center gap-3 rounded-[10px] border border-line bg-surface px-3 py-2"
            >
              {/* The stored image, not a local preview: seeing it come back from
                  R2 is the proof the bytes landed. */}
              {it.url && it.state !== "dropped" ? (
                <img src={it.url} alt="" className="h-10 w-10 flex-none rounded-[6px] object-cover" />
              ) : (
                <span className="h-10 w-10 flex-none rounded-[6px] bg-chip" />
              )}

              <span className="min-w-0 flex-1">
                <span
                  className={`block truncate text-[12px] font-semibold ${
                    it.state === "dropped" ? "text-faint line-through" : "text-ink"
                  }`}
                >
                  {it.file.name}
                </span>

                {it.state === "uploading" && (
                  <span className="mt-1 block">
                    <span className="block h-1.5 w-full overflow-hidden rounded-full bg-chip">
                      <span
                        className="block h-full rounded-full bg-accent transition-[width] duration-150"
                        style={{ width: `${it.pct}%` }}
                      />
                    </span>
                    <span className="mt-0.5 block text-[11px] text-muted">
                      {t("puUploading", { pct: it.pct })}
                    </span>
                  </span>
                )}
                {it.state === "queued" && (
                  <span className="mt-0.5 block text-[11px] text-muted">{t("puQueued")}</span>
                )}
                {it.state === "done" && (
                  <span className="mt-0.5 block text-[11px] text-[#3f7a52]">{t("puDone")}</span>
                )}
                {it.state === "dropped" && (
                  <span className="mt-0.5 block text-[11px] text-faint">{t("puDropped")}</span>
                )}
                {it.state === "error" && (
                  <span role="alert" className="mt-0.5 block text-[11px] text-red-600">
                    {it.error}
                  </span>
                )}
              </span>

              {it.state === "error" && (
                <button
                  type="button"
                  onClick={() => {
                    patch(it.key, { state: "queued", pct: 0, error: undefined });
                    void drain();
                  }}
                  className="flex-none text-[12px] font-semibold text-accent hover:underline"
                >
                  {t("puRetry")}
                </button>
              )}
              {(it.state === "done" || it.state === "error") && (
                <button
                  type="button"
                  onClick={() =>
                    it.url
                      ? // Stored already, so it cannot just be forgotten: it stays
                        // listed as dropped and keeps posting `stagedName`, which is
                        // how the save tells the GC to reclaim it.
                        patch(it.key, { state: "dropped" })
                      : commit(itemsRef.current.filter((other) => other.key !== it.key))
                  }
                  className="flex-none text-[12px] font-semibold text-muted hover:text-red-600"
                >
                  {t("puRemove")}
                </button>
              )}

              {/* Only a kept photo is saved; every stored one is declared, so an
                  upload the admin changed their mind about is not left orphaned
                  in the bucket. */}
              {it.url && it.state === "done" && <input type="hidden" name={name} value={it.url} />}
              {it.url && <input type="hidden" name={stagedName} value={it.url} />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

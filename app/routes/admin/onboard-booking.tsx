import { Form, Link, redirect, useNavigation } from "react-router";

import type { Route } from "./+types/onboard-booking";
import { adminMeta } from "~/lib/admin-meta";
import { FIELD_INPUT } from "~/components/admin-form";
import { useAdminT, type AdminT } from "~/lib/admin-i18n";
import { requireAdmin, setSessionProperty } from "~/lib/auth.server";
import {
  fetchBookingListing,
  importBookingListing,
  normalizeBookingUrl,
  type BookingImport,
  type BookingImportRate,
} from "~/lib/booking-import.server";
import { SUPPORTED_CURRENCIES } from "~/lib/currencies";
import { isAllowedImportImageUrl } from "~/lib/images.server";
import { isScrapflyConfigured } from "~/lib/scrapfly.server";

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  return { configured: isScrapflyConfigured() };
}

/** Drop non-CDN URLs before the import so a tampered review form doesn't even
 *  attempt the fetch. The authoritative allowlist lives in importImageFromUrl
 *  (`isAllowedImportImageUrl`) — this is the same check, not a second policy. */
function onlyBookingCdn(urls: string[]): string[] {
  return urls.filter(isAllowedImportImageUrl);
}

/** "Free cancellation up to 2 days before arrival" / "Non-refundable" — the
 *  policy the imported rate will carry, in the admin's own language. */
function cancellationLabel(t: AdminT, rate: BookingImportRate): string {
  if (!rate.refundable) return t("obbRateNonRefundable");
  const n = rate.cancelDeadlineValue;
  if (n === undefined) return t("obbRateFreeCancellation");
  const unit =
    rate.cancelDeadlineUnit === "days"
      ? t(n === 1 ? "obbRateDays_one" : "obbRateDays_other", { n })
      : t(n === 1 ? "obbRateHours_one" : "obbRateHours_other", { n });
  return t("obbRateFreeUntil", { window: unit });
}

export async function action({ request }: Route.ActionArgs) {
  const email = await requireAdmin(request);
  const form = await request.formData();
  const intent = String(form.get("intent"));

  if (intent === "fetch") {
    const raw = String(form.get("listingUrl") ?? "");
    const url = normalizeBookingUrl(raw);
    if (!url) return { error: "badUrl" as const, listingUrl: raw };
    const result = await fetchBookingListing(url);
    if ("error" in result) return { error: "fetch" as const, message: result.error, listingUrl: raw };
    return { step: "review" as const, payload: result };
  }

  if (intent === "import") {
    let payload: BookingImport;
    try {
      payload = JSON.parse(String(form.get("payload") ?? "")) as BookingImport;
    } catch {
      return { error: "fetch" as const, message: "The review data was lost — fetch the listing again." };
    }
    if (!payload?.name || !Array.isArray(payload.rooms)) {
      return { error: "fetch" as const, message: "The review data was lost — fetch the listing again." };
    }
    payload.photos = onlyBookingCdn(payload.photos ?? []);
    for (const r of payload.rooms) r.photos = onlyBookingCdn(r.photos ?? []);
    // A listing with no bookable offers has no rate plans; an older review form
    // (or a tampered one) may not carry the field at all.
    payload.rates = Array.isArray(payload.rates) ? payload.rates : [];

    const roomRefs = new Set(form.getAll("rooms").map(String));
    if (roomRefs.size === 0) {
      return { step: "review" as const, payload, error: "noRooms" as const };
    }
    const pid = await importBookingListing(email, payload, {
      roomRefs,
      rateRefs: new Set(form.getAll("rates").map(String)),
      importPhotos: form.get("importPhotos") === "on",
      importFacilities: form.get("importFacilities") === "on",
      currency: String(form.get("currency") ?? "") || undefined,
    });
    return redirect("/admin", {
      headers: { "Set-Cookie": await setSessionProperty(request, pid) },
    });
  }
  return { error: "fetch" as const, message: "Unknown action." };
}

export function meta({ matches }: Route.MetaArgs) {
  return adminMeta(matches, { key: "mtOnboardBooking" });
}

export default function OnboardBooking({ loaderData, actionData }: Route.ComponentProps) {
  const nav = useNavigation();
  const busy = nav.state !== "idle";
  const t = useAdminT();
  const step = actionData && "step" in actionData ? actionData.step : "url";
  const payload = actionData && "payload" in actionData ? actionData.payload : undefined;
  const listingUrl = actionData && "listingUrl" in actionData ? actionData.listingUrl : "";
  const error = actionData && "error" in actionData ? actionData.error : undefined;
  const message = actionData && "message" in actionData ? actionData.message : undefined;

  return (
    <div className="max-w-[720px]">
      <div className="mb-4">
        <Link to="/admin/properties" className="text-[13px] font-semibold text-muted hover:text-accent">
          {t("obBack")}
        </Link>
      </div>
      <h1 className="mb-1 font-serif text-[26px] font-semibold">{t("obbTitle")}</h1>
      <p className="mb-6 max-w-[620px] text-[14px] text-muted">{t("obbIntro")}</p>

      {!loaderData.configured && (
        <p className="mb-6 rounded-[10px] border border-line bg-surface px-4 py-3 text-[13px] text-red-600">
          {t("obbNotConfigured")}
        </p>
      )}

      {/* Step 1: listing URL. */}
      {step === "url" && (
        <Form method="post" className="flex flex-col gap-5">
          <input type="hidden" name="intent" value="fetch" />
          <section className="rounded-[14px] border border-line bg-surface p-6">
            <label className="block text-[13px] font-semibold text-secondary">
              {t("obbUrlLabel")}
              <input
                name="listingUrl"
                type="url"
                defaultValue={listingUrl}
                placeholder="https://www.booking.com/hotel/…"
                autoComplete="off"
                className={FIELD_INPUT}
              />
            </label>
            <p className="mt-2 text-[12px] text-muted">{t("obbUrlHint")}</p>
            {error === "badUrl" && <p className="mt-3 text-[13px] text-red-600">{t("obbBadUrl")}</p>}
            {error === "fetch" && message && <p className="mt-3 text-[13px] text-red-600">{message}</p>}
            <button
              type="submit"
              disabled={busy || !loaderData.configured}
              className="mt-4 rounded-[10px] bg-accent px-6 py-3 text-[15px] font-semibold text-white hover:bg-accent-deep disabled:opacity-60"
            >
              {busy ? t("obbFetching") : t("obbFetch")}
            </button>
          </section>
        </Form>
      )}

      {/* Step 2: review everything before anything is written. */}
      {step === "review" && payload && (
        <Form method="post" className="flex flex-col gap-5">
          <input type="hidden" name="intent" value="import" />
          <input type="hidden" name="payload" value={JSON.stringify(payload)} />

          <section className="rounded-[14px] border border-line bg-surface p-6">
            <div className="mb-1 flex items-baseline gap-2">
              <span className="font-serif text-[18px] font-semibold">{payload.name}</span>
              {payload.starRating ? (
                <span className="text-[13px] text-muted">{"★".repeat(payload.starRating)}</span>
              ) : null}
            </div>
            <div className="text-[13px] text-muted">{payload.address}</div>
            {(payload.checkinFrom || payload.checkoutUntil) && (
              <div className="mt-1 text-[12px] text-muted">
                {payload.checkinFrom ? t("obbCheckin", { time: payload.checkinFrom }) : null}
                {payload.checkinFrom && payload.checkoutUntil ? " · " : null}
                {payload.checkoutUntil ? t("obbCheckout", { time: payload.checkoutUntil }) : null}
              </div>
            )}
            {payload.description && (
              <p className="mt-3 whitespace-pre-line text-[13px] text-secondary">{payload.description}</p>
            )}
            <label className="mt-4 block max-w-[360px] text-[13px] font-semibold text-secondary">
              {t("obbCurrency")}
              <select name="currency" defaultValue={payload.currency ?? ""} className={FIELD_INPUT}>
                <option value="">{t("obbCurrencyPick")}</option>
                {SUPPORTED_CURRENCIES.map(([code, name]) => (
                  <option key={code} value={code}>{code} — {name}</option>
                ))}
              </select>
              <span className="mt-1 block text-[11px] font-normal text-faint">{t("obbCurrencyHint")}</span>
            </label>
          </section>

          <section className="rounded-[14px] border border-line bg-surface p-6">
            <div className="mb-3 font-serif text-[18px] font-semibold">
              {t("obRoomTypes")}{" "}
              <span className="font-sans text-[13px] font-normal text-muted">({payload.rooms.length})</span>
            </div>
            <div className="flex flex-col gap-2">
              {payload.rooms.map((r) => (
                <label
                  key={r.ref}
                  className="flex cursor-pointer items-start gap-3 rounded-[10px] border border-line-alt bg-surface-alt px-4 py-3"
                >
                  <input type="checkbox" name="rooms" value={r.ref} defaultChecked className="mt-1" />
                  {r.photos[0] && (
                    // Booking's own CDN thumbnail, shown only on this review
                    // screen — imported copies land in R2.
                    <img
                      src={r.photos[0].replace("/max1024x768/", "/max200/")}
                      alt=""
                      loading="lazy"
                      className="h-14 w-20 flex-none rounded-[6px] object-cover"
                    />
                  )}
                  <span className="flex-1">
                    <span className="block text-[14px] font-semibold text-ink">{r.name}</span>
                    <span className="block text-[12px] text-muted">
                      {[
                        t("obbSleeps", { n: r.maxGuests }),
                        r.beds,
                        r.sizeM2 ? `${Math.round(r.sizeM2)} m²` : undefined,
                        t(r.photos.length === 1 ? "obbPhotos_one" : "obbPhotos_other", { n: r.photos.length }),
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                    {r.description && <span className="mt-1 block text-[12px] text-secondary">{r.description}</span>}
                  </span>
                </label>
              ))}
            </div>
          </section>

          <section className="rounded-[14px] border border-line bg-surface p-6">
            <div className="mb-1 font-serif text-[18px] font-semibold">
              {t("obbRatePlans")}{" "}
              <span className="font-sans text-[13px] font-normal text-muted">({payload.rates.length})</span>
            </div>
            <p className="mb-3 max-w-[560px] text-[12px] text-muted">{t("obbRatePlansHint")}</p>
            {payload.rates.length === 0 ? (
              <p className="text-[13px] text-secondary">{t("obbRatePlansNone")}</p>
            ) : (
              <div className="flex flex-col gap-2">
                {payload.rates.map((r) => (
                  <label
                    key={r.ref}
                    className="flex cursor-pointer items-start gap-3 rounded-[10px] border border-line-alt bg-surface-alt px-4 py-3"
                  >
                    <input type="checkbox" name="rates" value={r.ref} defaultChecked className="mt-1" />
                    <span className="flex-1">
                      <span className="block text-[14px] font-semibold text-ink">{r.name}</span>
                      <span className="block text-[12px] text-muted">
                        {[
                          r.mealPlan || t("rtRoomOnly"),
                          cancellationLabel(t, r),
                          r.prepayment,
                          t(r.roomCount === 1 ? "obbRateRooms_one" : "obbRateRooms_other", { n: r.roomCount }),
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                      {/* Booking's own wording, kept when no cancellation window
                          could be read from it — the owner should see exactly
                          what the rate will say. */}
                      {r.cancellationNote && (
                        <span className="mt-1 block text-[12px] text-secondary">{r.cancellationNote}</span>
                      )}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </section>

          <section className="rounded-[14px] border border-line bg-surface p-6">
            <label className="flex cursor-pointer items-start gap-3">
              <input type="checkbox" name="importPhotos" defaultChecked className="mt-1" />
              <span>
                <span className="block text-[14px] font-semibold text-ink">{t("obbGallery")}</span>
                <span className="block text-[12px] text-muted">
                  {t("obbGalleryHint", { n: payload.photos.length })}
                </span>
              </span>
            </label>
            <label className="mt-4 flex cursor-pointer items-start gap-3">
              <input type="checkbox" name="importFacilities" defaultChecked className="mt-1" />
              <span>
                <span className="block text-[14px] font-semibold text-ink">{t("obbFacilities")}</span>
                <span className="block text-[12px] text-muted">
                  {t("obbFacilitiesHint", { n: payload.facilities.length })}
                  {payload.facilities.length ? ` — ${payload.facilities.slice(0, 6).join(", ")}…` : ""}
                </span>
              </span>
            </label>
          </section>

          {error === "noRooms" && <p className="text-[13px] text-red-600">{t("obbNoRooms")}</p>}

          <div className="flex items-center gap-4">
            <button
              type="submit"
              disabled={busy}
              className="rounded-[10px] bg-accent px-6 py-3 text-[15px] font-semibold text-white hover:bg-accent-deep disabled:opacity-60"
            >
              {busy ? t("obImporting") : t("obImport")}
            </button>
            {busy && <span className="text-[13px] text-muted">{t("obbImportingHint")}</span>}
          </div>
        </Form>
      )}
    </div>
  );
}

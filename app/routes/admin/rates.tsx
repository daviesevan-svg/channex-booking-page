import { Link } from "react-router";

import type { Route } from "./+types/rates";
import { requireAdmin } from "~/lib/auth.server";
import { getConfig } from "~/lib/config.server";
import { getRatePlanList } from "~/lib/rateplans.server";
import { getRatePlanOverrides } from "~/lib/overrides.server";

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const propertyId = getConfig().defaultPropertyId;
  if (!propertyId) return { configured: false as const };

  const [rates, overrides] = await Promise.all([
    getRatePlanList(propertyId).catch(() => []),
    getRatePlanOverrides(propertyId),
  ]);

  return {
    configured: true as const,
    rates: rates.map((r) => ({
      id: r.id,
      channexTitle: r.channexTitle,
      roomTitle: r.roomTitle,
      cancellationTitle: r.cancellationTitle,
      name: overrides[r.id]?.name,
      customised: Boolean(overrides[r.id] && Object.keys(overrides[r.id]).length),
    })),
  };
}

export function meta() {
  return [{ title: "Admin · Rates" }];
}

export default function AdminRates({ loaderData }: Route.ComponentProps) {
  if (!loaderData.configured) {
    return (
      <div className="rounded-[14px] border border-line bg-surface p-6">
        <h1 className="mb-2 font-serif text-[22px] font-semibold">Rates</h1>
        <p className="text-[15px] text-secondary">
          Set <code className="rounded bg-chip px-1.5 py-0.5">DEFAULT_PROPERTY_ID</code> to map rate
          plans.
        </p>
      </div>
    );
  }

  const { rates } = loaderData;

  return (
    <div>
      <h1 className="mb-1 font-serif text-[26px] font-semibold">Rates</h1>
      <p className="mb-6 text-[14px] text-muted">
        {rates.length} bookable rate plan{rates.length === 1 ? "" : "s"} from Channex. Rename them,
        add a description, photos, what&rsquo;s included and a cancellation policy.
      </p>

      {rates.length === 0 ? (
        <div className="rounded-[14px] border border-line bg-surface p-6 text-[14px] text-secondary">
          No bookable rate plans were found in the next 6 months. Rate plans only appear here when
          they have availability open on Channex.
        </div>
      ) : (
        <div className="overflow-hidden rounded-[14px] border border-line bg-surface">
          {rates.map((rate, i) => (
            <Link
              key={rate.id}
              to={`/admin/rates/${rate.id}`}
              className={`flex items-center justify-between gap-4 px-5 py-4 hover:bg-field-hover ${
                i > 0 ? "border-t border-divider" : ""
              }`}
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2.5">
                  <span className="truncate font-semibold">{rate.name || rate.channexTitle}</span>
                  {rate.customised && (
                    <span className="rounded-full bg-[#e8f0e6] px-2 py-0.5 text-[11px] font-semibold text-[#3f7a52]">
                      Customised
                    </span>
                  )}
                </div>
                <div className="mt-0.5 text-[12.5px] text-muted-2">
                  {rate.roomTitle}
                  {rate.name && rate.name !== rate.channexTitle && (
                    <> · Channex: {rate.channexTitle}</>
                  )}
                  {rate.cancellationTitle && <> · Cancellation: {rate.cancellationTitle}</>}
                </div>
                <div className="mt-0.5 font-mono text-[11px] text-faint">{rate.id}</div>
              </div>
              <span className="flex-none text-[13px] font-semibold text-accent">Edit →</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

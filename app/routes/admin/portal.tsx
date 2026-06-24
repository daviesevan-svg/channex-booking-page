import { Form, useNavigation } from "react-router";

import type { Route } from "./+types/portal";
import { requireAdmin } from "~/lib/auth.server";
import { getConfig } from "~/lib/config.server";
import { getSettings, savePortalSettings } from "~/lib/overrides.server";

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const propertyId = getConfig().defaultPropertyId;
  if (!propertyId) return { configured: false as const };
  return { configured: true as const, settings: await getSettings(propertyId) };
}

export async function action({ request }: Route.ActionArgs) {
  await requireAdmin(request);
  const propertyId = getConfig().defaultPropertyId;
  if (!propertyId) return { error: "No DEFAULT_PROPERTY_ID configured." };
  await savePortalSettings(propertyId, await request.formData());
  return { ok: true };
}

export function meta() {
  return [{ title: "Admin · Customer Portal" }];
}

function Deadline({
  label,
  hint,
  nameValue,
  nameUnit,
  value,
  unit,
}: {
  label: string;
  hint: string;
  nameValue: string;
  nameUnit: string;
  value?: number;
  unit?: string;
}) {
  return (
    <div>
      <div className="text-[13px] font-semibold text-secondary">{label}</div>
      <div className="mt-1.5 flex items-center gap-2">
        <input
          name={nameValue}
          type="number"
          min={0}
          defaultValue={value ?? ""}
          placeholder="0"
          className="w-24 rounded-[10px] border border-line-alt bg-surface-alt px-3 py-[10px] text-[15px] text-ink outline-none focus:border-accent"
        />
        <select
          name={nameUnit}
          defaultValue={unit ?? "days"}
          className="rounded-[10px] border border-line-alt bg-surface-alt px-3 py-[11px] text-[15px] text-ink outline-none focus:border-accent"
        >
          <option value="days">days</option>
          <option value="hours">hours</option>
        </select>
        <span className="text-[13px] text-muted-2">before arrival</span>
      </div>
      <p className="mt-1 text-[11px] text-faint">{hint}</p>
    </div>
  );
}

export default function AdminPortal({ loaderData, actionData }: Route.ComponentProps) {
  const nav = useNavigation();
  const saving = nav.state === "submitting";

  if (!loaderData.configured) {
    return (
      <div className="rounded-[14px] border border-line bg-surface p-6">
        <h1 className="mb-2 font-serif text-[22px] font-semibold">Customer Portal</h1>
        <p className="text-[15px] text-secondary">
          Set <code className="rounded bg-chip px-1.5 py-0.5">DEFAULT_PROPERTY_ID</code> to edit
          settings.
        </p>
      </div>
    );
  }

  const s = loaderData.settings;
  const checkbox =
    "h-4 w-4 rounded border-line-alt text-accent focus:ring-accent";

  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <h1 className="font-serif text-[26px] font-semibold">Customer Portal</h1>
        {actionData?.ok && (
          <span className="rounded-full bg-[#e8f0e6] px-3 py-1 text-[13px] font-semibold text-[#3f7a52]">
            ✓ Saved
          </span>
        )}
      </div>
      <p className="mb-6 text-[14px] text-muted">
        Controls what guests can do in “Manage my booking”. These are the defaults — a rate plan can
        override its own windows.
      </p>

      <Form
        method="post"
        className="flex flex-col gap-6 rounded-[14px] border border-line bg-surface p-6"
      >
        <label className="flex items-center gap-2.5 text-[14px] font-semibold">
          <input type="checkbox" name="allowCancel" defaultChecked={s.allowCancel} className={checkbox} />
          Allow guests to cancel their booking
        </label>
        <Deadline
          label="Free cancellation up to"
          hint="Guests can cancel until this long before arrival. Leave blank for no time limit."
          nameValue="cancelDeadlineValue"
          nameUnit="cancelDeadlineUnit"
          value={s.cancelDeadlineValue}
          unit={s.cancelDeadlineUnit}
        />

        <div className="border-t border-divider" />

        <label className="flex items-center gap-2.5 text-[14px] font-semibold">
          <input type="checkbox" name="allowModify" defaultChecked={s.allowModify} className={checkbox} />
          Allow guests to modify their booking <span className="text-[12px] font-normal text-faint">(coming soon)</span>
        </label>
        <Deadline
          label="Changes allowed up to"
          hint="Guests can change dates/rooms until this long before arrival."
          nameValue="modifyDeadlineValue"
          nameUnit="modifyDeadlineUnit"
          value={s.modifyDeadlineValue}
          unit={s.modifyDeadlineUnit}
        />

        <div className="border-t border-divider" />

        <label className="block text-[13px] font-semibold text-secondary">
          After-deadline message
          <textarea
            name="afterDeadlineMessage"
            rows={2}
            defaultValue={s.afterDeadlineMessage}
            placeholder="Please contact us directly to change or cancel this booking."
            className="mt-1.5 block w-full resize-y rounded-[10px] border border-line-alt bg-surface-alt px-3.5 py-[11px] text-[15px] text-ink outline-none focus:border-accent"
          />
          <span className="mt-1 block text-[11px] font-normal text-faint">
            Shown to guests once the cancellation/modification window has passed.
          </span>
        </label>

        {actionData?.error && <p className="text-[13px] text-red-600">{actionData.error}</p>}
        <div>
          <button
            type="submit"
            disabled={saving}
            className="rounded-[10px] bg-accent px-6 py-3 text-[15px] font-semibold text-white hover:bg-accent-deep disabled:opacity-60"
          >
            {saving ? "Saving…" : "Save settings"}
          </button>
        </div>
      </Form>
    </div>
  );
}

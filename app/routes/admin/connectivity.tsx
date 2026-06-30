import { useState } from "react";
import { Form, useNavigation } from "react-router";

import type { Route } from "./+types/connectivity";
import { requireAdmin } from "~/lib/auth.server";
import { currentPropertyId } from "~/lib/properties.server";
import { getSettings, saveConnectivity } from "~/lib/overrides.server";

/** Systems a property can connect to. Only `available` ones can be selected;
 *  the rest are shown as upcoming so the list reads as a roadmap. */
const SYSTEMS = [
  {
    id: "channex",
    name: "Channex",
    tagline: "Channel manager & booking gateway",
    blurb: "Sync availability, rates and bookings through your Channex account.",
    available: true,
  },
  { id: "apaleo", name: "Apaleo", tagline: "Property management system", blurb: "", available: false },
  { id: "mews", name: "Mews", tagline: "Property management system", blurb: "", available: false },
] as const;

const AVAILABLE = new Set<string>(SYSTEMS.filter((s) => s.available).map((s) => s.id));

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const propertyId = await currentPropertyId(request);
  if (!propertyId) return { configured: false as const };
  const settings = await getSettings(propertyId);
  return { configured: true as const, propertyId, connected: settings.connectedSystem };
}

export async function action({ request }: Route.ActionArgs) {
  await requireAdmin(request);
  const propertyId = await currentPropertyId(request);
  if (!propertyId) return { error: "Add a property first." };
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  if (intent === "disconnect") {
    await saveConnectivity(propertyId, undefined);
    return { ok: true };
  }
  const provider = String(form.get("provider") ?? "");
  if (intent === "connect" && AVAILABLE.has(provider)) {
    await saveConnectivity(propertyId, provider);
    return { ok: true };
  }
  return { error: "That system can't be connected yet." };
}

export function meta() {
  return [{ title: "Admin · Connectivity" }];
}

function CopyField({ label, value, hint }: { label: string; value: string; hint?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <div className="mb-1.5 text-[13px] font-semibold text-secondary">{label}</div>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-[10px] border border-line-alt bg-surface-alt px-3.5 py-[11px] font-mono text-[14px] text-ink">
          {value}
        </code>
        <button
          type="button"
          onClick={() => {
            navigator.clipboard?.writeText(value).then(
              () => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              },
              () => {},
            );
          }}
          className="flex-none rounded-[10px] border border-line-alt bg-surface px-4 py-[11px] text-[13px] font-semibold text-secondary hover:border-accent hover:text-accent"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      {hint && <p className="mt-1.5 text-[12.5px] text-muted">{hint}</p>}
    </div>
  );
}

export default function AdminConnectivity({ loaderData, actionData }: Route.ComponentProps) {
  const nav = useNavigation();
  const saving = nav.state === "submitting";

  if (!loaderData.configured) {
    return (
      <div className="rounded-[14px] border border-line bg-surface p-6">
        <h1 className="mb-2 font-serif text-[22px] font-semibold">Connectivity</h1>
        <p className="text-[15px] text-secondary">Add a property first to connect a system.</p>
      </div>
    );
  }

  const { propertyId, connected } = loaderData;

  return (
    <div>
      <div className="mb-5 flex items-center justify-between">
        <h1 className="font-serif text-[26px] font-semibold">Connectivity</h1>
        {actionData?.ok && (
          <span className="rounded-full bg-[#e8f0e6] px-3 py-1 text-[13px] font-semibold text-[#3f7a52]">
            ✓ Saved
          </span>
        )}
      </div>

      <p className="mb-5 max-w-2xl text-[14px] text-secondary">
        Choose the system this property connects to. We'll show you the details you need to set up
        the connection on their side.
      </p>

      {actionData?.error && (
        <p className="mb-4 rounded-[10px] border border-red-200 bg-red-50 px-4 py-2.5 text-[13px] text-red-700">
          {actionData.error}
        </p>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {SYSTEMS.map((sys) => {
          const isConnected = connected === sys.id;
          return (
            <div
              key={sys.id}
              className={`flex flex-col rounded-[14px] border bg-surface p-5 ${
                isConnected ? "border-accent ring-1 ring-accent" : "border-line"
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="font-serif text-[18px] font-semibold">{sys.name}</div>
                  <div className="text-[12.5px] text-muted">{sys.tagline}</div>
                </div>
                {isConnected ? (
                  <span className="flex-none rounded-full bg-[#e8f0e6] px-2.5 py-1 text-[11.5px] font-semibold text-[#3f7a52]">
                    Connected
                  </span>
                ) : (
                  !sys.available && (
                    <span className="flex-none rounded-full bg-chip px-2.5 py-1 text-[11.5px] font-semibold text-muted">
                      Coming soon
                    </span>
                  )
                )}
              </div>

              {sys.blurb && <p className="mt-3 text-[13px] text-secondary">{sys.blurb}</p>}

              <div className="mt-4 flex-1" />

              {sys.available ? (
                isConnected ? (
                  <Form method="post">
                    <input type="hidden" name="intent" value="disconnect" />
                    <button
                      type="submit"
                      disabled={saving}
                      className="w-full rounded-[10px] border border-line-alt bg-surface px-4 py-2.5 text-[14px] font-semibold text-secondary hover:border-accent hover:text-accent disabled:opacity-60"
                    >
                      Disconnect
                    </button>
                  </Form>
                ) : (
                  <Form method="post">
                    <input type="hidden" name="intent" value="connect" />
                    <input type="hidden" name="provider" value={sys.id} />
                    <button
                      type="submit"
                      disabled={saving}
                      className="w-full rounded-[10px] bg-accent px-4 py-2.5 text-[14px] font-semibold text-white hover:bg-accent-deep disabled:opacity-60"
                    >
                      Connect
                    </button>
                  </Form>
                )
              ) : (
                <button
                  type="button"
                  disabled
                  className="w-full cursor-not-allowed rounded-[10px] border border-line-alt bg-surface-alt px-4 py-2.5 text-[14px] font-semibold text-faint"
                >
                  Connect
                </button>
              )}
            </div>
          );
        })}
      </div>

      {connected === "channex" && (
        <section className="mt-6 rounded-[14px] border border-line bg-surface p-6">
          <h2 className="mb-1 font-serif text-[18px] font-semibold">Connect with Channex</h2>
          <p className="mb-4 max-w-2xl text-[13.5px] text-muted">
            In Channex, map this booking engine to your property using the Property ID below. It
            identifies your property across availability, rates and booking calls.
          </p>
          <div className="max-w-xl">
            <CopyField
              label="Property ID"
              value={propertyId}
              hint="Paste this into the channel/mapping setup in your Channex account."
            />
          </div>
        </section>
      )}
    </div>
  );
}

import { Form, useNavigation } from "react-router";

import type { Route } from "./+types/webhooks";
import { requireAdmin } from "~/lib/auth.server";
import { currentPropertyId, isOwnerOrSuper } from "~/lib/properties.server";
import { addWebhook, isSafeWebhookUrl, listWebhooks, removeWebhook } from "~/lib/webhooks.server";
import { WEBHOOK_EVENTS, type WebhookEvent } from "~/lib/webhook-events";

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const propertyId = await currentPropertyId(request);
  if (!propertyId) return { configured: false as const };
  const canManage = await isOwnerOrSuper(request, propertyId);
  return { configured: true as const, canManage, endpoints: canManage ? await listWebhooks(propertyId) : [] };
}

export async function action({ request }: Route.ActionArgs) {
  await requireAdmin(request);
  const propertyId = await currentPropertyId(request);
  if (!propertyId) return { error: "Add a property first." };
  if (!(await isOwnerOrSuper(request, propertyId))) return { error: "Only an owner or manager can manage webhooks." };
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "add") {
    const url = String(form.get("url") ?? "").trim();
    if (!isSafeWebhookUrl(url)) {
      return { error: "Enter a public https:// URL (private/internal hosts aren't allowed)." };
    }
    const events = form.getAll("events").map(String).filter((e): e is WebhookEvent => (WEBHOOK_EVENTS as readonly string[]).includes(e));
    const ep = await addWebhook(propertyId, url, events);
    return { addedSecret: ep.secret, addedUrl: ep.url };
  }
  if (intent === "remove") {
    await removeWebhook(propertyId, String(form.get("id") ?? ""));
    return { removed: true as const };
  }
  return { error: "Unknown action." };
}

export function meta() {
  return [{ title: "Admin · Webhooks" }];
}

export default function AdminWebhooks({ loaderData, actionData }: Route.ComponentProps) {
  const nav = useNavigation();
  const busy = nav.state !== "idle";

  if (!loaderData.configured) {
    return (
      <div className="rounded-[14px] border border-line bg-surface p-6">
        <h1 className="mb-2 font-serif text-[22px] font-semibold">Webhooks</h1>
        <p className="text-[15px] text-secondary">Add a property first to configure webhooks.</p>
      </div>
    );
  }
  if (!loaderData.canManage) {
    return (
      <div className="rounded-[14px] border border-line bg-surface p-6">
        <h1 className="mb-2 font-serif text-[22px] font-semibold">Webhooks</h1>
        <p className="text-[15px] text-secondary">Only an owner or manager can manage webhooks for this property.</p>
      </div>
    );
  }

  const { endpoints } = loaderData;
  const input = "rounded-[10px] border border-line-alt bg-surface px-3 py-2 text-[14px] outline-none focus:border-accent";

  return (
    <div>
      <h1 className="mb-1 font-serif text-[26px] font-semibold">Webhooks</h1>
      <p className="mb-5 max-w-2xl text-[14px] text-secondary">
        We POST a signed JSON event to your endpoint when a booking is created or cancelled. Verify the
        <code className="mx-1 rounded bg-line/40 px-1">Roompanda-Signature: t=&lt;ts&gt;,v1=&lt;hmac&gt;</code>
        header with your endpoint’s secret (HMAC-SHA256 of <code className="rounded bg-line/40 px-1">&lt;ts&gt;.&lt;body&gt;</code>).
      </p>

      {actionData?.addedSecret && (
        <div className="mb-5 rounded-[12px] border border-[#cfe3d0] bg-[#eef5ec] p-4">
          <div className="mb-1 text-[13px] font-semibold text-[#3f7a52]">✓ Endpoint added — copy its signing secret now, it won’t be shown again.</div>
          <div className="mb-1 text-[12.5px] text-secondary">{actionData.addedUrl}</div>
          <code className="block break-all rounded-[8px] border border-line bg-white px-3 py-2 font-mono text-[13px] text-ink">{actionData.addedSecret}</code>
        </div>
      )}
      {actionData?.error && <p className="mb-4 rounded-[10px] border border-red-200 bg-red-50 px-4 py-2.5 text-[13px] text-red-700">{actionData.error}</p>}

      <Form method="post" className="mb-6 flex flex-col gap-3 rounded-[14px] border border-line bg-surface p-5">
        <input type="hidden" name="intent" value="add" />
        <label className="flex flex-col gap-1 text-[12.5px] font-semibold text-secondary">
          Endpoint URL
          <input name="url" type="url" placeholder="https://example.com/webhooks/roompanda" className={`${input} w-full`} />
        </label>
        <div className="flex flex-wrap gap-4">
          {WEBHOOK_EVENTS.map((ev) => (
            <label key={ev} className="flex items-center gap-2 text-[13.5px] font-medium">
              <input type="checkbox" name="events" value={ev} defaultChecked className="h-4 w-4" /> {ev}
            </label>
          ))}
        </div>
        <div>
          <button type="submit" disabled={busy} className="rounded-[10px] bg-accent px-5 py-2.5 text-[14px] font-semibold text-white hover:bg-accent-deep disabled:opacity-60">
            Add endpoint
          </button>
        </div>
      </Form>

      <div className="rounded-[14px] border border-line bg-surface">
        {endpoints.length === 0 ? (
          <p className="p-5 text-[14px] text-muted-2">No webhook endpoints yet.</p>
        ) : (
          <table className="w-full text-[13.5px]">
            <thead>
              <tr className="border-b border-divider text-left text-[12px] uppercase tracking-wide text-muted">
                <th className="px-5 py-3 font-semibold">URL</th>
                <th className="px-5 py-3 font-semibold">Events</th>
                <th className="px-5 py-3 font-semibold">Secret</th>
                <th className="px-5 py-3" />
              </tr>
            </thead>
            <tbody>
              {endpoints.map((e) => (
                <tr key={e.id} className="border-b border-divider/60 last:border-0 align-top">
                  <td className="px-5 py-3 font-mono text-[12px] text-ink break-all">{e.url}</td>
                  <td className="px-5 py-3 text-secondary">{e.events.join(", ")}</td>
                  <td className="px-5 py-3 font-mono text-[12px] text-muted">whsec_…{e.secret.slice(-4)}</td>
                  <td className="px-5 py-3 text-right">
                    <Form method="post" onSubmit={(ev) => { if (!confirm("Remove this endpoint? It will stop receiving events.")) ev.preventDefault(); }}>
                      <input type="hidden" name="intent" value="remove" />
                      <input type="hidden" name="id" value={e.id} />
                      <button type="submit" disabled={busy} className="text-[13px] font-semibold text-red-600 hover:underline disabled:opacity-60">Remove</button>
                    </Form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

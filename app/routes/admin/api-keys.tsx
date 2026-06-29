import { Form, useNavigation } from "react-router";

import type { Route } from "./+types/api-keys";
import { requireAdmin } from "~/lib/auth.server";
import { currentPropertyId, isOwnerOrSuper } from "~/lib/properties.server";
import { issueApiKey, listApiKeys, revokeApiKey, type ApiKeyMode } from "~/lib/api-auth.server";

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const propertyId = await currentPropertyId(request);
  if (!propertyId) return { configured: false as const };
  const canManage = await isOwnerOrSuper(request, propertyId);
  return { configured: true as const, canManage, keys: canManage ? await listApiKeys(propertyId) : [] };
}

export async function action({ request }: Route.ActionArgs) {
  await requireAdmin(request);
  const propertyId = await currentPropertyId(request);
  if (!propertyId) return { error: "Add a property first." };
  if (!(await isOwnerOrSuper(request, propertyId))) {
    return { error: "Only an owner or manager can manage API keys." };
  }
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "create") {
    const label = String(form.get("label") ?? "").trim();
    const mode: ApiKeyMode = form.get("mode") === "live" ? "live" : "test";
    const { raw } = await issueApiKey(propertyId, { label, mode });
    return { created: raw };
  }
  if (intent === "revoke") {
    await revokeApiKey(propertyId, String(form.get("keyId") ?? ""));
    return { revoked: true as const };
  }
  return { error: "Unknown action." };
}

export function meta() {
  return [{ title: "Admin · API keys" }];
}

export default function AdminApiKeys({ loaderData, actionData }: Route.ComponentProps) {
  const nav = useNavigation();
  const busy = nav.state !== "idle";

  if (!loaderData.configured) {
    return (
      <div className="rounded-[14px] border border-line bg-surface p-6">
        <h1 className="mb-2 font-serif text-[22px] font-semibold">API keys</h1>
        <p className="text-[15px] text-secondary">Add a property first to create API keys.</p>
      </div>
    );
  }
  if (!loaderData.canManage) {
    return (
      <div className="rounded-[14px] border border-line bg-surface p-6">
        <h1 className="mb-2 font-serif text-[22px] font-semibold">API keys</h1>
        <p className="text-[15px] text-secondary">Only an owner or manager can manage API keys for this property.</p>
      </div>
    );
  }

  const { keys } = loaderData;
  const input =
    "rounded-[10px] border border-line-alt bg-surface px-3 py-2 text-[14px] outline-none focus:border-accent";

  return (
    <div>
      <h1 className="mb-1 font-serif text-[26px] font-semibold">API keys</h1>
      <p className="mb-5 max-w-2xl text-[14px] text-secondary">
        Keys authenticate the REST API for this property (<code className="rounded bg-line/40 px-1">Authorization: Bearer sk_…</code>).
        A <strong>test</strong> key creates simulated bookings; a <strong>live</strong> key creates real ones.
      </p>

      {actionData?.created && (
        <div className="mb-5 rounded-[12px] border border-[#cfe3d0] bg-[#eef5ec] p-4">
          <div className="mb-1 text-[13px] font-semibold text-[#3f7a52]">✓ Key created — copy it now, it won’t be shown again.</div>
          <code className="block break-all rounded-[8px] border border-line bg-white px-3 py-2 font-mono text-[13px] text-ink">
            {actionData.created}
          </code>
        </div>
      )}
      {actionData?.error && (
        <p className="mb-4 rounded-[10px] border border-red-200 bg-red-50 px-4 py-2.5 text-[13px] text-red-700">{actionData.error}</p>
      )}

      <Form method="post" className="mb-6 flex flex-wrap items-end gap-3 rounded-[14px] border border-line bg-surface p-5">
        <input type="hidden" name="intent" value="create" />
        <label className="flex flex-col gap-1 text-[12.5px] font-semibold text-secondary">
          Label
          <input name="label" placeholder="e.g. Production server" className={input} />
        </label>
        <label className="flex flex-col gap-1 text-[12.5px] font-semibold text-secondary">
          Mode
          <select name="mode" defaultValue="test" className={input}>
            <option value="test">Test</option>
            <option value="live">Live</option>
          </select>
        </label>
        <button
          type="submit"
          disabled={busy}
          className="rounded-[10px] bg-accent px-5 py-2.5 text-[14px] font-semibold text-white hover:bg-accent-deep disabled:opacity-60"
        >
          Create key
        </button>
      </Form>

      <div className="rounded-[14px] border border-line bg-surface">
        {keys.length === 0 ? (
          <p className="p-5 text-[14px] text-muted-2">No API keys yet.</p>
        ) : (
          <table className="w-full text-[13.5px]">
            <thead>
              <tr className="border-b border-divider text-left text-[12px] uppercase tracking-wide text-muted">
                <th className="px-5 py-3 font-semibold">Label</th>
                <th className="px-5 py-3 font-semibold">Mode</th>
                <th className="px-5 py-3 font-semibold">Key</th>
                <th className="px-5 py-3 font-semibold">Created</th>
                <th className="px-5 py-3 font-semibold">Last used</th>
                <th className="px-5 py-3" />
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.id} className="border-b border-divider/60 last:border-0">
                  <td className="px-5 py-3 font-medium text-ink">{k.label}</td>
                  <td className="px-5 py-3">
                    <span
                      className={`rounded-full px-2 py-0.5 text-[11.5px] font-semibold ${
                        k.mode === "live" ? "bg-[#e8f0e6] text-[#3f7a52]" : "bg-[#fbeede] text-[#9a6a1e]"
                      }`}
                    >
                      {k.mode}
                    </span>
                  </td>
                  <td className="px-5 py-3 font-mono text-[12px] text-muted">sk_{k.mode}_…{k.last4}</td>
                  <td className="px-5 py-3 text-secondary">{new Date(k.createdAt).toLocaleDateString()}</td>
                  <td className="px-5 py-3 text-secondary">{k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleDateString() : "—"}</td>
                  <td className="px-5 py-3 text-right">
                    <Form
                      method="post"
                      onSubmit={(e) => {
                        if (!confirm("Revoke this key? Any integration using it will stop working immediately.")) e.preventDefault();
                      }}
                    >
                      <input type="hidden" name="intent" value="revoke" />
                      <input type="hidden" name="keyId" value={k.id} />
                      <button type="submit" disabled={busy} className="text-[13px] font-semibold text-red-600 hover:underline disabled:opacity-60">
                        Revoke
                      </button>
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

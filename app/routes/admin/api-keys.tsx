import { useState } from "react";
import { Form, useNavigation } from "react-router";

import type { Route } from "./+types/api-keys";
import { adminMeta } from "~/lib/admin-meta";
import { requireAdmin } from "~/lib/auth.server";
import { getConfig } from "~/lib/config.server";
import { requirePageAllowed } from "~/lib/page-access.server";
import { canManageProperty, currentPropertyId } from "~/lib/properties.server";
import { issueApiKey, listApiKeys, revokeApiKey, type ApiKeyMode } from "~/lib/api-auth.server";
import { useAdminT } from "~/lib/admin-i18n";

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  await requirePageAllowed(request, "api-keys");
  const propertyId = await currentPropertyId(request);
  if (!propertyId) return { configured: false as const };
  const canManage = await canManageProperty(request, propertyId);
  // /mcp and /v1 live ONLY on the canonical host (requireCanonicalHost), so
  // the connect snippets must print the canonical origin — this page may be
  // open on a partner's admin host, where those endpoints 404.
  let apiOrigin = "https://book.roompanda.com";
  try {
    apiOrigin = new URL(getConfig().appUrl).origin;
  } catch {
    /* keep the fallback */
  }
  return { configured: true as const, canManage, apiOrigin, keys: canManage ? await listApiKeys(propertyId) : [] };
}

export async function action({ request }: Route.ActionArgs) {
  await requireAdmin(request);
  await requirePageAllowed(request, "api-keys");
  const propertyId = await currentPropertyId(request);
  if (!propertyId) return { error: "Add a property first." };
  if (!(await canManageProperty(request, propertyId))) {
    return { error: "Only an owner or manager can manage API keys." };
  }
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "create") {
    const label = String(form.get("label") ?? "").trim();
    const type = String(form.get("mode") ?? "test");
    const mode: ApiKeyMode = type === "live" ? "live" : "test";
    const { raw } = await issueApiKey(propertyId, { label, mode, scope: type === "manage" ? "manage" : "book" });
    return { created: raw };
  }
  if (intent === "revoke") {
    await revokeApiKey(propertyId, String(form.get("keyId") ?? ""));
    return { revoked: true as const };
  }
  return { error: "Unknown action." };
}

export function meta({ matches }: Route.MetaArgs) {
  return adminMeta(matches, { key: "navApiKeys" });
}

export default function AdminApiKeys({ loaderData, actionData }: Route.ComponentProps) {
  const nav = useNavigation();
  const busy = nav.state !== "idle";
  const t = useAdminT();

  if (!loaderData.configured) {
    return (
      <div className="rounded-[14px] border border-line bg-surface p-6">
        <h1 className="mb-2 font-serif text-[22px] font-semibold">{t("akTitle")}</h1>
        <p className="text-[15px] text-secondary">{t("akNotConfigured")}</p>
      </div>
    );
  }
  if (!loaderData.canManage) {
    return (
      <div className="rounded-[14px] border border-line bg-surface p-6">
        <h1 className="mb-2 font-serif text-[22px] font-semibold">{t("akTitle")}</h1>
        <p className="text-[15px] text-secondary">{t("akOnlyOwner")}</p>
      </div>
    );
  }

  const { keys, apiOrigin } = loaderData;
  const input =
    "rounded-[10px] border border-line-alt bg-surface px-3 py-2 text-[14px] outline-none focus:border-accent";

  return (
    <div>
      <h1 className="mb-1 font-serif text-[26px] font-semibold">{t("akTitle")}</h1>
      <p className="mb-5 max-w-2xl text-[14px] text-secondary">
        {t("akIntro1")}<code className="rounded bg-line/40 px-1">Authorization: Bearer sk_…</code>{t("akIntro2")}{" "}
        <strong>{t("akIntroTest")}</strong> {t("akIntro3")} <strong>{t("akIntroLive")}</strong> {t("akIntro4")}
      </p>
      <p className="-mt-3 mb-5 max-w-2xl text-[13px] text-muted">{t("akManageHint")}</p>

      {actionData?.created && (
        <div className="mb-5 rounded-[12px] border border-[#cfe3d0] bg-[#eef5ec] p-4">
          <div className="mb-1 text-[13px] font-semibold text-[#3f7a52]">{t("akCreatedBanner")}</div>
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
        <label className="flex flex-col gap-1 text-[12px] font-semibold text-secondary">
          {t("akLabel")}
          <input name="label" placeholder={t("akLabelPlaceholder")} className={input} />
        </label>
        <label className="flex flex-col gap-1 text-[12px] font-semibold text-secondary">
          {t("akMode")}
          <select name="mode" defaultValue="test" className={input}>
            <option value="test">{t("akModeTest")}</option>
            <option value="live">{t("akModeLive")}</option>
            <option value="manage">{t("akModeManage")}</option>
          </select>
        </label>
        <button
          type="submit"
          disabled={busy}
          className="rounded-[10px] bg-accent px-5 py-2.5 text-[14px] font-semibold text-white hover:bg-accent-deep disabled:opacity-60"
        >
          {t("akCreate")}
        </button>
      </Form>

      <div className="rounded-[14px] border border-line bg-surface">
        {keys.length === 0 ? (
          <p className="p-5 text-[14px] text-muted-2">{t("akEmpty")}</p>
        ) : (
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-divider text-left text-[12px] uppercase tracking-wide text-muted">
                <th className="px-5 py-3 font-semibold">{t("akLabel")}</th>
                <th className="px-5 py-3 font-semibold">{t("akMode")}</th>
                <th className="px-5 py-3 font-semibold">{t("akKey")}</th>
                <th className="px-5 py-3 font-semibold">{t("akCreated")}</th>
                <th className="px-5 py-3 font-semibold">{t("akLastUsed")}</th>
                <th className="px-5 py-3" />
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.id} className="border-b border-divider/60 last:border-0">
                  <td className="px-5 py-3 font-medium text-ink">{k.label}</td>
                  <td className="px-5 py-3">
                    <span
                      className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                        k.scope === "manage"
                          ? "bg-[#e8ecf5] text-[#3d5a9a]"
                          : k.mode === "live"
                            ? "bg-[#e8f0e6] text-[#3f7a52]"
                            : "bg-[#fbeede] text-[#9a6a1e]"
                      }`}
                    >
                      {k.scope === "manage" ? t("akModeManage").toLowerCase() : k.mode}
                    </span>
                  </td>
                  <td className="px-5 py-3 font-mono text-[12px] text-muted">
                    {k.scope === "manage" ? "ak" : "sk"}_{k.mode}_…{k.last4}
                  </td>
                  <td className="px-5 py-3 text-secondary">{new Date(k.createdAt).toLocaleDateString()}</td>
                  <td className="px-5 py-3 text-secondary">{k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleDateString() : "—"}</td>
                  <td className="px-5 py-3 text-right">
                    <Form
                      method="post"
                      onSubmit={(e) => {
                        if (!confirm(t("akRevokeConfirm"))) e.preventDefault();
                      }}
                    >
                      <input type="hidden" name="intent" value="revoke" />
                      <input type="hidden" name="keyId" value={k.id} />
                      <button type="submit" disabled={busy} className="text-[13px] font-semibold text-red-600 hover:underline disabled:opacity-60">
                        {t("akRevoke")}
                      </button>
                    </Form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <ConnectSection apiOrigin={apiOrigin} />
    </div>
  );
}

/** Copy-paste connection instructions for MCP clients and the REST API —
 *  static snippets with placeholder keys (real keys are shown exactly once,
 *  at creation, and never re-rendered). */
function ConnectSection({ apiOrigin }: { apiOrigin: string }) {
  const t = useAdminT();
  const mcpUrl = `${apiOrigin}/mcp`;
  const TOOLS = ["Claude Code", "Claude / ChatGPT", "Cursor", "Other"] as const;
  const [tool, setTool] = useState<(typeof TOOLS)[number]>("Claude Code");

  const snippet: Record<(typeof TOOLS)[number], string> = {
    "Claude Code": `claude mcp add roompanda --transport http ${mcpUrl} \\
  --header "Authorization: Bearer ak_live_…"`,
    "Claude / ChatGPT": `${t("akConnectCustomHint")}

URL:    ${mcpUrl}
Header: Authorization: Bearer ak_live_…`,
    Cursor: `// .cursor/mcp.json
{
  "mcpServers": {
    "roompanda": {
      "url": "${mcpUrl}",
      "headers": { "Authorization": "Bearer ak_live_…" }
    }
  }
}`,
    Other: `${t("akConnectOtherHint")}

POST ${mcpUrl}
Authorization: Bearer ak_live_…
Content-Type: application/json

{"jsonrpc":"2.0","id":1,"method":"tools/list"}`,
  };

  const code = "block overflow-x-auto whitespace-pre rounded-[10px] border border-line bg-chip px-3.5 py-2.5 font-mono text-[12.5px] leading-relaxed text-secondary";

  return (
    <div className="mt-8">
      <h2 className="mb-1 font-serif text-[20px] font-semibold">{t("akConnectTitle")}</h2>
      <p className="mb-4 max-w-2xl text-[14px] text-secondary">{t("akConnectIntro")}</p>

      <div className="rounded-[14px] border border-line bg-surface p-5">
        <div className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-muted">{t("akConnectMcpUrl")}</div>
        <code className={`${code} mb-3`}>{mcpUrl}</code>
        <p className="mb-4 max-w-2xl text-[13px] text-muted">{t("akConnectScopes")}</p>

        <div className="mb-3 flex flex-wrap gap-1.5">
          {TOOLS.map((name) => (
            <button
              key={name}
              type="button"
              onClick={() => setTool(name)}
              className={`rounded-full border px-3.5 py-1.5 text-[13px] font-semibold ${
                tool === name ? "border-accent bg-accent text-white" : "border-line-alt bg-surface text-secondary hover:border-accent"
              }`}
            >
              {name}
            </button>
          ))}
        </div>
        <code className={code}>{snippet[tool]}</code>
      </div>

      <div className="mt-4 rounded-[14px] border border-line bg-surface p-5">
        <div className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-muted">{t("akConnectRestTitle")}</div>
        <p className="mb-3 max-w-2xl text-[13px] text-muted">
          {t("akConnectRestIntro")}{" "}
          <a href={`${apiOrigin}/v1/openapi.json`} target="_blank" rel="noreferrer" className="font-semibold text-accent hover:underline">
            {apiOrigin.replace(/^https?:\/\//, "")}/v1/openapi.json
          </a>
        </p>
        <code className={code}>{`curl ${apiOrigin}/v1/manage/property \\
  -H "Authorization: Bearer ak_live_…"`}</code>
      </div>
    </div>
  );
}

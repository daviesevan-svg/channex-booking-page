import { Form, Link, redirect, useNavigation } from "react-router";

import type { Route } from "./+types/properties";
import { FIELD_INPUT } from "~/components/admin-form";
import { requireAdmin, setSessionProperty } from "~/lib/auth.server";
import {
  addProperty,
  currentPropertyId,
  getProperties,
  removeProperty,
  renameProperty,
  setPropertyPublic,
} from "~/lib/properties.server";

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const [properties, current] = await Promise.all([getProperties(), currentPropertyId(request)]);
  return { properties, current };
}

export async function action({ request }: Route.ActionArgs) {
  await requireAdmin(request);
  const form = await request.formData();
  const intent = String(form.get("intent"));

  if (intent === "add") {
    const name = String(form.get("name") || "").trim();
    const id = String(form.get("id") || "").trim() || crypto.randomUUID();
    await addProperty(id, name);
    // Switch to the new property so editing continues there.
    return redirect("/admin", { headers: { "Set-Cookie": await setSessionProperty(request, id) } });
  }
  if (intent === "rename") {
    await renameProperty(String(form.get("id")), String(form.get("name") || ""));
    return redirect("/admin/properties");
  }
  if (intent === "delete") {
    await removeProperty(String(form.get("id")));
    return redirect("/admin/properties");
  }
  if (intent === "togglePublic") {
    await setPropertyPublic(String(form.get("id")), form.get("public") === "on");
    return redirect("/admin/properties");
  }
  if (intent === "switch") {
    return redirect("/admin", {
      headers: { "Set-Cookie": await setSessionProperty(request, String(form.get("id"))) },
    });
  }
  return redirect("/admin/properties");
}

export function meta() {
  return [{ title: "Admin · Properties" }];
}

export default function AdminProperties({ loaderData }: Route.ComponentProps) {
  const { properties, current } = loaderData;
  const nav = useNavigation();
  const saving = nav.state === "submitting";

  return (
    <div>
      <h1 className="mb-1 font-serif text-[26px] font-semibold">Properties</h1>
      <p className="mb-6 text-[14px] text-muted">
        Each property has its own rooms, rates, inventory, taxes, content and bookings. Use the
        switcher in the header (or “Edit” below) to choose which one you’re managing. Mark a
        property <strong>Public</strong> to list it on the booking-engine home page.
      </p>

      {/* list */}
      <div className="mb-7 overflow-hidden rounded-[14px] border border-line bg-surface">
        {properties.map((p, i) => (
          <div
            key={p.id}
            className={`flex flex-wrap items-center justify-between gap-3 px-5 py-4 ${
              i > 0 ? "border-t border-divider" : ""
            }`}
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2.5">
                <span className="font-semibold">{p.name}</span>
                {p.id === current && (
                  <span className="rounded-full bg-[#e8f0e6] px-2 py-0.5 text-[11px] font-semibold text-[#3f7a52]">
                    Editing
                  </span>
                )}
              </div>
              <div className="mt-0.5 font-mono text-[12px] text-muted-2">{p.id}</div>
            </div>
            <div className="flex flex-none items-center gap-3 text-[13px] font-semibold">
              <Form method="post" title={p.public ? "Listed on the public home page" : "Hidden from the public home page"}>
                <input type="hidden" name="intent" value="togglePublic" />
                <input type="hidden" name="id" value={p.id} />
                {/* flips the current value: send "on" only when turning it public */}
                {!p.public && <input type="hidden" name="public" value="on" />}
                <button
                  type="submit"
                  className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${
                    p.public
                      ? "bg-[#e8f0e6] text-[#3f7a52] hover:bg-[#dbe8d8]"
                      : "bg-chip text-muted hover:bg-line"
                  }`}
                >
                  {p.public ? "Public" : "Private"}
                </button>
              </Form>
              <Link to={`/${p.id}`} target="_blank" className="text-muted hover:text-accent">
                View ↗
              </Link>
              {p.id !== current && (
                <Form method="post">
                  <input type="hidden" name="intent" value="switch" />
                  <input type="hidden" name="id" value={p.id} />
                  <button type="submit" className="text-accent hover:underline">
                    Edit
                  </button>
                </Form>
              )}
              {properties.length > 1 && (
                <Form
                  method="post"
                  onSubmit={(e) => {
                    if (!confirm(`Remove “${p.name}” from the list? Its data is kept.`)) e.preventDefault();
                  }}
                >
                  <input type="hidden" name="intent" value="delete" />
                  <input type="hidden" name="id" value={p.id} />
                  <button type="submit" className="text-[#c0392b] hover:underline">
                    Remove
                  </button>
                </Form>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* add */}
      <Form method="post" className="flex flex-col gap-4 rounded-[14px] border border-line bg-surface p-6">
        <input type="hidden" name="intent" value="add" />
        <h2 className="font-serif text-[18px] font-semibold">Add a property</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className="block text-[13px] font-semibold text-secondary">
            Name
            <input name="name" placeholder="Seaside Inn" className={FIELD_INPUT} />
          </label>
          <label className="block text-[13px] font-semibold text-secondary">
            Property ID <span className="font-normal text-faint">(optional)</span>
            <input name="id" placeholder="auto-generated" className={`${FIELD_INPUT} font-mono`} />
            <span className="mt-1 block text-[11px] font-normal text-faint">
              For an Open Channel connection, set this to your Channex hotel code. Leave blank to
              generate one.
            </span>
          </label>
        </div>
        <div>
          <button
            type="submit"
            disabled={saving}
            className="rounded-[10px] bg-accent px-6 py-3 text-[15px] font-semibold text-white hover:bg-accent-deep disabled:opacity-60"
          >
            {saving ? "Adding…" : "Add property"}
          </button>
        </div>
      </Form>
    </div>
  );
}

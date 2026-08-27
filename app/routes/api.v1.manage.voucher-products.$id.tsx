import type { Route } from "./+types/api.v1.manage.voucher-products.$id";
import { apiError, authenticateApiKey } from "~/lib/api-auth.server";
import { getRooms } from "~/lib/catalog.server";
import { queueImageCleanup } from "~/lib/image-gc.server";
import { deleteVoucherProduct, getVoucherProducts, saveVoucherProduct } from "~/lib/vouchers.server";
import { buildVoucherProduct, serializeVoucherProduct, validateVoucherProduct } from "./api.v1.manage.voucher-products";

// GET /v1/manage/voucher-products/:id · PATCH (sparse) · DELETE. Sold vouchers
// keep their purchase-time snapshot whatever happens to the product; the
// image GC checks sold snapshots before deleting a product photo.
export async function loader({ request, params }: Route.LoaderArgs) {
  const auth = await authenticateApiKey(request, "manage");
  if (auth instanceof Response) return auth;
  const product = (await getVoucherProducts(auth.pid)).find((p) => p.id === String(params.id ?? ""));
  if (!product) return apiError(404, "not_found", "No voucher product with that id.");
  return Response.json({ data: serializeVoucherProduct(product) });
}

export async function action({ request, params }: Route.ActionArgs) {
  const auth = await authenticateApiKey(request, "manage");
  if (auth instanceof Response) return auth;
  const product = (await getVoucherProducts(auth.pid)).find((p) => p.id === String(params.id ?? ""));
  if (!product) return apiError(404, "not_found", "No voucher product with that id.");

  if (request.method === "DELETE") {
    await deleteVoucherProduct(auth.pid, product.id);
    if (product.image) queueImageCleanup(auth.pid, [product.image]);
    return Response.json({ deleted: true, note: "Already-sold vouchers keep their purchase-time snapshot and stay redeemable." });
  }

  if (request.method === "PATCH") {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return apiError(400, "bad_request", "Body must be JSON.");
    }
    const roomIds = new Set((await getRooms(auth.pid)).map((r) => r.id));
    const parsed = validateVoucherProduct(body, { create: false, roomIds });
    if (!parsed.ok) {
      return Response.json({ error: { type: "validation_error", message: "The payload has invalid fields.", fields: parsed.errors } }, { status: 422 });
    }
    const next = buildVoucherProduct(parsed.value, product);
    if (next.kind === "package" && !next.package) {
      return Response.json({ error: { type: "validation_error", message: "The payload has invalid fields.", fields: { package: ["A package voucher needs package rules."] } } }, { status: 422 });
    }
    await saveVoucherProduct(auth.pid, next);
    if (product.image && product.image !== next.image) queueImageCleanup(auth.pid, [product.image]);
    return Response.json({ data: serializeVoucherProduct(next) });
  }

  return apiError(405, "method_not_allowed", "Use PATCH to edit or DELETE to remove.");
}

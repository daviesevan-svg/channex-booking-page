import { openApiSpec } from "~/lib/openapi";

// GET /v1/openapi.json — the API's machine-readable spec (public, no auth) so
// tools, docs and SDK generators can consume it.
export function loader() {
  return Response.json(openApiSpec, {
    headers: { "Cache-Control": "public, max-age=300", "Access-Control-Allow-Origin": "*" },
  });
}

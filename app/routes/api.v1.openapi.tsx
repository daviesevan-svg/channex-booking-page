import { openApiSpec } from "~/lib/openapi";
import { managePaths, manageSchemas, manageSecuritySchemes } from "~/lib/openapi-manage";

// GET /v1/openapi.json — the API's machine-readable spec (public, no auth) so
// tools, docs and SDK generators can consume it. The management surface lives
// in openapi-manage.ts and is merged here, so the SERVED document remains the
// single source of truth for the whole /v1 API.
export function loader() {
  const doc = {
    ...openApiSpec,
    paths: { ...openApiSpec.paths, ...managePaths },
    components: {
      ...openApiSpec.components,
      securitySchemes: { ...openApiSpec.components.securitySchemes, ...manageSecuritySchemes },
      schemas: { ...openApiSpec.components.schemas, ...manageSchemas },
    },
  };
  return Response.json(doc, {
    headers: { "Cache-Control": "public, max-age=300", "Access-Control-Allow-Origin": "*" },
  });
}

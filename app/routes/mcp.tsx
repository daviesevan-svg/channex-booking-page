// POST /mcp — Model Context Protocol endpoint, so an AI agent can search a
// property's availability and make a booking without driving a browser.
//
// Transport: JSON-RPC 2.0 over a plain POST, which is the streamable-HTTP
// transport minus the optional SSE channel. Nothing here needs to stream — every
// tool is a single request/response — and skipping SSE keeps it a normal Worker
// route with no long-lived connections.
//
// Auth is the SAME per-property API key as /v1 (`Authorization: Bearer sk_…`), so
// a hotel hands its agent one URL and one key, and the key already scopes every
// call to that property.
//
// DISPATCH: each tool call is re-issued in process to the /v1 handler that
// already implements it, by building a Request and calling the loader/action
// directly. No network hop (see the worker self-fetch lesson — a Worker calling
// its own public hostname does not carry in production). The point is that
// booking creation, which touches money and live inventory, has exactly one
// implementation, and any field added to a /v1 payload appears here for free.
import type { Route } from "./+types/mcp";
import {
  PROTOCOL_VERSION,
  RPC_ERRORS,
  SERVER_INFO,
  isNotification,
  mapArguments,
  negotiateVersion,
  publicToolList,
  rpcError,
  rpcResult,
  toolByName,
  toolContent,
  toolFailure,
  type RpcRequest,
} from "~/lib/mcp";

import { loader as propertiesLoader } from "./api.v1.properties";
import { loader as availabilityLoader } from "./api.v1.availability";
import { loader as calendarLoader } from "./api.v1.calendar";
import { loader as ratesLoader } from "./api.v1.rates";
import { loader as extrasLoader } from "./api.v1.extras";
import { loader as bookingLoader } from "./api.v1.bookings.$id";
import { action as bookingsAction } from "./api.v1.bookings";
import { requireCanonicalHost } from "~/lib/domains.server";

/** The shape every /v1 handler actually uses. Their generated arg types carry
 *  router context we neither have nor need, so dispatch through this. */
type Handler = (args: { request: Request; params: Record<string, string> }) => Promise<Response>;

const HANDLERS: Record<string, Handler> = {
  "GET /v1/properties": propertiesLoader as unknown as Handler,
  "GET /v1/availability": availabilityLoader as unknown as Handler,
  "GET /v1/calendar": calendarLoader as unknown as Handler,
  "GET /v1/rates": ratesLoader as unknown as Handler,
  "GET /v1/extras": extrasLoader as unknown as Handler,
  "GET /v1/bookings/:id": bookingLoader as unknown as Handler,
  "POST /v1/bookings": bookingsAction as unknown as Handler,
};

/** Runs one tool against its /v1 handler, carrying the caller's credentials and
 *  idempotency key through unchanged. */
async function callTool(request: Request, name: string, rawArgs: unknown) {
  const tool = toolByName(name);
  if (!tool) return toolFailure(`Unknown tool "${name}".`);
  const args = (rawArgs ?? {}) as Record<string, unknown>;

  const { search, body, pathValue } = mapArguments(tool, args);
  if (tool.pathParam && !pathValue) return toolFailure(`\`${tool.pathParam}\` is required.`);

  const handler = HANDLERS[`${tool.route.method} ${tool.route.path}`];
  if (!handler) return toolFailure(`Tool "${name}" is not wired up.`);

  const base = new URL(request.url);
  const url = new URL(tool.route.path.replace(":id", encodeURIComponent(pathValue ?? "")), base.origin);
  url.search = search.toString();

  const headers = new Headers({ accept: "application/json" });
  const auth = request.headers.get("Authorization");
  if (auth) headers.set("Authorization", auth);
  if (body) headers.set("content-type", "application/json");
  // Idempotency travels as a header on /v1, but as an argument over MCP — an
  // agent retrying a tool call has no way to set headers.
  const idem = typeof args.idempotency_key === "string" ? args.idempotency_key : null;
  if (idem) headers.set("Idempotency-Key", idem);

  const res = await handler({
    request: new Request(url, { method: tool.route.method, headers, body }),
    params: { id: pathValue ?? "" },
  });

  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    // Surface the API's own reason so the model can correct itself, rather than
    // an opaque failure. This is why agents get better errors than the guest
    // checkout form, which just redirects.
    const err = (payload as { error?: { type?: string; message?: string } } | null)?.error;
    return toolFailure(
      err?.message
        ? `${err.message}${err.type ? ` (${err.type})` : ""}`
        : `The ${name} call failed with status ${res.status}.`,
    );
  }
  return toolContent(payload);
}

async function handleRpc(request: Request, req: RpcRequest) {
  switch (req.method) {
    case "initialize":
      return rpcResult(req.id, {
        protocolVersion: negotiateVersion(req.params?.protocolVersion),
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          "Booking tools for one hotel. Call get_property first for the currency, then search_availability for a stay, then create_booking. If a booking comes back as pending_payment, give the guest the payment_url — it is not confirmed until they pay. Never handle card details yourself.",
      });
    case "ping":
      return rpcResult(req.id, {});
    case "tools/list":
      return rpcResult(req.id, { tools: publicToolList() });
    case "tools/call": {
      const name = String(req.params?.name ?? "");
      if (!name) return rpcError(req.id, RPC_ERRORS.invalidParams, "`name` is required.");
      return rpcResult(req.id, await callTool(request, name, req.params?.arguments));
    }
    default:
      return rpcError(req.id, RPC_ERRORS.methodNotFound, `Unknown method "${req.method}".`);
  }
}

export async function action({ request }: Route.ActionArgs) {
  // Never on a hotel's custom domain — the tool descriptor is served before any key check.
  requireCanonicalHost(request);
  if (request.method !== "POST") {
    return Response.json(rpcError(null, RPC_ERRORS.invalidRequest, "Use POST."), { status: 405 });
  }

  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return Response.json(rpcError(null, RPC_ERRORS.parse, "Body must be JSON-RPC 2.0."), { status: 400 });
  }

  // A batch is a JSON array; notifications inside it produce no entry, and an
  // all-notification batch gets 202 with no body.
  const batch = Array.isArray(parsed) ? (parsed as RpcRequest[]) : null;
  const items = batch ?? [parsed as RpcRequest];
  const out: unknown[] = [];
  for (const item of items) {
    if (!item || item.jsonrpc !== "2.0" || typeof item.method !== "string") {
      out.push(rpcError((item as RpcRequest)?.id ?? null, RPC_ERRORS.invalidRequest, "Malformed JSON-RPC request."));
      continue;
    }
    try {
      const answer = await handleRpc(request, item);
      if (!isNotification(item)) out.push(answer);
    } catch (e) {
      console.log(`[mcp] ${item.method} threw: ${e instanceof Error ? e.message : e}`);
      if (!isNotification(item)) {
        out.push(rpcError(item.id, RPC_ERRORS.internal, "The server hit an unexpected error."));
      }
    }
  }

  if (out.length === 0) return new Response(null, { status: 202 });
  return Response.json(batch ? out : out[0]);
}

/** A GET is how some clients probe the endpoint; answer with something useful
 *  rather than a router 404. */
export function loader({ request }: Route.LoaderArgs) {
  // Unauthenticated, so it needs the host gate in its own right — otherwise this
  // descriptor advertises our platform from every hotel's own domain.
  requireCanonicalHost(request);
  return Response.json({
    protocol: "mcp",
    protocolVersion: PROTOCOL_VERSION,
    transport: "streamable-http (POST only, no SSE)",
    auth: "Authorization: Bearer sk_live_… (the property's API key)",
    tools: publicToolList().map((t) => t.name),
  });
}

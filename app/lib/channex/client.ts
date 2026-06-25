import { convertToCamelCase, convertToSnakeCase } from "./case";

export interface ChannexConfig {
  /** API origin, e.g. https://app.channex.io */
  apiUrl: string;
  /** Booking Engine meta-channel code (REACT_APP_CHANNEL_CODE) */
  channelCode: string;
  /** Optional group filter (legacy). */
  groupId?: string;
}

export class ChannexApiError extends Error {
  status: number;
  errors: unknown;
  constructor(status: number, errors: unknown) {
    super(`Channex API error (${status})`);
    this.name = "ChannexApiError";
    this.status = status;
    this.errors = errors;
  }
}

// JSON:API-style payloads wrap records in { attributes, id, type }.
function extractAttributes<T>(payload: unknown): T {
  if (Array.isArray(payload)) {
    return payload.map((entry) => extractAttributes(entry)) as unknown as T;
  }
  if (payload && typeof payload === "object") {
    const { attributes, ...rest } = payload as Record<string, unknown>;
    if (attributes && typeof attributes === "object") {
      return { ...rest, ...(attributes as object) } as T;
    }
  }
  return payload as T;
}

// The booking engine holds its own ARI (manual catalog + Open Channel push), so
// the shopping/availability read endpoints are gone. The only remaining call is
// the meta push_booking — and that will move to the Open Channel booking webhook
// when live booking is enabled.
export function createChannexClient(config: ChannexConfig) {
  const { apiUrl, channelCode } = config;
  const prefix = `/api/v1/meta/${channelCode}`;

  async function post<T>(path: string, payload: unknown): Promise<T> {
    const res = await fetch(`${apiUrl}${prefix}${path}`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(convertToSnakeCase(payload)),
    });
    const body = (await res.json().catch(() => ({}))) as { data?: unknown; errors?: unknown };
    if (!res.ok || body.errors) {
      throw new ChannexApiError(res.status, body.errors ?? body);
    }
    return extractAttributes<T>(convertToCamelCase(body.data));
  }

  return {
    pushBooking: <T = unknown>(propertyId: string, booking: unknown) =>
      post<T>(`/${propertyId}/push_booking`, { booking }),
  };
}

export type ChannexClient = ReturnType<typeof createChannexClient>;

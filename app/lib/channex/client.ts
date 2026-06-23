import { convertToCamelCase, convertToSnakeCase } from "./case";
import { stringifyArguments } from "./query";
import type {
  ClosedDates,
  PropertyInfo,
  PropertyListItem,
  RoomsQuery,
  RoomWithRates,
} from "./types";

export interface ChannexConfig {
  /** API origin, e.g. https://app.channex.io */
  apiUrl: string;
  /** Booking Engine meta-channel code (REACT_APP_CHANNEL_CODE) */
  channelCode: string;
  /** Optional group filter for property_list */
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
// Flatten attributes up to the record root, recursively for arrays.
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

export function createChannexClient(config: ChannexConfig) {
  const { apiUrl, channelCode, groupId } = config;
  const prefix = `/api/v1/meta/${channelCode}`;

  async function get<T>(path: string, params?: Record<string, unknown>): Promise<T> {
    const query = stringifyArguments(convertToSnakeCase(params ?? {}) as Record<string, never>);
    const res = await fetch(`${apiUrl}${prefix}${path}${query}`, {
      headers: { Accept: "application/json" },
    });
    const body = (await res.json().catch(() => ({}))) as {
      data?: unknown;
      errors?: unknown;
    };
    if (!res.ok || body.errors) {
      throw new ChannexApiError(res.status, body.errors ?? body);
    }
    return extractAttributes<T>(convertToCamelCase(body.data));
  }

  async function post<T>(path: string, payload: unknown): Promise<T> {
    const res = await fetch(`${apiUrl}${prefix}${path}`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(convertToSnakeCase(payload)),
    });
    const body = (await res.json().catch(() => ({}))) as {
      data?: unknown;
      errors?: unknown;
    };
    if (!res.ok || body.errors) {
      throw new ChannexApiError(res.status, body.errors ?? body);
    }
    return extractAttributes<T>(convertToCamelCase(body.data));
  }

  return {
    getPropertyInfo: (propertyId: string) =>
      get<PropertyInfo>(`/${propertyId}/property_info`),

    getClosedDates: (propertyId: string) =>
      get<ClosedDates>(`/${propertyId}/closed_dates`),

    getRooms: (propertyId: string, query: RoomsQuery = {}) =>
      get<RoomWithRates[]>(`/${propertyId}/rooms`, {
        ...query,
        withVirtualRatePlans: true,
      }),

    getBestOffer: (propertyId: string, query: RoomsQuery = {}) =>
      get<PropertyInfo & { bestOffer?: string }>(`/${propertyId}/best_offer`, {
        ...query,
        withVirtualRatePlans: true,
      }),

    getPropertiesList: (params: Record<string, unknown> = {}) =>
      get<PropertyListItem[]>(`/property_list`, {
        isAvailable: true,
        ...params,
        filter: { ...(groupId ? { groupId } : {}), ...(params.filter as object) },
      }),

    getCardCaptureFormUrl: () =>
      get<{ url: string }>(`/card_capture_form_url`),

    pushBooking: <T = unknown>(propertyId: string, booking: unknown) =>
      post<T>(`/${propertyId}/push_booking`, { booking }),
  };
}

export type ChannexClient = ReturnType<typeof createChannexClient>;

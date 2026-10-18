import { env } from "cloudflare:workers";
import type { InventoryScope } from "../ari/read.server";
import type { AriPushResult, SyncKind } from "./push.server";

export interface GoogleAriWork {
  pid: string;
  kinds: SyncKind[];
  scope?: InventoryScope;
  /** Explicit OFF/ON transitions supersede queued work in their arrival order. */
  transition?: "disable" | "enable";
}

/** Persist before acknowledging the enqueue. A missing binding is a deployment
 * error, never permission to bypass per-property serialization. */
export async function submitGoogleAriWork(work: GoogleAriWork, immediate = false): Promise<AriPushResult[]> {
  const namespace = (env as unknown as { GOOGLE_ARI_QUEUE?: DurableObjectNamespace }).GOOGLE_ARI_QUEUE;
  if (!namespace) throw new Error("GOOGLE_ARI_QUEUE binding is not configured; Google ARI work was not queued.");
  const stub = namespace.get(namespace.idFromName(work.pid));
  const response = await stub.fetch(`https://google-ari.internal/${immediate ? "run" : "enqueue"}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(work),
  });
  if (!response.ok) throw new Error(`Google ARI enqueue failed: HTTP ${response.status}`);
  const body = await response.json() as { results?: AriPushResult[] };
  return body.results ?? [];
}

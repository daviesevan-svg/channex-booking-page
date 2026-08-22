import { startTransition, StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";
import type { Location } from "react-router";
import { HydratedRouter } from "react-router/dom";

declare global {
  interface Window {
    /** React Router's hydrated data router — internal, assigned by HydratedRouter. */
    __reactRouterDataRouter?: {
      state: {
        navigation: { state: "idle" | "loading" | "submitting"; location?: Location };
      };
    };
  }
}

// Every merge deploys, and a deploy deletes the previous build's hashed chunks
// (Workers static assets serve only the current deployment). A tab opened
// before the deploy then fails its next lazy route import — worst on the
// checkout → confirmation redirect, where React Router's built-in recovery
// (window.location.reload()) reloads the CURRENT url: the guest lands back on
// an empty checkout even though their booking was created, and never sees the
// confirmation. Recover by hard-navigating to the in-flight destination
// instead, so the new deployment serves the page the router was headed to.
window.addEventListener("vite:preloadError", (event) => {
  const navigation = window.__reactRouterDataRouter?.state.navigation;
  // Only a "loading" navigation is safe to recover by GET: its pending
  // location is what the router itself would GET next (after an action
  // redirect the state is "loading" — the POST already ran; the submission's
  // formMethod stays on the navigation, so don't test that). Recovering
  // during "submitting" would abort the in-flight POST by GETting its target.
  if (navigation?.state !== "loading" || !navigation.location) return;
  // An import that failed because the connection dropped isn't deploy skew:
  // the recovery navigation couldn't commit either, and preventDefault would
  // leave the router caching the failed module. Let the browser come back.
  if (navigator.onLine === false) return;
  const { pathname, search, hash } = navigation.location;
  const target = pathname + search + hash;
  try {
    // Cooldown per destination: a genuinely broken asset can't spin a
    // navigation loop, while a later deploy in the same tab may still
    // recover the same page.
    const [lastTarget, lastAt] = sessionStorage.getItem("chunk-recovery")?.split("\n") ?? [];
    if (lastTarget === target && Date.now() - Number(lastAt) < 30_000) return;
    sessionStorage.setItem("chunk-recovery", `${target}\n${Date.now()}`);
  } catch {
    // sessionStorage unavailable — recover anyway; the guard is best-effort.
  }
  event.preventDefault();
  window.location.assign(target);
});

startTransition(() => {
  hydrateRoot(
    document,
    <StrictMode>
      <HydratedRouter />
    </StrictMode>,
  );
});

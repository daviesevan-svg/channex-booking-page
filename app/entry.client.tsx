import { startTransition, StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";
import { HydratedRouter } from "react-router/dom";

// Every merge deploys, and a deploy deletes the previous build's hashed chunks
// (Workers static assets serve only the current deployment). A tab opened
// before the deploy then fails its next lazy route import — worst on the
// checkout → confirmation redirect, where React Router's built-in recovery
// (window.location.reload()) reloads the CURRENT url: the guest lands back on
// an empty checkout even though their booking was created, and never sees the
// confirmation. Recover by hard-navigating to the in-flight destination
// instead, so the new deployment serves the page the router was headed to.
window.addEventListener("vite:preloadError", (event) => {
  const router = (
    window as unknown as {
      __reactRouterDataRouter?: {
        state: { navigation: { location?: { pathname: string; search: string; hash: string } } };
      };
    }
  ).__reactRouterDataRouter;
  const pending = router?.state.navigation.location;
  if (!pending) return; // not mid-navigation — leave React Router's reload fallback in charge
  try {
    // One recovery attempt per destination, so a genuinely broken asset can't
    // put the browser in a navigation loop.
    const key = "chunk-recovery";
    const target = pending.pathname + pending.search + pending.hash;
    if (sessionStorage.getItem(key) === target) return;
    sessionStorage.setItem(key, target);
  } catch {
    // sessionStorage unavailable — recover anyway; the guard is best-effort.
  }
  event.preventDefault();
  window.location.assign(pending.pathname + pending.search + pending.hash);
});

startTransition(() => {
  hydrateRoot(
    document,
    <StrictMode>
      <HydratedRouter />
    </StrictMode>,
  );
});

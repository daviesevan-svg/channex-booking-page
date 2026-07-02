import type { Route } from "./+types/embed.script";

// GET /embed.js — the public loader script a hotel drops on its own site:
//   <script async src="https://book.roompanda.com/embed.js" data-property="PID"></script>
// It injects an iframe of /embed/{PID} (full style isolation from the host site),
// resizes it to fit via postMessage, and relays the "go to booking" navigation to
// the host's top window. The serving origin is baked in so both the iframe src and
// the accepted message origin are exact (no host tampering).
export async function loader({ request }: Route.LoaderArgs) {
  const origin = new URL(request.url).origin;
  const js = `(function(){
  var ORIGIN = ${JSON.stringify(origin)};
  // Find our own tag (document.currentScript is null for async scripts).
  var s = document.currentScript || document.querySelector('script[data-property][src*="/embed.js"]');
  if (!s) return;
  var pid = s.getAttribute("data-property");
  if (!pid) { console.error("[roompanda] embed.js: missing data-property"); return; }
  var targetId = s.getAttribute("data-target");
  var frame = document.createElement("iframe");
  frame.src = ORIGIN + "/embed/" + encodeURIComponent(pid);
  frame.title = "Book your stay";
  frame.setAttribute("loading", "lazy");
  frame.style.width = "100%";
  frame.style.border = "0";
  frame.style.height = (parseInt(s.getAttribute("data-height") || "", 10) || 150) + "px";
  frame.style.overflow = "hidden";
  frame.style.colorScheme = "normal";
  var mount = targetId && document.getElementById(targetId);
  if (mount) mount.appendChild(frame); else if (s.parentNode) s.parentNode.insertBefore(frame, s.nextSibling);
  window.addEventListener("message", function(e){
    if (e.origin !== ORIGIN || e.source !== frame.contentWindow) return;
    var d = e.data;
    if (!d || typeof d !== "object") return;
    if (d.type === "roompanda:height" && typeof d.height === "number") {
      frame.style.height = Math.max(80, d.height) + "px";
    } else if (d.type === "roompanda:navigate" && typeof d.url === "string" && d.url.indexOf(ORIGIN + "/") === 0) {
      window.location.href = d.url; // top-level navigation into the booking flow
    }
  });
})();`;
  return new Response(js, {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=300",
    },
  });
}

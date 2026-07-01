# Google ARI egress proxy

Google Hotel Center authenticates ARI pushes by the **source IP** of the POST.
Cloudflare Workers have **no stable egress IP** (outbound `fetch` leaves from a
large, shifting pool of shared Cloudflare addresses), so there's nothing you can
reliably whitelist. This proxy solves that: a tiny always-on Fly.io machine with
a **static egress IP** relays our ARI POSTs to `www.google.com` from that one
whitelisted address.

```
Worker  ──POST──▶  this proxy (static egress IP)  ──▶  www.google.com
        X-Ari-Proxy-Key         whitelisted in Google Hotel Center
```

It only forwards `POST /travel/hotels/uploads/*`, and only when the
`X-Ari-Proxy-Key` header matches — so it can't be used as an open relay to Google.

## Deploy (one time)

From this directory, with [flyctl](https://fly.io/docs/flyctl/install/) installed:

```sh
# 1. Create the app (don't deploy yet). Pick your own unique name and edit
#    `app` + `primary_region` in fly.toml to match.
fly apps create roompanda-ari-proxy

# 2. Set the shared secret (must match the Worker's GOOGLE_ARI_PROXY_KEY).
fly secrets set ARI_PROXY_KEY="$(openssl rand -hex 24)" -a roompanda-ari-proxy
#    ^ copy this value; you'll set the same one on the Worker below.

# 3. Deploy.
fly deploy

# 4. Allocate a STATIC EGRESS IP (this is the IP Google sees on outbound pushes).
#    NOTE: this is `allocate-egress`, NOT `allocate-v4` (that's inbound only and
#    is NOT the egress IP). One egress IP per region — keep the app single-region.
fly ips allocate-egress -a roompanda-ari-proxy
#    Prints the IPv4/IPv6 egress pair. Copy the IPv4.
```

You can re-print the egress IP any time with `fly ips list -a roompanda-ari-proxy`
(look for the `egress` type).

## Wire it up

1. **Google Hotel Center → Price Settings → IP whitelist:** add the IPv4 egress
   IP from step 4.
2. **Cloudflare (the Worker), dashboard secrets/vars:**
   - `GOOGLE_ARI_BASE_URL = https://roompanda-ari-proxy.fly.dev` (your app host)
   - `GOOGLE_ARI_PROXY_KEY = <the ARI_PROXY_KEY from step 2>`
   - (plus `GOOGLE_ARI_PARTNER_KEY`, the Hotel Center partner key, as before)
3. In the app, `/admin/google-hotels` → enable the push → **Push everything**.
   The results should turn from `HTTP 400 … no match for IP` to success.

## Verify

```sh
# Health check (no secret needed):
curl https://roompanda-ari-proxy.fly.dev/healthz            # -> ok

# Wrong/no secret is refused:
curl -X POST https://roompanda-ari-proxy.fly.dev/travel/hotels/uploads/taxes   # -> 403

# Confirm outbound egress really is the allocated IP:
fly ssh console -a roompanda-ari-proxy -C "wget -qO- https://api.ipify.org"
```

## Notes

- **Single region.** Egress IPs are per-region; keep `min_machines_running = 1`
  in one region so there's exactly one IP to whitelist. If you scale to another
  region, allocate an egress IP there too and whitelist it.
- **Cost:** ~$3.60/mo for the egress IP + a shared-cpu-1x machine.
- The proxy is stateless and holds no secrets beyond `ARI_PROXY_KEY`; the Hotel
  Center partner key travels inside the XML/headers from the Worker, untouched.

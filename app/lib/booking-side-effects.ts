// What a finalized booking is allowed to touch, and why.
//
// Finalization has always branched on one thing: `status !== "failed"`. That
// conflated two situations that look identical in the record and are not
// remotely the same:
//
//  1. A REAL guest at a property whose Channex push is off — live bookings not
//     enabled yet, or no channel manager connected. They have really booked and
//     may really have paid; the only thing missing is the push, which the
//     hotelier handles by hand. Everything must happen: inventory, emails,
//     voucher settlement, analytics.
//
//  2. A booking made with an API TEST key. Nothing about it is real, and it must
//     not consume or alter anything that is — yet it decremented the property's
//     availability, mailed a confirmation to whatever address it named, spent
//     gift-voucher balance and booked revenue into the funnel.
//
// Only the caller knows which one it is, so `testMode` says so explicitly
// rather than being inferred from `live` — inferring it is precisely the
// mistake that made a test key able to empty a real hotel's calendar.
//
// The webhook is the deliberate exception. Its consumer is the integrator who
// owns the property and is testing against it, the payload carries the
// booking's status, and an integration you cannot exercise without touching
// production is not a test mode anyone can use.

export interface BookingSideEffects {
  /** Decrement our cached availability, and record the hold on the booking. */
  holdsInventory: boolean;
  /** Guest confirmation + host notification. */
  sendsEmails: boolean;
  /** booking.created to the property's webhook subscribers. */
  dispatchesWebhook: boolean;
  /** The purchase step of the internal funnel, with its money value. */
  logsAnalytics: boolean;
  /** Spend the gift-voucher hold. False means release it back instead. */
  settlesVoucher: boolean;
}

export function bookingSideEffects(input: {
  /** "failed" means no stay exists; anything else means one does. */
  status: string;
  /** Made with an API test key. */
  testMode?: boolean;
}): BookingSideEffects {
  const stands = input.status !== "failed";
  const real = stands && !input.testMode;
  return {
    holdsInventory: real,
    sendsEmails: real,
    logsAnalytics: real,
    settlesVoucher: real,
    // See above: honest because the payload states the status, and useful
    // because it is the only way to exercise an integration.
    dispatchesWebhook: stands,
  };
}

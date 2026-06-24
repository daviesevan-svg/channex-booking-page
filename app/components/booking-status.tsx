import type { BookingStatus } from "~/lib/bookings.server";

const STYLES: Record<BookingStatus, { label: string; icon: string; bg: string; fg: string }> = {
  confirmed: { label: "Sent to Channex", icon: "✓", bg: "#e8f0e6", fg: "#3f7a52" },
  simulated: { label: "Demo — not sent", icon: "◐", bg: "#f5efe5", fg: "#9a7b3f" },
  failed: { label: "Failed to send", icon: "✕", bg: "#fbe9e7", fg: "#c0392b" },
};

/** Pill showing whether a booking reached Channex. */
export function BookingStatusBadge({ status }: { status: BookingStatus }) {
  const s = STYLES[status];
  return (
    <span
      className="inline-flex flex-none items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-semibold"
      style={{ background: s.bg, color: s.fg }}
    >
      <span className="text-[11px] leading-none">{s.icon}</span>
      {s.label}
    </span>
  );
}

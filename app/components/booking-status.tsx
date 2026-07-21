import type { BookingStatus } from "~/lib/bookings.server";
import { useAdminT } from "~/lib/admin-i18n";

const STYLES: Record<BookingStatus, { key: string; icon: string; bg: string; fg: string }> = {
  confirmed: { key: "bkStatus_confirmed", icon: "✓", bg: "#e8f0e6", fg: "#3f7a52" },
  simulated: { key: "bkStatus_simulated", icon: "◐", bg: "#f5efe5", fg: "#9a7b3f" },
  failed: { key: "bkStatus_failed", icon: "✕", bg: "#fbe9e7", fg: "#c0392b" },
};

/** Pill showing whether a booking reached Channex. */
export function BookingStatusBadge({ status }: { status: BookingStatus }) {
  const t = useAdminT();
  const s = STYLES[status];
  return (
    <span
      className="inline-flex flex-none items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-semibold"
      style={{ background: s.bg, color: s.fg }}
    >
      <span className="text-[11px] leading-none">{s.icon}</span>
      {t(s.key)}
    </span>
  );
}

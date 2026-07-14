import { VR_AMENITIES } from "~/lib/content";

/** Checkbox grid over the structured amenity vocabulary (Google's fixed VR
 *  amenity list). Used on Property details (property-wide amenities) and the
 *  room editor (per-room amenities). Plain inputs named `amenity` — the caller's
 *  form action reads them with form.getAll("amenity"). */
export function AmenitiesPicker({ selected }: { selected: string[] }) {
  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3">
      {VR_AMENITIES.map((a) => (
        <label key={a.key} className="flex items-center gap-2 text-[13.5px] text-secondary">
          <input
            type="checkbox"
            name="amenity"
            value={a.key}
            defaultChecked={selected.includes(a.key)}
            className="h-4 w-4 accent-[var(--accent)]"
          />
          {a.label}
        </label>
      ))}
    </div>
  );
}

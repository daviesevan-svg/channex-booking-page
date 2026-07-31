// The one place a website section becomes markup.
//
// The home page and every extra page render through here, so a section can't
// behave differently depending on which page it was dropped on — and with the
// website layer off this same switch renders the legacy booking-page layout, so
// that page has no second code path to drift from.
//
// The hero is the exception and is passed in as a node: it owns the search
// form's state (dates, guests, promo, calendar), and lifting that out would mean
// threading a dozen values through here for nothing. Only the home page has one.

import { useNavigate } from "react-router";

import { ContactSection } from "~/components/contact-section";
import { MapSection } from "~/components/map-section";
import {
  FacilitiesSection,
  GallerySection,
  HighlightsSection,
  ReviewsSection,
  RichTextSection,
  RoomsSection,
  VouchersSection,
  sectionHeading,
} from "~/components/sections";
import type { Translator } from "~/lib/i18n";
import type { SectionData } from "~/lib/section-data";
import { numberSetting, settingOf, type ResolvedSection } from "~/lib/sections";
import { useBase } from "~/lib/base";
import { Band } from "~/components/site-style";

export function SectionList({
  sections,
  data,
  tr,
  hotelName,
  hero,
  highlights = [],
}: {
  sections: ResolvedSection[];
  data: SectionData;
  tr: Translator;
  hotelName: string;
  /** The home page's hero, already built. */
  hero?: React.ReactNode;
  /** The home page's three selling points, from Website → Home. */
  highlights?: { title: string; description: string }[];
}) {
  const base = useBase();
  const navigate = useNavigate();

  // One section's markup. Pulled out of the map so the band wrapper can go
  // around it without indenting the whole switch.
  const renderSection = (section: ResolvedSection) => {
    switch (section.type) {
          case "hero":
            // A page without a hero simply renders nothing here — the section
            // list is normalized per page, so this only happens if the home
            // page's hero was somehow requested without one being passed.
            return hero ?? null;
          case "highlights":
            return <HighlightsSection key={section.id} highlights={highlights} />;
          case "rooms":
            return (
              <RoomsSection
                key={section.id}
                section={section}
                tr={tr}
                rooms={data.rooms}
              />
            );
          case "gallery":
            return (
              <GallerySection
                key={section.id}
                section={section}
                tr={tr}
                gallery={data.gallery}
                hotelName={hotelName}
                fallbackPhoto={data.fallbackPhoto}
              />
            );
          case "facilities":
            return (
              <FacilitiesSection
                key={section.id}
                section={section}
                tr={tr}
                facilities={data.facilities}
                facilitiesExtra={data.facilitiesExtra}
              />
            );
          case "reviews":
            return (
              <ReviewsSection
                key={section.id}
                section={section}
                tr={tr}
                reviews={data.reviews}
                hotelName={hotelName}
              />
            );
          case "vouchers":
            return (
              <VouchersSection
                key={section.id}
                section={section}
                tr={tr}
                hasVouchers={data.hasVouchers}
                onOpen={() => navigate(`${base}/vouchers`)}
              />
            );
          case "map":
            // No coordinates, no map — a location section pointing at 0,0 in the
            // Atlantic is worse than no location section.
            return data.map ? (
              <MapSection
                key={section.id}
                heading={sectionHeading(section, tr)}
                directions={section.text?.directions}
                address={data.map.address}
                lat={data.map.lat}
                lng={data.map.lng}
                zoom={numberSetting(section, "zoom", 15)}
                mapKey={data.map.mapKey}
                hotelName={hotelName}
                tr={tr}
              />
            ) : null;
          case "contact":
            return (
              <ContactSection
                key={section.id}
                heading={sectionHeading(section, tr)}
                intro={section.text?.intro}
                details={data.contact}
                // Nothing to deliver to: show the details and drop the form
                // rather than accepting messages that go nowhere.
                showForm={settingOf(section, "showForm", true) && data.contact.canReceive}
                tr={tr}
              />
            );
          case "richText":
            return <RichTextSection key={section.id} section={section} hotelName={hotelName} />;
        }
  };

  return (
    <>
      {sections.map((section, index) => (
        <Band key={section.id} index={index} type={section.type}>
          {renderSection(section)}
        </Band>
      ))}
    </>
  );
}

// The MCP dispatch table: tool route template → the /v1 loader/action that
// implements it, called in process (see routes/mcp.tsx for why). Lives in a
// *.server module rather than the route because the route may only export
// loader/action cleanly — exporting this map from there dragged every stripped
// loader import into the CLIENT build and failed it with 32 missing exports.
// Being importable also lets a test prove every advertised tool is wired
// (set_tax_config once shipped without an entry: listed fine, failed at call).
import { loader as propertiesLoader } from "../routes/api.v1.properties";
import { loader as availabilityLoader } from "../routes/api.v1.availability";
import { loader as calendarLoader } from "../routes/api.v1.calendar";
import { loader as ratesLoader } from "../routes/api.v1.rates";
import { loader as extrasLoader } from "../routes/api.v1.extras";
import { loader as bookingLoader } from "../routes/api.v1.bookings.$id";
import { action as bookingsAction } from "../routes/api.v1.bookings";
import { loader as managePropertyLoader, action as managePropertyAction } from "../routes/api.v1.manage.property";
import { loader as manageContentLoader, action as manageContentAction } from "../routes/api.v1.manage.property.content";
import { loader as manageRoomsLoader, action as manageRoomsAction } from "../routes/api.v1.manage.rooms";
import { loader as manageRoomLoader, action as manageRoomAction } from "../routes/api.v1.manage.rooms.$id";
import { loader as manageRatesLoader, action as manageRatesAction } from "../routes/api.v1.manage.rates";
import { loader as manageRateLoader, action as manageRateAction } from "../routes/api.v1.manage.rates.$id";
import { loader as manageTaxesLoader, action as manageTaxesAction } from "../routes/api.v1.manage.taxes";
import { loader as manageExtrasLoader, action as manageExtrasAction } from "../routes/api.v1.manage.extras";
import { loader as manageExtraLoader, action as manageExtraAction } from "../routes/api.v1.manage.extras.$id";
import { loader as managePromotionsLoader, action as managePromotionsAction } from "../routes/api.v1.manage.promotions";
import { loader as managePromotionLoader, action as managePromotionAction } from "../routes/api.v1.manage.promotions.$id";
import { loader as manageBookingsLoader } from "../routes/api.v1.manage.bookings";
import { loader as manageBookingLoader } from "../routes/api.v1.manage.bookings.$id";
import { loader as manageAriLoader } from "../routes/api.v1.manage.ari";

import { loader as manageSiteLoader, action as manageSiteAction } from "../routes/api.v1.manage.site";
import { loader as manageSitePagesLoader, action as manageSitePagesAction } from "../routes/api.v1.manage.site.pages";
import { loader as manageSitePageLoader, action as manageSitePageAction } from "../routes/api.v1.manage.site.pages.$id";
import { action as manageSiteSectionsAction } from "../routes/api.v1.manage.site.pages.$id.sections";
import { loader as manageSiteCopyLoader, action as manageSiteCopyAction } from "../routes/api.v1.manage.site.pages.$id.copy";
import { loader as manageFooterLoader, action as manageFooterAction } from "../routes/api.v1.manage.site.footer";

/** The shape every /v1 handler actually uses. Their generated arg types carry
 *  router context we neither have nor need, so dispatch through this. */
type Handler = (args: { request: Request; params: Record<string, string> }) => Promise<Response>;

export const HANDLERS: Record<string, Handler> = {
  "GET /v1/properties": propertiesLoader as unknown as Handler,
  "GET /v1/availability": availabilityLoader as unknown as Handler,
  "GET /v1/calendar": calendarLoader as unknown as Handler,
  "GET /v1/rates": ratesLoader as unknown as Handler,
  "GET /v1/extras": extrasLoader as unknown as Handler,
  "GET /v1/bookings/:id": bookingLoader as unknown as Handler,
  "POST /v1/bookings": bookingsAction as unknown as Handler,
  "GET /v1/manage/property": managePropertyLoader as unknown as Handler,
  "PATCH /v1/manage/property": managePropertyAction as unknown as Handler,
  "GET /v1/manage/property/content": manageContentLoader as unknown as Handler,
  "PATCH /v1/manage/property/content": manageContentAction as unknown as Handler,
  "GET /v1/manage/rooms": manageRoomsLoader as unknown as Handler,
  "POST /v1/manage/rooms": manageRoomsAction as unknown as Handler,
  "PUT /v1/manage/rooms": manageRoomsAction as unknown as Handler,
  "GET /v1/manage/rooms/:id": manageRoomLoader as unknown as Handler,
  "PATCH /v1/manage/rooms/:id": manageRoomAction as unknown as Handler,
  "DELETE /v1/manage/rooms/:id": manageRoomAction as unknown as Handler,
  "GET /v1/manage/rates": manageRatesLoader as unknown as Handler,
  "POST /v1/manage/rates": manageRatesAction as unknown as Handler,
  "PUT /v1/manage/rates": manageRatesAction as unknown as Handler,
  "GET /v1/manage/rates/:id": manageRateLoader as unknown as Handler,
  "PATCH /v1/manage/rates/:id": manageRateAction as unknown as Handler,
  "DELETE /v1/manage/rates/:id": manageRateAction as unknown as Handler,
  "GET /v1/manage/taxes": manageTaxesLoader as unknown as Handler,
  "PUT /v1/manage/taxes": manageTaxesAction as unknown as Handler,
  "GET /v1/manage/extras": manageExtrasLoader as unknown as Handler,
  "POST /v1/manage/extras": manageExtrasAction as unknown as Handler,
  "GET /v1/manage/extras/:id": manageExtraLoader as unknown as Handler,
  "PATCH /v1/manage/extras/:id": manageExtraAction as unknown as Handler,
  "DELETE /v1/manage/extras/:id": manageExtraAction as unknown as Handler,
  "GET /v1/manage/promotions": managePromotionsLoader as unknown as Handler,
  "POST /v1/manage/promotions": managePromotionsAction as unknown as Handler,
  "GET /v1/manage/promotions/:id": managePromotionLoader as unknown as Handler,
  "PATCH /v1/manage/promotions/:id": managePromotionAction as unknown as Handler,
  "DELETE /v1/manage/promotions/:id": managePromotionAction as unknown as Handler,
  "GET /v1/manage/site": manageSiteLoader as unknown as Handler,
  "PATCH /v1/manage/site": manageSiteAction as unknown as Handler,
  "GET /v1/manage/site/pages": manageSitePagesLoader as unknown as Handler,
  "POST /v1/manage/site/pages": manageSitePagesAction as unknown as Handler,
  "GET /v1/manage/site/pages/:id": manageSitePageLoader as unknown as Handler,
  "PATCH /v1/manage/site/pages/:id": manageSitePageAction as unknown as Handler,
  "DELETE /v1/manage/site/pages/:id": manageSitePageAction as unknown as Handler,
  "PUT /v1/manage/site/pages/:id/sections": manageSiteSectionsAction as unknown as Handler,
  "GET /v1/manage/site/pages/:id/copy": manageSiteCopyLoader as unknown as Handler,
  "PATCH /v1/manage/site/pages/:id/copy": manageSiteCopyAction as unknown as Handler,
  "GET /v1/manage/site/footer": manageFooterLoader as unknown as Handler,
  "PUT /v1/manage/site/footer": manageFooterAction as unknown as Handler,
  "GET /v1/manage/bookings": manageBookingsLoader as unknown as Handler,
  "GET /v1/manage/bookings/:id": manageBookingLoader as unknown as Handler,
  "GET /v1/manage/ari": manageAriLoader as unknown as Handler,
};


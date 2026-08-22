import { describe, expect, it } from "vitest";

import { canManageProperty, canOwnProperty, ownerOnlyValue } from "./property-access";

const property = { owner: "owner@hotel.com", partnerId: "pms-a" };
const otherPartnerHotel = { owner: "owner@hotel.com", partnerId: "pms-b" };
const unpartnered = { owner: "owner@hotel.com" };

const teammate = { email: "teammate@hotel.com", role: "member" };
const owner = { email: "owner@hotel.com", role: "member" };
const partnerAdmin = { email: "admin@pms-a.com", role: "partner_admin", partnerId: "pms-a" };
const otherPartnerAdmin = { email: "admin@pms-b.com", role: "partner_admin", partnerId: "pms-b" };
const superadmin = { email: "evan@channex.io", role: "superadmin", superadmin: true };

describe("canOwnProperty", () => {
  it("denies a teammate", () => {
    expect(canOwnProperty(teammate, property)).toBe(false);
  });

  it("allows the hotel owner", () => {
    expect(canOwnProperty(owner, property)).toBe(true);
  });

  it("denies a partner_admin who does not own the hotel", () => {
    expect(canOwnProperty(partnerAdmin, property)).toBe(false);
  });

  it("allows a superadmin", () => {
    expect(canOwnProperty(superadmin, property)).toBe(true);
    expect(canOwnProperty(superadmin, undefined)).toBe(true);
  });

  it("allows a partner_admin who personally owns the hotel", () => {
    expect(canOwnProperty({ ...partnerAdmin, email: property.owner }, property)).toBe(true);
  });
});

describe("canManageProperty", () => {
  it("denies a teammate", () => {
    expect(canManageProperty(teammate, property)).toBe(false);
  });

  it("allows the hotel owner", () => {
    expect(canManageProperty(owner, property)).toBe(true);
  });

  it("allows a partner_admin of that partner", () => {
    expect(canManageProperty(partnerAdmin, property)).toBe(true);
  });

  it("denies a partner_admin of another partner", () => {
    expect(canManageProperty(otherPartnerAdmin, property)).toBe(false);
    expect(canManageProperty(partnerAdmin, otherPartnerHotel)).toBe(false);
  });

  it("denies a partner_admin on an unpartnered hotel they do not own", () => {
    expect(canManageProperty(partnerAdmin, unpartnered)).toBe(false);
  });

  it("allows a superadmin", () => {
    expect(canManageProperty(superadmin, property)).toBe(true);
    expect(canManageProperty(superadmin, undefined)).toBe(true);
  });
});

describe("ownerOnlyValue (live / autoRefund / slug persist)", () => {
  it("ignores a teammate flip of an owner-only flag", () => {
    const canOwn = canOwnProperty(teammate, property);
    expect(canOwn).toBe(false);
    expect(ownerOnlyValue(true, false, canOwn)).toBe(true);
    expect(ownerOnlyValue(false, true, canOwn)).toBe(false);
  });

  it("persists the proposed value for the owner", () => {
    const canOwn = canOwnProperty(owner, property);
    expect(ownerOnlyValue(true, false, canOwn)).toBe(false);
    expect(ownerOnlyValue(false, true, canOwn)).toBe(true);
  });

  it("does not let a partner_admin persist owner-only fields", () => {
    const canOwn = canOwnProperty(partnerAdmin, property);
    expect(canOwn).toBe(false);
    expect(ownerOnlyValue(true, false, canOwn)).toBe(true);
  });
});

describe("partner_admin ops (team / keys / refunds / widget)", () => {
  it("lets a partner_admin of that partner through canManageProperty", () => {
    expect(canManageProperty(partnerAdmin, property)).toBe(true);
    expect(canManageProperty(teammate, property)).toBe(false);
  });
});

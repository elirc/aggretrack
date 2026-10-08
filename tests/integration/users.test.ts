import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

import {
  account,
  auditLog,
  member,
  memberBuyingPointAccess,
  memberWarehouseAccess,
  organisationSettings,
  organization,
  plans,
  subscriptions,
  user,
} from "@/db/schema";
import type { OrgContext } from "@/lib/authz/context";
import { can } from "@/lib/authz/permissions";
import { createMasterData, createTestOrg } from "@/lib/test/factories";
import { makeTestDb, truncateAll } from "@/lib/test/setup";
import {
  addMember,
  changeMemberRole,
  getMemberRestrictions,
  getOrgSettings,
  initialiseOrganisation,
  listMembers,
  removeMember,
  setHidePricesFromWarehouse,
  setMemberRestrictions,
  updateOrgSettings,
} from "@/lib/services/users";
import { addMemberSchema, orgSettingsSchema } from "@/lib/validation/users";

const { db, close } = makeTestDb();

afterAll(async () => {
  await close();
});

beforeEach(async () => {
  await truncateAll(db);
});

function asRole(ctx: OrgContext, role: OrgContext["role"], userId?: string): OrgContext {
  return { ...ctx, role, userId: userId ?? ctx.userId };
}

async function auditRows(orgId: string, tableName: string) {
  return db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.organisationId, orgId), eq(auditLog.tableName, tableName)));
}

describe("users service — members", () => {
  it("adds a phone-only member with a role and audits it", async () => {
    const org = await createTestOrg(db);
    const input = addMemberSchema.parse({
      name: "Aisha Bello",
      phone: "0803 123 4567",
      role: "procurement",
      email: "",
      password: "",
    });
    expect(input.phone).toBe("2348031234567");

    const res = await addMember(db, org.ctx, input);
    expect(res.createdUser).toBe(true);

    const [m] = await db.select().from(member).where(eq(member.id, res.memberId));
    expect(m.role).toBe("procurement");
    expect(m.organizationId).toBe(org.orgId);

    const [u] = await db.select().from(user).where(eq(user.id, res.userId));
    expect(u.phoneNumber).toBe("2348031234567");
    expect(u.phoneNumberVerified).toBe(true);
    expect(u.email).toBe("2348031234567@phone.aggretrack.local");

    const accounts = await db.select().from(account).where(eq(account.userId, res.userId));
    expect(accounts).toHaveLength(0);

    const members = await listMembers(db, org.ctx);
    expect(members).toHaveLength(2);
    const added = members.find((x) => x.memberId === res.memberId)!;
    expect(added.email).toBeNull(); // placeholder hidden
    expect(added.warehouseIds).toBeNull();
    expect(added.buyingPointIds).toBeNull();

    const audits = await auditRows(org.orgId, "member");
    expect(audits).toHaveLength(1);
    expect(audits[0].action).toBe("create");
    expect(audits[0].recordId).toBe(res.memberId);
    expect(audits[0].userId).toBe(org.userId);
    expect((audits[0].after as { role: string }).role).toBe("procurement");
  });

  it("creates a credential account when email + password are given", async () => {
    const org = await createTestOrg(db);
    const res = await addMember(
      db,
      org.ctx,
      addMemberSchema.parse({
        name: "Chidi Okeke",
        phone: "+2348051112222",
        role: "accountant",
        email: "Chidi@Example.com",
        password: "supersecret1",
      }),
    );
    const [u] = await db.select().from(user).where(eq(user.id, res.userId));
    expect(u.email).toBe("chidi@example.com");
    const [acc] = await db.select().from(account).where(eq(account.userId, res.userId));
    expect(acc.providerId).toBe("credential");
    expect(acc.password).toBeTruthy();
    expect(acc.password).not.toBe("supersecret1");
  });

  it("rejects a password without an email at the schema", () => {
    const parsed = addMemberSchema.safeParse({
      name: "No Email",
      phone: "08030000000",
      role: "sales",
      password: "longenough",
    });
    expect(parsed.success).toBe(false);
  });

  it("attaches an existing user instead of duplicating, and refuses double membership", async () => {
    const orgA = await createTestOrg(db);
    const orgB = await createTestOrg(db);
    const input = addMemberSchema.parse({ name: "Shared", phone: "08061234567", role: "sales" });

    const first = await addMember(db, orgA.ctx, input);
    const second = await addMember(db, orgB.ctx, input);
    expect(second.createdUser).toBe(false);
    expect(second.userId).toBe(first.userId);

    await expect(addMember(db, orgA.ctx, input)).rejects.toMatchObject({ code: "ALREADY_MEMBER" });
  });

  it("enforces the plan user limit", async () => {
    const org = await createTestOrg(db);
    await db.update(plans).set({ userLimit: 2 }).where(eq(plans.id, org.planId));
    await addMember(db, org.ctx, addMemberSchema.parse({ name: "Two", phone: "08110000002", role: "sales" }));
    await expect(
      addMember(db, org.ctx, addMemberSchema.parse({ name: "Three", phone: "08110000003", role: "sales" })),
    ).rejects.toMatchObject({ code: "USER_LIMIT_REACHED" });
  });

  it("changes a role and audits before/after", async () => {
    const org = await createTestOrg(db);
    const { memberId } = await addMember(
      db,
      org.ctx,
      addMemberSchema.parse({ name: "Musa", phone: "08070000001", role: "warehouse" }),
    );
    await changeMemberRole(db, org.ctx, { memberId, role: "manager" });

    const [m] = await db.select().from(member).where(eq(member.id, memberId));
    expect(m.role).toBe("manager");

    const updates = (await auditRows(org.orgId, "member")).filter((a) => a.action === "update");
    expect(updates).toHaveLength(1);
    expect(updates[0].before).toEqual({ role: "warehouse" });
    expect(updates[0].after).toEqual({ role: "manager" });
  });

  it("protects owners: non-owner cannot demote/remove/create owners; last owner stays", async () => {
    const org = await createTestOrg(db); // creator is owner
    const mgr = await addMember(
      db,
      org.ctx,
      addMemberSchema.parse({ name: "Manager", phone: "08090000001", role: "manager" }),
    );
    const managerCtx = asRole(org.ctx, "manager", mgr.userId);

    await expect(
      changeMemberRole(db, managerCtx, { memberId: org.memberId, role: "sales" }),
    ).rejects.toMatchObject({ code: "OWNER_ONLY" });
    await expect(removeMember(db, managerCtx, { memberId: org.memberId })).rejects.toMatchObject({
      code: "OWNER_ONLY",
    });
    await expect(
      changeMemberRole(db, managerCtx, { memberId: mgr.memberId, role: "owner" }),
    ).rejects.toMatchObject({ code: "OWNER_ONLY" });
    await expect(
      addMember(db, managerCtx, addMemberSchema.parse({ name: "Xavier", phone: "08090000002", role: "owner" })),
    ).rejects.toMatchObject({ code: "OWNER_ONLY" });

    // Owner cannot demote themselves while they are the only owner.
    await expect(
      changeMemberRole(db, org.ctx, { memberId: org.memberId, role: "manager" }),
    ).rejects.toMatchObject({ code: "LAST_OWNER" });

    // Manager CAN manage non-owner members.
    const clerk = await addMember(
      db,
      managerCtx,
      addMemberSchema.parse({ name: "Clerk", phone: "08090000003", role: "sales" }),
    );
    await removeMember(db, managerCtx, { memberId: clerk.memberId });
    const remaining = await db.select().from(member).where(eq(member.organizationId, org.orgId));
    expect(remaining.map((r) => r.id).sort()).toEqual([org.memberId, mgr.memberId].sort());

    const cancels = (await auditRows(org.orgId, "member")).filter((a) => a.action === "cancel");
    expect(cancels).toHaveLength(1);
    expect(cancels[0].recordId).toBe(clerk.memberId);
  });

  it("cannot remove yourself", async () => {
    const org = await createTestOrg(db);
    await expect(removeMember(db, org.ctx, { memberId: org.memberId })).rejects.toMatchObject({
      code: "CANNOT_REMOVE_SELF",
    });
  });
});

describe("users service — restrictions", () => {
  it("writes access rows and surfaces them as restrictions; empty = unrestricted", async () => {
    const org = await createTestOrg(db);
    const md = await createMasterData(db, org.ctx);
    const { memberId } = await addMember(
      db,
      org.ctx,
      addMemberSchema.parse({ name: "Keeper", phone: "08020000001", role: "warehouse" }),
    );

    expect(await getMemberRestrictions(db, org.ctx, memberId)).toEqual({
      warehouseIds: null,
      buyingPointIds: null,
    });

    const after = await setMemberRestrictions(db, org.ctx, {
      memberId,
      warehouseIds: [md.warehouseId],
      buyingPointIds: [md.buyingPointId],
    });
    expect(after).toEqual({ warehouseIds: [md.warehouseId], buyingPointIds: [md.buyingPointId] });

    const whRows = await db
      .select()
      .from(memberWarehouseAccess)
      .where(eq(memberWarehouseAccess.memberId, memberId));
    expect(whRows).toHaveLength(1);
    expect(whRows[0].organisationId).toBe(org.orgId);
    const bpRows = await db
      .select()
      .from(memberBuyingPointAccess)
      .where(eq(memberBuyingPointAccess.memberId, memberId));
    expect(bpRows).toHaveLength(1);

    expect(await getMemberRestrictions(db, org.ctx, memberId)).toEqual(after);
    const listed = (await listMembers(db, org.ctx)).find((m) => m.memberId === memberId)!;
    expect(listed.warehouseIds).toEqual([md.warehouseId]);
    expect(listed.buyingPointIds).toEqual([md.buyingPointId]);

    // Clearing → unrestricted again.
    const cleared = await setMemberRestrictions(db, org.ctx, {
      memberId,
      warehouseIds: [],
      buyingPointIds: [],
    });
    expect(cleared).toEqual({ warehouseIds: null, buyingPointIds: null });

    const audits = await auditRows(org.orgId, "member_access");
    expect(audits).toHaveLength(2);
    expect(audits[0].before).toEqual({ warehouseIds: null, buyingPointIds: null });
  });

  it("rejects foreign-org warehouses and members", async () => {
    const orgA = await createTestOrg(db);
    const orgB = await createTestOrg(db);
    const mdB = await createMasterData(db, orgB.ctx);
    const { memberId } = await addMember(
      db,
      orgA.ctx,
      addMemberSchema.parse({ name: "Keeper K", phone: "08020000009", role: "warehouse" }),
    );

    await expect(
      setMemberRestrictions(db, orgA.ctx, {
        memberId,
        warehouseIds: [mdB.warehouseId],
        buyingPointIds: [],
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    // orgB cannot touch orgA's member.
    await expect(getMemberRestrictions(db, orgB.ctx, memberId)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      changeMemberRole(db, orgB.ctx, { memberId, role: "sales" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await listMembers(db, orgB.ctx)).map((m) => m.memberId)).not.toContain(memberId);
  });
});

describe("users service — permission checks", () => {
  it("non-managers are denied by the permission matrix and the service", async () => {
    const org = await createTestOrg(db);
    const victim = await addMember(
      db,
      org.ctx,
      addMemberSchema.parse({ name: "Victim", phone: "08040000001", role: "sales" }),
    );
    for (const role of ["procurement", "warehouse", "sales", "accountant"] as const) {
      expect(can(role, "users.manage")).toBe(false);
      const ctx = asRole(org.ctx, role);
      await expect(
        addMember(db, ctx, addMemberSchema.parse({ name: "Newbie", phone: "08040000002", role: "sales" })),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        changeMemberRole(db, ctx, { memberId: victim.memberId, role: "manager" }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(removeMember(db, ctx, { memberId: victim.memberId })).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
      await expect(
        setMemberRestrictions(db, ctx, { memberId: victim.memberId, warehouseIds: [], buyingPointIds: [] }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    expect(can("owner", "users.manage")).toBe(true);
    expect(can("manager", "users.manage")).toBe(true);
    // Nothing changed.
    const [m] = await db.select().from(member).where(eq(member.id, victim.memberId));
    expect(m.role).toBe("sales");
  });

  it("read-only orgs cannot mutate members", async () => {
    const org = await createTestOrg(db);
    await expect(
      addMember(
        db,
        { ...org.ctx, readOnly: true },
        addMemberSchema.parse({ name: "Reader", phone: "08040000005", role: "sales" }),
      ),
    ).rejects.toMatchObject({ code: "READ_ONLY" });
  });
});

describe("organisation settings + initialisation", () => {
  it("updates thresholds, hide-prices switch and name with an audit row", async () => {
    const org = await createTestOrg(db);
    const before = await getOrgSettings(db, org.ctx);
    expect(before.adjustmentApprovalThresholdKg).toBe("50");
    expect(before.hidePricesFromWarehouse).toBe(false);

    const input = orgSettingsSchema.parse({
      name: "Gombe Grains Ltd",
      adjustmentApprovalThresholdKg: "75.5",
      lowStockThresholdKg: "2000",
      oldStockDays: "60",
      capacityAlertPercent: 85,
      invoiceTaxPercent: "7.5",
      hidePricesFromWarehouse: true,
    });
    const after = await updateOrgSettings(db, org.ctx, input);
    expect(after).toMatchObject({
      name: "Gombe Grains Ltd",
      adjustmentApprovalThresholdKg: "75.5",
      lowStockThresholdKg: "2000",
      oldStockDays: 60,
      capacityAlertPercent: 85,
      invoiceTaxPercent: "7.5",
      hidePricesFromWarehouse: true,
    });
    const [o] = await db.select().from(organization).where(eq(organization.id, org.orgId));
    expect(o.name).toBe("Gombe Grains Ltd");
    const [s] = await db
      .select()
      .from(organisationSettings)
      .where(eq(organisationSettings.organisationId, org.orgId));
    expect(s.hidePricesFromWarehouse).toBe(true);
    expect(s.adjustmentApprovalThresholdKg).toBe("75.500");

    const audits = await auditRows(org.orgId, "organisation_settings");
    expect(audits).toHaveLength(1);
    expect((audits[0].before as { name: string }).name).toBe(before.name);

    await expect(
      updateOrgSettings(db, asRole(org.ctx, "sales"), input),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("toggles the hide-prices switch with an audit row; sales cannot", async () => {
    const org = await createTestOrg(db);
    await setHidePricesFromWarehouse(db, org.ctx, true);
    expect((await getOrgSettings(db, org.ctx)).hidePricesFromWarehouse).toBe(true);
    const audits = await auditRows(org.orgId, "organisation_settings");
    expect(audits).toHaveLength(1);
    expect(audits[0].before).toEqual({ hidePricesFromWarehouse: false });
    expect(audits[0].after).toEqual({ hidePricesFromWarehouse: true });
    await expect(
      setHidePricesFromWarehouse(db, asRole(org.ctx, "sales"), false),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("initialises settings + trialing subscription on a fresh org, creating a starter plan", async () => {
    const org = await createTestOrg(db);
    // Simulate a Better-Auth-created org: no settings, no subscription, no plans.
    await db.delete(subscriptions).where(eq(subscriptions.organisationId, org.orgId));
    await db.delete(organisationSettings).where(eq(organisationSettings.organisationId, org.orgId));
    await db.delete(plans);

    const res = await initialiseOrganisation(db, org.ctx);
    expect(res.created).toBe(true);

    const [s] = await db
      .select()
      .from(organisationSettings)
      .where(eq(organisationSettings.organisationId, org.orgId));
    expect(s).toBeDefined();
    const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.organisationId, org.orgId));
    expect(sub.status).toBe("trialing");
    const days = (sub.trialEndsAt.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(13.9);
    expect(days).toBeLessThanOrEqual(14);
    const [plan] = await db.select().from(plans).where(eq(plans.id, sub.planId));
    expect(plan).toMatchObject({ code: "starter", userLimit: 5, monthlyPriceKobo: 2_500_000 });

    const audits = await auditRows(org.orgId, "organization");
    expect(audits).toHaveLength(1);
    expect(audits[0].action).toBe("create");

    // Idempotent.
    const again = await initialiseOrganisation(db, org.ctx);
    expect(again).toEqual({ created: false, subscriptionId: res.subscriptionId });
    expect(await auditRows(org.orgId, "organization")).toHaveLength(1);
  });

  it("uses the cheapest existing active plan", async () => {
    const org = await createTestOrg(db); // its plan costs 5,000,000 kobo
    await db.delete(subscriptions).where(eq(subscriptions.organisationId, org.orgId));
    const [cheap] = await db
      .insert(plans)
      .values({ code: "cheap", name: "Cheap", monthlyPriceKobo: 1_000_000, userLimit: 3 })
      .returning({ id: plans.id });
    await db
      .insert(plans)
      .values({ code: "free-inactive", name: "Old", monthlyPriceKobo: 0, userLimit: 1, active: false });

    await initialiseOrganisation(db, org.ctx);
    const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.organisationId, org.orgId));
    expect(sub.planId).toBe(cheap.id);
  });
});

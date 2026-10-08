"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Loader2, Trash2 } from "lucide-react";
import type { Role } from "@/lib/authz/permissions";
import type { AccessOptions, MemberRow } from "@/lib/services/users";
import { changeMemberRoleAction, removeMemberAction } from "@/actions/users";
import { setHidePricesAction } from "@/actions/org";
import { ROLE_LABELS } from "@/lib/validation/users";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Field, FieldContent, FieldDescription, FieldLabel } from "@/components/ui/field";
import { actionErrorMessage } from "@/components/auth/messages";
import { AddMemberDialog } from "./AddMemberDialog";
import { RestrictionsDialog, RestrictionsSummary } from "./RestrictionsDialog";

/** Members may be serialised from a server component (Date → still Date in RSC). */
type MemberDTO = Omit<MemberRow, "createdAt"> & { createdAt: string | Date };

interface MembersViewProps {
  members: MemberDTO[];
  options: AccessOptions;
  viewerRole: Role;
  viewerUserId: string;
  canManage: boolean;
  canEditOrgSettings: boolean;
  hidePricesFromWarehouse: boolean;
  allRoles: Role[];
}

function phoneLabel(p: string | null): string {
  if (!p) return "—";
  return p.startsWith("234") ? `+${p}` : p;
}

export function MembersView(props: MembersViewProps) {
  const { members, options, viewerRole, viewerUserId, canManage, allRoles } = props;
  const isOwner = viewerRole === "owner";
  const assignableRoles = isOwner ? allRoles : allRoles.filter((r) => r !== "owner");

  const editable = (m: MemberDTO) => canManage && (isOwner || m.role !== "owner");

  return (
    <div className="space-y-4">
      <HidePricesCard
        initial={props.hidePricesFromWarehouse}
        canEdit={props.canEditOrgSettings}
      />

      <div className="flex items-center justify-between gap-2">
        <h2 className="text-base font-semibold">
          Members <span className="text-muted-foreground">({members.length})</span>
        </h2>
        {canManage ? <AddMemberDialog assignableRoles={assignableRoles} /> : null}
      </div>

      {members.length === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          No members yet.
        </p>
      ) : (
        <>
          {/* Mobile cards */}
          <ul className="space-y-3 md:hidden">
            {members.map((m) => (
              <li key={m.memberId}>
                <Card>
                  <CardContent className="space-y-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate font-medium">
                          {m.name}
                          {m.userId === viewerUserId ? (
                            <span className="text-muted-foreground"> (you)</span>
                          ) : null}
                        </p>
                        <p className="text-sm text-muted-foreground">{phoneLabel(m.phoneNumber)}</p>
                        {m.email ? (
                          <p className="truncate text-sm text-muted-foreground">{m.email}</p>
                        ) : null}
                      </div>
                      {!editable(m) ? <Badge variant="secondary">{ROLE_LABELS[m.role]}</Badge> : null}
                    </div>
                    <RestrictionsSummary
                      warehouseIds={m.warehouseIds}
                      buyingPointIds={m.buyingPointIds}
                      options={options}
                    />
                    {editable(m) ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <RoleSelect member={m} roles={assignableRoles} />
                        <RestrictionsDialog
                          memberId={m.memberId}
                          memberName={m.name}
                          warehouseIds={m.warehouseIds}
                          buyingPointIds={m.buyingPointIds}
                          options={options}
                        />
                        {m.userId !== viewerUserId ? <RemoveButton member={m} /> : null}
                      </div>
                    ) : null}
                  </CardContent>
                </Card>
              </li>
            ))}
          </ul>

          {/* Desktop table */}
          <div className="hidden rounded-lg border md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Phone</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Access</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {members.map((m) => (
                  <TableRow key={m.memberId}>
                    <TableCell className="font-medium">
                      {m.name}
                      {m.userId === viewerUserId ? (
                        <span className="text-muted-foreground"> (you)</span>
                      ) : null}
                    </TableCell>
                    <TableCell>{phoneLabel(m.phoneNumber)}</TableCell>
                    <TableCell className="max-w-48 truncate">{m.email ?? "—"}</TableCell>
                    <TableCell>
                      {editable(m) ? (
                        <RoleSelect member={m} roles={assignableRoles} />
                      ) : (
                        <Badge variant="secondary">{ROLE_LABELS[m.role]}</Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <RestrictionsSummary
                        warehouseIds={m.warehouseIds}
                        buyingPointIds={m.buyingPointIds}
                        options={options}
                      />
                    </TableCell>
                    <TableCell>
                      {editable(m) ? (
                        <div className="flex justify-end gap-2">
                          <RestrictionsDialog
                            memberId={m.memberId}
                            memberName={m.name}
                            warehouseIds={m.warehouseIds}
                            buyingPointIds={m.buyingPointIds}
                            options={options}
                          />
                          {m.userId !== viewerUserId ? <RemoveButton member={m} /> : null}
                        </div>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}
    </div>
  );
}

function RoleSelect({ member, roles }: { member: MemberDTO; roles: Role[] }) {
  const [pending, startTransition] = useTransition();
  const [value, setValue] = useState<Role>(member.role);
  // Show the member's current role even if the viewer may not assign it.
  const shown = roles.includes(member.role) ? roles : [member.role, ...roles];

  function onChange(next: string) {
    const role = next as Role;
    const prev = value;
    setValue(role);
    startTransition(async () => {
      const res = await changeMemberRoleAction({ memberId: member.memberId, role });
      if (!res.ok) {
        setValue(prev);
        toast.error(actionErrorMessage(res.error));
        return;
      }
      toast.success(`${member.name} is now ${ROLE_LABELS[role]}`);
    });
  }

  return (
    <Select value={value} onValueChange={onChange} disabled={pending}>
      <SelectTrigger className="h-9 w-44" aria-label={`Role for ${member.name}`}>
        {pending ? <Loader2 className="size-4 animate-spin" /> : null}
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {shown.map((r) => (
          <SelectItem key={r} value={r}>
            {ROLE_LABELS[r]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function RemoveButton({ member }: { member: MemberDTO }) {
  const [pending, startTransition] = useTransition();

  function remove() {
    startTransition(async () => {
      const res = await removeMemberAction({ memberId: member.memberId });
      if (!res.ok) {
        toast.error(actionErrorMessage(res.error));
        return;
      }
      toast.success(`${member.name} removed`);
    });
  }

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="ghost" size="sm" disabled={pending} aria-label={`Remove ${member.name}`}>
          {pending ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove {member.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            They will lose access to this organisation. Their past records stay.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={remove}>Remove</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function HidePricesCard({ initial, canEdit }: { initial: boolean; canEdit: boolean }) {
  const [checked, setChecked] = useState(initial);
  const [pending, startTransition] = useTransition();

  function onChange(next: boolean) {
    setChecked(next);
    startTransition(async () => {
      const res = await setHidePricesAction({ hide: next });
      if (!res.ok) {
        setChecked(!next);
        toast.error(actionErrorMessage(res.error));
        return;
      }
      toast.success(next ? "Prices hidden from warehouse keepers" : "Prices visible to warehouse keepers");
    });
  }

  return (
    <Card>
      <CardContent>
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="hide-prices">Hide prices from warehouse keepers</FieldLabel>
            <FieldDescription>
              Costs, prices and stock values are stripped for the warehouse role.
            </FieldDescription>
          </FieldContent>
          <Switch
            id="hide-prices"
            checked={checked}
            onCheckedChange={onChange}
            disabled={!canEdit || pending}
          />
        </Field>
      </CardContent>
    </Card>
  );
}

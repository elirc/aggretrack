"use client";

import { useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import type { ColumnDef } from "@tanstack/react-table";
import { Boxes, X } from "lucide-react";

import {
  createBagTypeAction,
  createBinAction,
  createBuyingPointAction,
  createCommodityAction,
  createDriverAction,
  createExpenseCategoryAction,
  createGradeAction,
  createVehicleAction,
  createWarehouseAction,
  removeBagTypeAction,
  removeBinAction,
  removeDriverAction,
  removeExpenseCategoryAction,
  removeGradeAction,
  removeVehicleAction,
  setBuyingPointActiveAction,
  setCommodityActiveAction,
  setWarehouseActiveAction,
  updateBagTypeAction,
  updateBuyingPointAction,
  updateCommodityAction,
  updateDriverAction,
  updateExpenseCategoryAction,
  updateGradeAction,
  updateVehicleAction,
  updateWarehouseAction,
} from "@/actions/master-data";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type {
  BagType,
  BuyingPoint,
  Commodity,
  Driver,
  ExpenseCategory,
  GradeWithCommodity,
  Vehicle,
  WarehouseWithBins,
} from "@/lib/services/masterData";
import {
  bagTypeInput,
  bagTypeUpdateInput,
  binInput,
  buyingPointInput,
  buyingPointUpdateInput,
  commodityInput,
  commodityUpdateInput,
  driverInput,
  driverUpdateInput,
  expenseCategoryInput,
  expenseCategoryUpdateInput,
  gradeInput,
  gradeUpdateInput,
  vehicleInput,
  vehicleUpdateInput,
  warehouseInput,
  warehouseUpdateInput,
} from "@/lib/validation/masterData";

import * as cfg from "./entity-config";
import { ActiveToggle, EntitySection, RemoveButton } from "./entity-section";
import { EntityForm, formatKg, kgForInput, runAction } from "./form-kit";

export const MASTER_DATA_TABS = [
  { value: "commodities", label: "Commodities" },
  { value: "grades", label: "Grades" },
  { value: "bag-types", label: "Bag types" },
  { value: "warehouses", label: "Warehouses" },
  { value: "buying-points", label: "Buying points" },
  { value: "vehicles", label: "Vehicles" },
  { value: "drivers", label: "Drivers" },
  { value: "expense-categories", label: "Expense categories" },
] as const;
export type MasterDataTab = (typeof MASTER_DATA_TABS)[number]["value"];

export type MasterDataProps = {
  commodities: Commodity[];
  grades: GradeWithCommodity[];
  bagTypes: BagType[];
  warehouses: WarehouseWithBins[];
  buyingPoints: BuyingPoint[];
  vehicles: Vehicle[];
  drivers: Driver[];
  expenseCategories: ExpenseCategory[];
  canWrite: boolean;
  initialTab: MasterDataTab;
};

const dash = (v: string | null | undefined) => (v ? v : "—");

export function MasterDataTabs(props: MasterDataProps) {
  const router = useRouter();
  const pathname = usePathname();
  const [tab, setTab] = useState<string>(props.initialTab);
  const { canWrite } = props;

  const onTab = (v: string) => {
    setTab(v);
    router.replace(`${pathname}?tab=${v}`, { scroll: false });
  };

  // ── columns ──
  const commodityCols: ColumnDef<Commodity, unknown>[] = [
    { accessorKey: "name", header: "Name" },
    { accessorKey: "code", header: "Code" },
    {
      id: "active",
      header: "Status",
      cell: ({ row }) => (
        <ActiveToggle
          id={row.original.id}
          checked={row.original.active}
          disabled={!canWrite}
          action={setCommodityActiveAction}
          label={row.original.name}
        />
      ),
    },
  ];
  const gradeCols: ColumnDef<GradeWithCommodity, unknown>[] = [
    { accessorKey: "commodityName", header: "Commodity" },
    { accessorKey: "name", header: "Grade" },
    { id: "code", header: "Code", cell: ({ row }) => dash(row.original.code) },
  ];
  const bagTypeCols: ColumnDef<BagType, unknown>[] = [
    { accessorKey: "name", header: "Name" },
    { id: "std", header: "Standard", cell: ({ row }) => formatKg(row.original.standardKg) },
    { id: "sack", header: "Sack weight", cell: ({ row }) => formatKg(row.original.sackWeightKg) },
  ];
  const warehouseCols: ColumnDef<WarehouseWithBins, unknown>[] = [
    { accessorKey: "name", header: "Name" },
    { id: "location", header: "Location", cell: ({ row }) => dash(row.original.location) },
    { id: "capacity", header: "Capacity", cell: ({ row }) => formatKg(row.original.capacityKg) },
    { id: "bins", header: "Bins", cell: ({ row }) => <BinChips bins={row.original.bins} /> },
    {
      id: "active",
      header: "Status",
      cell: ({ row }) => (
        <ActiveToggle
          id={row.original.id}
          checked={row.original.active}
          disabled={!canWrite}
          action={setWarehouseActiveAction}
          label={row.original.name}
        />
      ),
    },
  ];
  const buyingPointCols: ColumnDef<BuyingPoint, unknown>[] = [
    { accessorKey: "name", header: "Name" },
    { id: "lga", header: "LGA", cell: ({ row }) => dash(row.original.lga) },
    { id: "state", header: "State", cell: ({ row }) => dash(row.original.state) },
    {
      id: "active",
      header: "Status",
      cell: ({ row }) => (
        <ActiveToggle
          id={row.original.id}
          checked={row.original.active}
          disabled={!canWrite}
          action={setBuyingPointActiveAction}
          label={row.original.name}
        />
      ),
    },
  ];
  const vehicleCols: ColumnDef<Vehicle, unknown>[] = [
    { accessorKey: "plateNumber", header: "Plate" },
    { id: "description", header: "Description", cell: ({ row }) => dash(row.original.description) },
    { id: "capacity", header: "Capacity", cell: ({ row }) => formatKg(row.original.capacityKg) },
  ];
  const driverCols: ColumnDef<Driver, unknown>[] = [
    { accessorKey: "name", header: "Name" },
    { id: "phone", header: "Phone", cell: ({ row }) => dash(row.original.phone) },
    { id: "licence", header: "Licence", cell: ({ row }) => dash(row.original.licenceNote) },
  ];
  const expenseCols: ColumnDef<ExpenseCategory, unknown>[] = [
    { accessorKey: "name", header: "Name" },
    {
      id: "landed",
      header: "Landed cost",
      cell: ({ row }) =>
        row.original.affectsLandedCost ? <Badge>Adds to landed cost</Badge> : <span className="text-muted-foreground">No</span>,
    },
  ];

  return (
    <Tabs value={tab} onValueChange={onTab} className="gap-4">
      <div className="-mx-4 overflow-x-auto px-4 pb-1">
        <TabsList className="h-9 w-max">
          {MASTER_DATA_TABS.map((t) => (
            <TabsTrigger key={t.value} value={t.value} className="px-3">
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>

      <TabsContent value="commodities">
        <EntitySection<Commodity>
          noun="commodity"
          description="Crops you buy and sell."
          rows={props.commodities}
          columns={commodityCols}
          card={(r) => (
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2 font-medium">
                {r.name} <Badge variant="outline">{r.code}</Badge>
              </div>
              <ActiveToggle id={r.id} checked={r.active} disabled={!canWrite} action={setCommodityActiveAction} label={r.name} />
            </div>
          )}
          rowLabel={(r) => r.name}
          fields={cfg.commodityFields}
          createSchema={commodityInput}
          updateSchema={commodityUpdateInput}
          createAction={createCommodityAction}
          updateAction={updateCommodityAction}
          emptyDefaults={cfg.commodityDefaults}
          toValues={(r) => ({ name: r.name, code: r.code, active: r.active })}
          canWrite={canWrite}
        />
      </TabsContent>

      <TabsContent value="grades">
        <EntitySection<GradeWithCommodity>
          noun="grade"
          description="Quality grades per commodity."
          rows={props.grades}
          columns={gradeCols}
          card={(r) => (
            <div className="flex flex-col">
              <span className="font-medium">
                {r.name} {r.code ? <span className="text-muted-foreground">({r.code})</span> : null}
              </span>
              <span className="text-sm text-muted-foreground">{r.commodityName}</span>
            </div>
          )}
          rowLabel={(r) => `${r.commodityName} ${r.name}`}
          fields={cfg.gradeFields(props.commodities)}
          createSchema={gradeInput}
          updateSchema={gradeUpdateInput}
          createAction={createGradeAction}
          updateAction={updateGradeAction}
          emptyDefaults={cfg.gradeDefaults(props.commodities[0]?.id ?? "")}
          toValues={(r) => ({ commodityId: r.commodityId, name: r.name, code: r.code ?? "" })}
          rowActions={(r) => <RemoveButton id={r.id} label={r.name} action={removeGradeAction} />}
          canWrite={canWrite}
          blockedReason={props.commodities.length === 0 ? "Add a commodity first, then its grades." : undefined}
        />
      </TabsContent>

      <TabsContent value="bag-types">
        <EntitySection<BagType>
          noun="bag type"
          description="Standard bag weights and empty-sack weight."
          rows={props.bagTypes}
          columns={bagTypeCols}
          card={(r) => (
            <div className="flex flex-col">
              <span className="font-medium">{r.name}</span>
              <span className="text-sm text-muted-foreground">
                {formatKg(r.standardKg)} · sack {formatKg(r.sackWeightKg)}
              </span>
            </div>
          )}
          rowLabel={(r) => r.name}
          fields={cfg.bagTypeFields}
          createSchema={bagTypeInput}
          updateSchema={bagTypeUpdateInput}
          createAction={createBagTypeAction}
          updateAction={updateBagTypeAction}
          emptyDefaults={cfg.bagTypeDefaults}
          toValues={(r) => ({
            name: r.name,
            standardKg: kgForInput(r.standardKg),
            sackWeightKg: kgForInput(r.sackWeightKg),
          })}
          rowActions={(r) => <RemoveButton id={r.id} label={r.name} action={removeBagTypeAction} />}
          canWrite={canWrite}
        />
      </TabsContent>

      <TabsContent value="warehouses">
        <EntitySection<WarehouseWithBins>
          noun="warehouse"
          description="Stores, their capacity and bins."
          rows={props.warehouses}
          columns={warehouseCols}
          card={(r) => (
            <div className="flex flex-col gap-1">
              <span className="font-medium">{r.name}</span>
              <span className="text-sm text-muted-foreground">
                {dash(r.location)} · {formatKg(r.capacityKg)}
              </span>
              <BinChips bins={r.bins} />
              <ActiveToggle id={r.id} checked={r.active} disabled={!canWrite} action={setWarehouseActiveAction} label={r.name} />
            </div>
          )}
          rowLabel={(r) => r.name}
          fields={cfg.warehouseFields}
          createSchema={warehouseInput}
          updateSchema={warehouseUpdateInput}
          createAction={createWarehouseAction}
          updateAction={updateWarehouseAction}
          emptyDefaults={cfg.warehouseDefaults}
          toValues={(r) => ({
            name: r.name,
            location: r.location ?? "",
            capacityKg: kgForInput(r.capacityKg),
            active: r.active,
          })}
          rowActions={(r) => <BinsButton warehouse={r} />}
          canWrite={canWrite}
        />
      </TabsContent>

      <TabsContent value="buying-points">
        <EntitySection<BuyingPoint>
          noun="buying point"
          description="Markets and collection points where you buy."
          rows={props.buyingPoints}
          columns={buyingPointCols}
          card={(r) => (
            <div className="flex flex-col gap-1">
              <span className="font-medium">{r.name}</span>
              <span className="text-sm text-muted-foreground">
                {[r.lga, r.state].filter(Boolean).join(", ") || "—"}
              </span>
              <ActiveToggle id={r.id} checked={r.active} disabled={!canWrite} action={setBuyingPointActiveAction} label={r.name} />
            </div>
          )}
          rowLabel={(r) => r.name}
          fields={cfg.buyingPointFields}
          createSchema={buyingPointInput}
          updateSchema={buyingPointUpdateInput}
          createAction={createBuyingPointAction}
          updateAction={updateBuyingPointAction}
          emptyDefaults={cfg.buyingPointDefaults}
          toValues={(r) => ({ name: r.name, lga: r.lga ?? "", state: r.state ?? "", active: r.active })}
          canWrite={canWrite}
        />
      </TabsContent>

      <TabsContent value="vehicles">
        <EntitySection<Vehicle>
          noun="vehicle"
          rows={props.vehicles}
          columns={vehicleCols}
          card={(r) => (
            <div className="flex flex-col">
              <span className="font-medium">{r.plateNumber}</span>
              <span className="text-sm text-muted-foreground">
                {dash(r.description)} · {formatKg(r.capacityKg)}
              </span>
            </div>
          )}
          rowLabel={(r) => r.plateNumber}
          fields={cfg.vehicleFields}
          createSchema={vehicleInput}
          updateSchema={vehicleUpdateInput}
          createAction={createVehicleAction}
          updateAction={updateVehicleAction}
          emptyDefaults={cfg.vehicleDefaults}
          toValues={(r) => ({
            plateNumber: r.plateNumber,
            description: r.description ?? "",
            capacityKg: kgForInput(r.capacityKg),
          })}
          rowActions={(r) => <RemoveButton id={r.id} label={r.plateNumber} action={removeVehicleAction} />}
          canWrite={canWrite}
        />
      </TabsContent>

      <TabsContent value="drivers">
        <EntitySection<Driver>
          noun="driver"
          rows={props.drivers}
          columns={driverCols}
          card={(r) => (
            <div className="flex flex-col">
              <span className="font-medium">{r.name}</span>
              <span className="text-sm text-muted-foreground">
                {dash(r.phone)}
                {r.licenceNote ? ` · ${r.licenceNote}` : ""}
              </span>
            </div>
          )}
          rowLabel={(r) => r.name}
          fields={cfg.driverFields}
          createSchema={driverInput}
          updateSchema={driverUpdateInput}
          createAction={createDriverAction}
          updateAction={updateDriverAction}
          emptyDefaults={cfg.driverDefaults}
          toValues={(r) => ({ name: r.name, phone: r.phone ?? "", licenceNote: r.licenceNote ?? "" })}
          rowActions={(r) => <RemoveButton id={r.id} label={r.name} action={removeDriverAction} />}
          canWrite={canWrite}
        />
      </TabsContent>

      <TabsContent value="expense-categories">
        <EntitySection<ExpenseCategory>
          noun="expense category"
          description="Storage, fumigation, loading, bagging…"
          rows={props.expenseCategories}
          columns={expenseCols}
          card={(r) => (
            <div className="flex flex-col gap-1">
              <span className="font-medium">{r.name}</span>
              {r.affectsLandedCost ? (
                <Badge className="w-fit">Adds to landed cost</Badge>
              ) : (
                <span className="text-sm text-muted-foreground">Not in landed cost</span>
              )}
            </div>
          )}
          rowLabel={(r) => r.name}
          fields={cfg.expenseCategoryFields}
          createSchema={expenseCategoryInput}
          updateSchema={expenseCategoryUpdateInput}
          createAction={createExpenseCategoryAction}
          updateAction={updateExpenseCategoryAction}
          emptyDefaults={cfg.expenseCategoryDefaults}
          toValues={(r) => ({ name: r.name, affectsLandedCost: r.affectsLandedCost })}
          rowActions={(r) => <RemoveButton id={r.id} label={r.name} action={removeExpenseCategoryAction} />}
          canWrite={canWrite}
        />
      </TabsContent>
    </Tabs>
  );
}

function BinChips({ bins }: { bins: { id: string; name: string }[] }) {
  if (bins.length === 0) return <span className="text-sm text-muted-foreground">No bins</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {bins.map((b) => (
        <Badge key={b.id} variant="outline">
          {b.name}
        </Badge>
      ))}
    </div>
  );
}

function BinsButton({ warehouse }: { warehouse: WarehouseWithBins }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="ghost" size="icon" aria-label={`Bins in ${warehouse.name}`} onClick={() => setOpen(true)}>
        <Boxes />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Bins — {warehouse.name}</DialogTitle>
            <DialogDescription>Optional storage locations inside the warehouse.</DialogDescription>
          </DialogHeader>
          {warehouse.bins.length === 0 ? (
            <p className="text-sm text-muted-foreground">No bins yet — add the first one below.</p>
          ) : (
            <ul className="flex flex-wrap gap-2">
              {warehouse.bins.map((b) => (
                <li key={b.id}>
                  <Badge variant="outline" className="gap-1 pr-0.5">
                    {b.name}
                    <button
                      type="button"
                      className="rounded p-1 hover:bg-muted"
                      aria-label={`Remove bin ${b.name}`}
                      onClick={async () => {
                        const ok = await runAction(removeBinAction, { id: b.id }, `Bin ${b.name} removed`);
                        if (ok) router.refresh();
                      }}
                    >
                      <X className="size-3" />
                    </button>
                  </Badge>
                </li>
              ))}
            </ul>
          )}
          <EntityForm
            fields={cfg.binFields}
            schema={binInput}
            defaultValues={{ warehouseId: warehouse.id, name: "" }}
            action={createBinAction}
            successMessage="Bin added"
            submitLabel="Add bin"
            resetOnSuccess
            onSuccess={() => router.refresh()}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}

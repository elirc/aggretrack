import type { FieldSpec, FormValues } from "./form-kit";

/** Field specs + blank defaults per master-data entity (shared with onboarding). */

export const commodityFields: FieldSpec[] = [
  { name: "name", label: "Name", kind: "text", placeholder: "e.g. Maize" },
  { name: "code", label: "Code", kind: "text", placeholder: "e.g. MZ", description: "Short code used on documents." },
  { name: "active", label: "Active", kind: "switch" },
];
export const commodityDefaults: FormValues = { name: "", code: "", active: true };

export function gradeFields(commodities: { id: string; name: string }[]): FieldSpec[] {
  return [
    {
      name: "commodityId",
      label: "Commodity",
      kind: "select",
      options: commodities.map((c) => ({ value: c.id, label: c.name })),
      placeholder: "Choose commodity",
    },
    { name: "name", label: "Grade name", kind: "text", placeholder: "e.g. Grade A" },
    { name: "code", label: "Code (optional)", kind: "text", placeholder: "e.g. A" },
  ];
}
export function gradeDefaults(commodityId = ""): FormValues {
  return { commodityId, name: "", code: "" };
}

export const bagTypeFields: FieldSpec[] = [
  { name: "name", label: "Name", kind: "text", placeholder: "e.g. 100 kg poly bag" },
  { name: "standardKg", label: "Standard weight (kg)", kind: "kg", placeholder: "100" },
  {
    name: "sackWeightKg",
    label: "Empty sack weight (kg)",
    kind: "kg",
    placeholder: "0",
    description: "Deducted per bag as sack weight.",
  },
];
export const bagTypeDefaults: FormValues = { name: "", standardKg: "", sackWeightKg: "" };

export const warehouseFields: FieldSpec[] = [
  { name: "name", label: "Name", kind: "text", placeholder: "e.g. Gombe Main Store" },
  { name: "location", label: "Location", kind: "text", placeholder: "Town / address" },
  {
    name: "capacityKg",
    label: "Capacity (kg)",
    kind: "kg",
    placeholder: "500000",
    description: "Used for the near-capacity alert.",
  },
  { name: "active", label: "Active", kind: "switch" },
];
export const warehouseDefaults: FormValues = { name: "", location: "", capacityKg: "", active: true };

export const binFields: FieldSpec[] = [{ name: "name", label: "Bin name", kind: "text", placeholder: "e.g. A1" }];

export const buyingPointFields: FieldSpec[] = [
  { name: "name", label: "Name", kind: "text", placeholder: "e.g. Kumo Market" },
  { name: "lga", label: "LGA", kind: "text", placeholder: "Local government area" },
  { name: "state", label: "State", kind: "text", placeholder: "e.g. Gombe" },
  { name: "active", label: "Active", kind: "switch" },
];
export const buyingPointDefaults: FormValues = { name: "", lga: "", state: "", active: true };

export const vehicleFields: FieldSpec[] = [
  { name: "plateNumber", label: "Plate number", kind: "text", placeholder: "e.g. GME 123 AA" },
  { name: "description", label: "Description", kind: "text", placeholder: "e.g. 30 t trailer" },
  { name: "capacityKg", label: "Capacity (kg)", kind: "kg", placeholder: "30000" },
];
export const vehicleDefaults: FormValues = { plateNumber: "", description: "", capacityKg: "" };

export const driverFields: FieldSpec[] = [
  { name: "name", label: "Name", kind: "text", placeholder: "Driver's name" },
  { name: "phone", label: "Phone", kind: "text", inputMode: "tel", placeholder: "0803 000 0000" },
  { name: "licenceNote", label: "Licence note", kind: "text", placeholder: "Licence no. / expiry" },
];
export const driverDefaults: FormValues = { name: "", phone: "", licenceNote: "" };

export const expenseCategoryFields: FieldSpec[] = [
  { name: "name", label: "Name", kind: "text", placeholder: "e.g. Loading & handling" },
  {
    name: "affectsLandedCost",
    label: "Adds to landed cost",
    kind: "switch",
    description: "Share this cost into lot landed cost when attached to an inbound trip or lot.",
  },
];
export const expenseCategoryDefaults: FormValues = { name: "", affectsLandedCost: false };

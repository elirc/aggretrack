// Shared by the server page and the client tabs. Keep this module free of
// "use client": importing a constant from a client module into a server
// component yields a client-reference proxy in production builds.
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

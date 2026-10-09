/**
 * Static demo data for the Gombe AgriTrade seed. All names are fictional.
 * Money in kobo, weights in kg.
 */

export const DEMO_PASSWORD = "demo1234";
export const DEMO_ORG = { name: "Gombe AgriTrade", slug: "gombe-agritrade" } as const;

export const PLATFORM_ADMIN = {
  name: "Platform Admin",
  phone: "2348000000007",
  email: "platform@demo.aggretrack.local",
} as const;

export type SeedRole = "owner" | "manager" | "procurement" | "warehouse" | "sales" | "accountant";

export const ROLE_USERS: ReadonlyArray<{ role: SeedRole; name: string; phone: string; email: string }> = [
  { role: "owner", name: "Adamu Bello", phone: "2348000000001", email: "owner@demo.aggretrack.local" },
  { role: "manager", name: "Ngozi Okafor", phone: "2348000000002", email: "manager@demo.aggretrack.local" },
  { role: "procurement", name: "Musa Ibrahim", phone: "2348000000003", email: "procurement@demo.aggretrack.local" },
  { role: "warehouse", name: "Chidi Eze", phone: "2348000000004", email: "warehouse@demo.aggretrack.local" },
  { role: "sales", name: "Aisha Mohammed", phone: "2348000000005", email: "sales@demo.aggretrack.local" },
  { role: "accountant", name: "Tunde Adeyemi", phone: "2348000000006", email: "accountant@demo.aggretrack.local" },
];

export const PLANS = [
  { code: "starter", name: "Starter", monthlyPriceKobo: 2_500_000, userLimit: 5 },
  { code: "growth", name: "Growth", monthlyPriceKobo: 6_000_000, userLimit: 15 },
] as const;

export type CommodityCode = "MZ" | "SB" | "RP" | "SG" | "SS" | "GN" | "CW";

export type CommoditySpec = {
  code: CommodityCode;
  name: string;
  /** which bag type the produce is bought in */
  bag: "100" | "50";
  /** Grade A farm-gate buying price, ₦/kg in kobo, at the window start */
  baseBuyKobo: number;
  /** price guides are published for this commodity */
  guided: boolean;
};

export const COMMODITIES: readonly CommoditySpec[] = [
  { code: "MZ", name: "Maize", bag: "100", baseBuyKobo: 48_000, guided: true },
  { code: "SB", name: "Soybean", bag: "100", baseBuyKobo: 72_000, guided: true },
  { code: "RP", name: "Rice Paddy", bag: "100", baseBuyKobo: 56_000, guided: false },
  { code: "SG", name: "Sorghum", bag: "100", baseBuyKobo: 43_000, guided: false },
  { code: "SS", name: "Sesame", bag: "50", baseBuyKobo: 155_000, guided: true },
  { code: "GN", name: "Ginger", bag: "50", baseBuyKobo: 125_000, guided: false },
  { code: "CW", name: "Cashew", bag: "50", baseBuyKobo: 115_000, guided: false },
];

export const GRADES = [
  { key: "A", name: "Grade A", factor: 1 },
  { key: "B", name: "Grade B", factor: 0.92 },
] as const;
export type GradeKey = (typeof GRADES)[number]["key"];

export const BAG_TYPES = [
  { key: "100", name: "100kg sack", standardKg: "100", sackWeightKg: "1.2" },
  { key: "50", name: "50kg sack", standardKg: "50", sackWeightKg: "0.8" },
] as const;

export const WAREHOUSES = [
  { key: "main", name: "Gombe Main", location: "Bauchi Road, Gombe", capacityKg: "500000", bins: ["A1", "A2", "B1"] },
  { key: "billiri", name: "Billiri Depot", location: "Tal Road, Billiri", capacityKg: "200000", bins: ["C1", "C2"] },
] as const;

export const BUYING_POINTS = [
  { key: "kwadon", name: "Kwadon", lga: "Yamaltu/Deba", state: "Gombe", priceFactor: 1.0 },
  { key: "billiri", name: "Billiri", lga: "Billiri", state: "Gombe", priceFactor: 0.98 },
  { key: "kaltungo", name: "Kaltungo", lga: "Kaltungo", state: "Gombe", priceFactor: 1.01 },
] as const;
export type BuyingPointKey = (typeof BUYING_POINTS)[number]["key"];

/** Commodity mix per buying point (relative weights). */
export const BP_COMMODITY_WEIGHTS: Record<BuyingPointKey, Record<CommodityCode, number>> = {
  kwadon: { MZ: 40, SB: 20, SG: 15, RP: 15, SS: 5, GN: 3, CW: 2 },
  billiri: { MZ: 25, SB: 25, SS: 20, SG: 10, GN: 10, RP: 5, CW: 5 },
  kaltungo: { MZ: 25, SS: 25, SB: 15, GN: 15, CW: 10, SG: 5, RP: 5 },
};

export const VEHICLES = [
  { plateNumber: "GME 214 XA", description: "Mercedes 10-tonne truck", capacityKg: "10000" },
  { plateNumber: "GME 588 KL", description: "DAF 20-tonne trailer", capacityKg: "20000" },
  { plateNumber: "KLT 103 BL", description: "Toyota Dyna 5-tonne", capacityKg: "5000" },
] as const;

export const DRIVERS = [
  { name: "Yusuf Abdullahi", phone: "2348031234501", licenceNote: "Class E, exp. 2028" },
  { name: "Emeka Nwosu", phone: "2348061234502", licenceNote: "Class E, exp. 2027" },
  { name: "Ibrahim Danladi", phone: "2348091234503", licenceNote: "Class C, exp. 2029" },
] as const;

export const EXPENSE_CATEGORIES = [
  { key: "transport", name: "Transport Handling", affectsLandedCost: true },
  { key: "loading", name: "Loading", affectsLandedCost: true },
  { key: "storage", name: "Storage", affectsLandedCost: false },
  { key: "fumigation", name: "Fumigation", affectsLandedCost: false },
  { key: "bagging", name: "Bagging", affectsLandedCost: false },
] as const;
export type ExpenseKey = (typeof EXPENSE_CATEGORIES)[number]["key"];

/** Villages by LGA and the buying point they sell into. */
export const VILLAGES: ReadonlyArray<{ village: string; lga: string; bp: BuyingPointKey }> = [
  { village: "Kwadon", lga: "Yamaltu/Deba", bp: "kwadon" },
  { village: "Deba", lga: "Yamaltu/Deba", bp: "kwadon" },
  { village: "Hinna", lga: "Yamaltu/Deba", bp: "kwadon" },
  { village: "Kurjale", lga: "Yamaltu/Deba", bp: "kwadon" },
  { village: "Kumo", lga: "Akko", bp: "kwadon" },
  { village: "Tumu", lga: "Akko", bp: "kwadon" },
  { village: "Billiri", lga: "Billiri", bp: "billiri" },
  { village: "Tal", lga: "Billiri", bp: "billiri" },
  { village: "Kalmai", lga: "Billiri", bp: "billiri" },
  { village: "Tanglang", lga: "Billiri", bp: "billiri" },
  { village: "Kaltungo", lga: "Kaltungo", bp: "kaltungo" },
  { village: "Tula", lga: "Kaltungo", bp: "kaltungo" },
  { village: "Awak", lga: "Kaltungo", bp: "kaltungo" },
  { village: "Ture", lga: "Kaltungo", bp: "kaltungo" },
  { village: "Bambam", lga: "Balanga", bp: "billiri" },
  { village: "Dadiya", lga: "Balanga", bp: "kaltungo" },
];

export const FIRST_NAMES = [
  "Abubakar", "Hauwa", "Usman", "Zainab", "Ibrahim", "Maryam", "Danjuma", "Rifkatu", "Bitrus", "Lami",
  "Garba", "Hadiza", "Sule", "Asabe", "Yakubu", "Esther", "Haruna", "Saratu", "Ishaya", "Talatu",
  "Babangida", "Comfort", "Jibrin", "Ladi", "Markus", "Rakiya", "Audu", "Naomi", "Lawal", "Fatima",
] as const;

export const LAST_NAMES = [
  "Musa", "Saleh", "Bala", "Abdullahi", "Yahaya", "Dauda", "Lamido", "Bature", "Tanko", "Waziri",
  "Gambo", "Kwaya", "Danladi", "Shehu", "Bulus", "Ayuba", "Mohammed", "Idris", "Galadima", "Kwande",
] as const;

export const AGENT_NAMES = [
  "Alhaji Sani Bello", "Alhaji Umar Kumo", "Mallam Bashir Tula", "Hajiya Amina Deba", "Alhaji Garba Kaltungo",
  "Mallam Idi Tal", "Alhaji Shuaibu Hinna", "Mallam Dogo Awak", "Hajiya Binta Billiri",
] as const;

export const COOPERATIVES: ReadonlyArray<{ name: string; village: string }> = [
  { name: "Kwadon Maize Farmers Cooperative", village: "Kwadon" },
  { name: "Tangale Women Sesame Cooperative", village: "Billiri" },
  { name: "Billiri Soybean Growers Cooperative", village: "Tal" },
  { name: "Kaltungo Agro Cooperative Society", village: "Kaltungo" },
  { name: "Deba Farmers Multipurpose Cooperative", village: "Deba" },
];

export const BANKS = ["First Bank", "UBA", "Zenith Bank", "Access Bank", "GTBank", "Union Bank", "Jaiz Bank"] as const;

export const CUSTOMERS: ReadonlyArray<{
  name: string;
  phone: string;
  email: string;
  address: string;
  state: string;
  city: "Lagos" | "Kano" | "Port Harcourt";
  /** relative order frequency */
  weight: number;
}> = [
  { name: "Ikeja Feed Mills Ltd", phone: "2348021110001", email: "purchasing@ikejafeeds.example", address: "Plot 14, Oba Akran Ave, Ikeja", state: "Lagos", city: "Lagos", weight: 3 },
  { name: "Apapa Oilseeds Processing Ltd", phone: "2348021110002", email: "procurement@apapaoilseeds.example", address: "Wharf Road, Apapa", state: "Lagos", city: "Lagos", weight: 2 },
  { name: "Lekki Poultry Feeds", phone: "2348021110003", email: "orders@lekkipoultry.example", address: "Km 22 Lekki-Epe Expressway", state: "Lagos", city: "Lagos", weight: 2 },
  { name: "Kano Grains Hub", phone: "2348021110004", email: "trade@kanograinshub.example", address: "Dawanau Market, Kano", state: "Kano", city: "Kano", weight: 3 },
  { name: "Sabon Gari Commodity Traders", phone: "2348021110005", email: "info@sabongaritraders.example", address: "Sabon Gari, Kano", state: "Kano", city: "Kano", weight: 2 },
  { name: "Dala Sesame Exporters", phone: "2348021110006", email: "exports@dalasesame.example", address: "Bompai Industrial Estate, Kano", state: "Kano", city: "Kano", weight: 1 },
  { name: "Harbour Agro Exports", phone: "2348021110007", email: "ops@harbouragro.example", address: "Trans-Amadi Industrial Layout, Port Harcourt", state: "Rivers", city: "Port Harcourt", weight: 2 },
  { name: "Rivers Foods Processing Co.", phone: "2348021110008", email: "supply@riversfoods.example", address: "Rumuokoro, Port Harcourt", state: "Rivers", city: "Port Harcourt", weight: 1 },
];

/** Outbound haulage cost range per destination city, kobo. */
export const HAULAGE_KOBO: Record<"Lagos" | "Kano" | "Port Harcourt", [number, number]> = {
  Lagos: [42_000_000, 55_000_000],
  "Port Harcourt": [35_000_000, 45_000_000],
  Kano: [18_000_000, 26_000_000],
};

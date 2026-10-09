// Shared by the server page and the client table. Keep this module free of
// "use client": importing a constant from a client module into a server
// component yields a client-reference proxy in production builds.
export type AgeBandKey = "d0_30" | "d31_60" | "d61_90" | "d90_plus";

export const BANDS: { key: AgeBandKey; label: string }[] = [
  { key: "d0_30", label: "0–30 days" },
  { key: "d31_60", label: "31–60 days" },
  { key: "d61_90", label: "61–90 days" },
  { key: "d90_plus", label: "90+ days" },
];

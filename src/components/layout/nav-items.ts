import type { Permission } from "@/lib/authz/permissions";
import type { LucideIcon } from "lucide-react";
import {
  LayoutDashboard,
  ShoppingBasket,
  Warehouse,
  Banknote,
  Truck,
  BarChart3,
  Settings,
  Users,
  Bell,
  FileSpreadsheet,
  ClipboardList,
  ArrowLeftRight,
  Scale,
  BadgeDollarSign,
  Receipt,
  HandCoins,
  BookOpenCheck,
  PackageSearch,
  Route,
  Wallet,
} from "lucide-react";

export interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
  permission: Permission;
}

export interface NavSection {
  label: string;
  items: NavItem[];
}

// Grouped navigation for the "More" sheet / desktop sidebar. Every entry is
// permission-gated; the shell filters by the viewer's role.
export const NAV_SECTIONS: NavSection[] = [
  {
    label: "Overview",
    items: [
      { label: "Dashboard", href: "/", icon: LayoutDashboard, permission: "dashboard.read" },
      { label: "Alerts", href: "/alerts", icon: Bell, permission: "notification.read" },
    ],
  },
  {
    label: "Buying",
    items: [
      { label: "Purchases", href: "/purchases", icon: ShoppingBasket, permission: "purchase.read" },
      { label: "Suppliers", href: "/suppliers", icon: Users, permission: "supplier.read" },
      { label: "Advances", href: "/advances", icon: HandCoins, permission: "advance.read" },
      { label: "Supplier payments", href: "/supplier-payments", icon: Wallet, permission: "supplier-payment.read" },
      { label: "Payables", href: "/payables", icon: BookOpenCheck, permission: "supplier-payment.read" },
      { label: "Price guides", href: "/price-guides", icon: Scale, permission: "price-guide.read" },
    ],
  },
  {
    label: "Warehouse",
    items: [
      { label: "Stock", href: "/stock", icon: Warehouse, permission: "stock.read" },
      { label: "Movements", href: "/movements", icon: PackageSearch, permission: "stock.read" },
      { label: "Transfers", href: "/transfers", icon: ArrowLeftRight, permission: "transfer.read" },
      { label: "Counts", href: "/counts", icon: ClipboardList, permission: "count.read" },
      { label: "Adjustments", href: "/adjustments", icon: Scale, permission: "adjustment.read" },
    ],
  },
  {
    label: "Selling",
    items: [
      { label: "Sales", href: "/sales", icon: Banknote, permission: "sale.read" },
      { label: "Customers", href: "/customers", icon: Users, permission: "customer.read" },
      { label: "Invoices", href: "/invoices", icon: Receipt, permission: "invoice.read" },
      { label: "Customer payments", href: "/customer-payments", icon: Wallet, permission: "customer-payment.read" },
      { label: "Receivables", href: "/receivables", icon: BadgeDollarSign, permission: "customer-payment.read" },
    ],
  },
  {
    label: "Logistics",
    items: [
      { label: "Trips", href: "/trips", icon: Route, permission: "trip.read" },
      { label: "Expenses", href: "/expenses", icon: Truck, permission: "expense.read" },
    ],
  },
  {
    label: "Insight",
    items: [
      { label: "Reports", href: "/reports", icon: BarChart3, permission: "report.read" },
      { label: "CSV import", href: "/settings/import", icon: FileSpreadsheet, permission: "import.write" },
    ],
  },
  {
    label: "Administration",
    items: [
      { label: "Settings", href: "/settings", icon: Settings, permission: "org.settings" },
      { label: "Master data", href: "/settings/master-data", icon: ClipboardList, permission: "master-data.read" },
      { label: "Users", href: "/settings/users", icon: Users, permission: "users.read" },
      { label: "Audit log", href: "/settings/audit", icon: BookOpenCheck, permission: "audit.read" },
    ],
  },
];

// The five slots on the mobile bottom bar, filtered by permission at render.
export const BOTTOM_NAV: NavItem[] = [
  { label: "Home", href: "/", icon: LayoutDashboard, permission: "dashboard.read" },
  { label: "Buy", href: "/purchases", icon: ShoppingBasket, permission: "purchase.read" },
  { label: "Stock", href: "/stock", icon: Warehouse, permission: "stock.read" },
  { label: "Sell", href: "/sales", icon: Banknote, permission: "sale.read" },
];

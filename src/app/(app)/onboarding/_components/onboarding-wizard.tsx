"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, ChevronLeft, ChevronRight, Users } from "lucide-react";

import {
  completeSetupAction,
  createBagTypeAction,
  createBuyingPointAction,
  createCommodityAction,
  createGradeAction,
  createWarehouseAction,
} from "@/actions/master-data";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import {
  bagTypeInput,
  buyingPointInput,
  commodityInput,
  gradeInput,
  warehouseInput,
} from "@/lib/validation/masterData";
import { cn } from "@/lib/utils";

import * as cfg from "@/app/(app)/settings/master-data/_components/entity-config";
import {
  EntityForm,
  formatKg,
  runAction,
  type AnyAction,
  type FieldSpec,
  type FormValues,
} from "@/app/(app)/settings/master-data/_components/form-kit";

type Item = { id: string; label: string };

export type OnboardingData = {
  commodities: { id: string; name: string; code: string }[];
  grades: { id: string; name: string; commodityName: string }[];
  bagTypes: { id: string; name: string; standardKg: string }[];
  warehouses: { id: string; name: string; capacityKg: string | null }[];
  buyingPoints: { id: string; name: string; state: string | null }[];
  setupCompletedAt: Date | null;
  initialStep: number;
};

type Step = {
  key: string;
  title: string;
  description: string;
  items: Item[];
  form?: {
    fields: FieldSpec[];
    schema: typeof commodityInput | typeof gradeInput | typeof bagTypeInput | typeof warehouseInput | typeof buyingPointInput;
    defaults: FormValues;
    action: AnyAction;
    noun: string;
  };
  blocked?: string;
};

export function OnboardingWizard(data: OnboardingData) {
  const router = useRouter();
  const [index, setIndex] = useState(Math.min(Math.max(data.initialStep, 0), 5));
  const [finishing, startFinish] = useTransition();

  const steps: Step[] = [
    {
      key: "commodities",
      title: "Commodities",
      description: "What do you buy and sell? Add each crop with a short code.",
      items: data.commodities.map((c) => ({ id: c.id, label: `${c.name} (${c.code})` })),
      form: {
        fields: cfg.commodityFields.filter((f) => f.name !== "active"),
        schema: commodityInput,
        defaults: cfg.commodityDefaults,
        action: createCommodityAction,
        noun: "commodity",
      },
    },
    {
      key: "grades",
      title: "Grades",
      description: "Quality grades for each commodity, e.g. Grade A, Grade B.",
      items: data.grades.map((g) => ({ id: g.id, label: `${g.commodityName} · ${g.name}` })),
      form:
        data.commodities.length > 0
          ? {
              fields: cfg.gradeFields(data.commodities),
              schema: gradeInput,
              defaults: cfg.gradeDefaults(data.commodities[0]?.id ?? ""),
              action: createGradeAction,
              noun: "grade",
            }
          : undefined,
      blocked: data.commodities.length === 0 ? "Add a commodity first — go back one step, or skip for now." : undefined,
    },
    {
      key: "bag-types",
      title: "Bag types",
      description: "Bags you weigh in, with their standard weight and empty-sack weight.",
      items: data.bagTypes.map((b) => ({ id: b.id, label: `${b.name} · ${formatKg(b.standardKg)}` })),
      form: {
        fields: cfg.bagTypeFields,
        schema: bagTypeInput,
        defaults: cfg.bagTypeDefaults,
        action: createBagTypeAction,
        noun: "bag type",
      },
    },
    {
      key: "warehouses",
      title: "Warehouses",
      description: "Where you store stock. Capacity powers the near-full alert. Bins can be added later in Settings.",
      items: data.warehouses.map((w) => ({
        id: w.id,
        label: w.capacityKg ? `${w.name} · ${formatKg(w.capacityKg)}` : w.name,
      })),
      form: {
        fields: cfg.warehouseFields.filter((f) => f.name !== "active"),
        schema: warehouseInput,
        defaults: cfg.warehouseDefaults,
        action: createWarehouseAction,
        noun: "warehouse",
      },
    },
    {
      key: "buying-points",
      title: "Buying points",
      description: "Markets and collection points where your officers buy.",
      items: data.buyingPoints.map((p) => ({ id: p.id, label: p.state ? `${p.name} · ${p.state}` : p.name })),
      form: {
        fields: cfg.buyingPointFields.filter((f) => f.name !== "active"),
        schema: buyingPointInput,
        defaults: cfg.buyingPointDefaults,
        action: createBuyingPointAction,
        noun: "buying point",
      },
    },
    {
      key: "users",
      title: "Your team",
      description: "Invite managers, procurement officers, warehouse keepers, sales and accounts staff.",
      items: [],
    },
  ];

  const step = steps[index];
  const isLast = index === steps.length - 1;
  const percent = Math.round(((index + 1) / steps.length) * 100);

  const go = (i: number) => {
    setIndex(i);
    window.scrollTo({ top: 0 });
  };

  const finish = () =>
    startFinish(async () => {
      const ok = await runAction(completeSetupAction, {}, "Setup complete — welcome to AggreTrack!");
      if (ok) {
        router.push("/");
        router.refresh();
      }
    });

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-4">
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between text-sm">
          <span className="font-medium">
            Step {index + 1} of {steps.length}
          </span>
          <span className="text-muted-foreground">{percent}%</span>
        </div>
        <Progress value={percent} aria-label="Setup progress" />
        <ol className="-mx-4 flex gap-1 overflow-x-auto px-4 pb-1" aria-label="Setup steps">
          {steps.map((s, i) => {
            const done = s.items.length > 0;
            return (
              <li key={s.key}>
                <button
                  type="button"
                  onClick={() => go(i)}
                  aria-current={i === index ? "step" : undefined}
                  className={cn(
                    "flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs whitespace-nowrap",
                    i === index ? "border-primary bg-primary text-primary-foreground" : "text-muted-foreground",
                  )}
                >
                  {done ? <Check className="size-3" /> : <span>{i + 1}</span>}
                  {s.title}
                </button>
              </li>
            );
          })}
        </ol>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{step.title}</CardTitle>
          <CardDescription>{step.description}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {step.items.length > 0 ? (
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground uppercase">Added</span>
              <ul className="flex flex-wrap gap-1.5">
                {step.items.map((it) => (
                  <li key={it.id}>
                    <Badge variant="secondary">{it.label}</Badge>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {step.blocked ? (
            <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">{step.blocked}</p>
          ) : null}

          {step.form ? (
            <EntityForm
              key={step.key}
              fields={step.form.fields}
              schema={step.form.schema}
              defaultValues={step.form.defaults}
              action={step.form.action}
              successMessage={`${step.form.noun.charAt(0).toUpperCase()}${step.form.noun.slice(1)} added`}
              submitLabel={step.items.length > 0 ? `Add another ${step.form.noun}` : `Add ${step.form.noun}`}
              resetOnSuccess
              onSuccess={() => router.refresh()}
            />
          ) : null}

          {isLast ? (
            <div className="flex flex-col gap-3">
              <Button asChild variant="outline" className="h-11 justify-start">
                <Link href="/settings/users">
                  <Users /> Invite users and set roles
                </Link>
              </Button>
              <p className="text-sm text-muted-foreground">
                You can change anything later under Settings → Master data.
              </p>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <div className="sticky bottom-0 -mx-4 flex gap-2 border-t bg-background px-4 py-3 sm:static sm:mx-0 sm:border-0 sm:px-0">
        <Button
          variant="outline"
          className="h-11 flex-1 sm:flex-none"
          disabled={index === 0}
          onClick={() => go(index - 1)}
        >
          <ChevronLeft /> Back
        </Button>
        {isLast ? (
          <Button className="h-11 flex-1" disabled={finishing} onClick={finish}>
            {finishing ? "Finishing…" : data.setupCompletedAt ? "Done" : "Finish setup"}
          </Button>
        ) : (
          <Button
            className="h-11 flex-1"
            variant={step.items.length > 0 ? "default" : "secondary"}
            onClick={() => go(index + 1)}
          >
            {step.items.length > 0 ? "Next" : "Skip for now"} <ChevronRight />
          </Button>
        )}
      </div>
    </div>
  );
}

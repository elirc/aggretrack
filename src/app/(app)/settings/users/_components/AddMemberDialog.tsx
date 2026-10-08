"use client";

import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { Loader2, UserPlus } from "lucide-react";
import type { Role } from "@/lib/authz/permissions";
import { addMemberAction } from "@/actions/users";
import { addMemberSchema, ROLE_LABELS } from "@/lib/validation/users";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { actionErrorMessage, applyFieldErrors } from "@/components/auth/messages";

interface AddMemberDialogProps {
  assignableRoles: Role[];
}

export function AddMemberDialog({ assignableRoles }: AddMemberDialogProps) {
  const [open, setOpen] = useState(false);
  const form = useForm({
    resolver: zodResolver(addMemberSchema),
    defaultValues: { name: "", phone: "", role: "sales" as Role, email: "", password: "" },
  });
  const { errors, isSubmitting } = form.formState;

  const onSubmit = form.handleSubmit(async (values) => {
    const res = await addMemberAction(values);
    if (!res.ok) {
      applyFieldErrors(form.setError, res.fieldErrors);
      toast.error(actionErrorMessage(res.error));
      return;
    }
    toast.success(
      res.data.createdUser
        ? `${values.name} added — they can sign in with their phone`
        : `${values.name} already had an account and was added`,
    );
    form.reset();
    setOpen(false);
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <UserPlus className="size-4" />
          Add user
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add a user</DialogTitle>
          <DialogDescription>
            They sign in with their phone number. Email and password are optional.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} noValidate id="add-member-form">
          <FieldGroup>
            <Field data-invalid={errors.name ? true : undefined}>
              <FieldLabel htmlFor="am-name">Name</FieldLabel>
              <Input id="am-name" className="h-11 text-base" {...form.register("name")} />
              <FieldError errors={[errors.name]} />
            </Field>
            <Field data-invalid={errors.phone ? true : undefined}>
              <FieldLabel htmlFor="am-phone">Phone number</FieldLabel>
              <Input
                id="am-phone"
                type="tel"
                inputMode="tel"
                placeholder="0803 123 4567"
                className="h-11 text-base"
                {...form.register("phone")}
              />
              <FieldError errors={[errors.phone]} />
            </Field>
            <Field data-invalid={errors.role ? true : undefined}>
              <FieldLabel htmlFor="am-role">Role</FieldLabel>
              <Controller
                control={form.control}
                name="role"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger id="am-role" className="h-11 w-full">
                      <SelectValue placeholder="Pick a role" />
                    </SelectTrigger>
                    <SelectContent>
                      {assignableRoles.map((r) => (
                        <SelectItem key={r} value={r}>
                          {ROLE_LABELS[r]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
              <FieldError errors={[errors.role]} />
            </Field>
            <Field data-invalid={errors.email ? true : undefined}>
              <FieldLabel htmlFor="am-email">Email (optional)</FieldLabel>
              <Input
                id="am-email"
                type="email"
                autoComplete="off"
                className="h-11 text-base"
                {...form.register("email")}
              />
              <FieldError errors={[errors.email]} />
            </Field>
            <Field data-invalid={errors.password ? true : undefined}>
              <FieldLabel htmlFor="am-password">Password (optional)</FieldLabel>
              <Input
                id="am-password"
                type="password"
                autoComplete="new-password"
                className="h-11 text-base"
                {...form.register("password")}
              />
              <FieldDescription>Set one to allow email + password sign in.</FieldDescription>
              <FieldError errors={[errors.password]} />
            </Field>
          </FieldGroup>
        </form>
        <DialogFooter>
          <Button
            type="submit"
            form="add-member-form"
            className="h-11 w-full sm:w-auto"
            disabled={isSubmitting}
          >
            {isSubmitting ? <Loader2 className="size-4 animate-spin" /> : null}
            Add user
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

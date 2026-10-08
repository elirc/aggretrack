"use client";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PhoneLoginForm } from "./PhoneLoginForm";
import { EmailLoginForm } from "./EmailLoginForm";

export function LoginTabs() {
  return (
    <Tabs defaultValue="phone" className="w-full">
      <TabsList className="grid w-full grid-cols-2">
        <TabsTrigger value="phone">Phone</TabsTrigger>
        <TabsTrigger value="email">Email</TabsTrigger>
      </TabsList>
      <TabsContent value="phone" className="pt-4">
        <PhoneLoginForm />
      </TabsContent>
      <TabsContent value="email" className="pt-4">
        <EmailLoginForm />
      </TabsContent>
    </Tabs>
  );
}

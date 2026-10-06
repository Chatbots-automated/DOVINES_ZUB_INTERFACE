"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

export const Drawer = DialogPrimitive.Root;
export const DrawerTrigger = DialogPrimitive.Trigger;
export const DrawerClose = DialogPrimitive.Close;

export function DrawerContent({
  className,
  children,
  width = "lg",
  ...props
}: DialogPrimitive.DialogContentProps & { width?: "md" | "lg" | "xl" }) {
  const widthClass = { md: "sm:max-w-[420px]", lg: "sm:max-w-[560px]", xl: "sm:max-w-[720px]" }[width];
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-ink/40 data-[state=open]:animate-in data-[state=open]:fade-in" />
      <DialogPrimitive.Content
        className={cn(
          "fixed inset-y-0 right-0 z-50 flex h-full w-full flex-col border-l border-border bg-surface shadow-elevated outline-none",
          "data-[state=open]:animate-in data-[state=open]:slide-in-from-right data-[state=closed]:animate-out data-[state=closed]:slide-out-to-right",
          widthClass,
          className,
        )}
        {...props}
      >
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function DrawerHeader({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("flex items-center justify-between gap-3 border-b border-border px-6 py-4", className)} {...props}>
      {children}
      <DialogPrimitive.Close className="rounded-control p-1 text-text-muted hover:bg-surface-secondary hover:text-text-primary">
        <X className="size-4" />
      </DialogPrimitive.Close>
    </div>
  );
}

export function DrawerTitle({ className, ...props }: DialogPrimitive.DialogTitleProps) {
  return <DialogPrimitive.Title className={cn("text-[17px] font-semibold text-text-primary", className)} {...props} />;
}

export function DrawerBody({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex-1 overflow-y-auto scrollbar-thin px-6 py-5", className)} {...props} />;
}

export function DrawerFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("flex items-center justify-end gap-2 border-t border-border px-6 py-4", className)} {...props} />
  );
}

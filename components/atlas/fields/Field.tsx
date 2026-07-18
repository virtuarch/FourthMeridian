/**
 * components/atlas/fields/Field.tsx  (UI Convergence Wave 1 — W1-D)
 *
 * The one Atlas field row: a Label above a caller-supplied control, with optional
 * HelpText and an inline FieldError below it. Composes the kit's own primitives so
 * a form is `<Field label help>{<Input/>}</Field>` instead of hand-stacked markup.
 */

import type { ReactNode } from "react";
import { Label } from "@/components/atlas/fields/Label";
import { HelpText } from "@/components/atlas/fields/HelpText";
import { FieldError } from "@/components/atlas/fields/FieldError";

export function Field({
  label,
  htmlFor,
  help,
  error,
  children,
}: {
  label?: ReactNode;
  htmlFor?: string;
  help?: ReactNode;
  /** A user-facing error; falsy renders nothing. */
  error?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      {label && <Label htmlFor={htmlFor}>{label}</Label>}
      {children}
      {help && <HelpText>{help}</HelpText>}
      <FieldError>{error}</FieldError>
    </div>
  );
}

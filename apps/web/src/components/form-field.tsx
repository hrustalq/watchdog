import type { ComponentProps, ReactNode } from "react";
import { FieldError } from "@/components/field-error";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

const checkboxBox =
  "size-4 shrink-0 accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
const helpText = "text-xs text-muted-foreground wrap-anywhere text-pretty";

interface FieldMessageProps {
  id: string;
  help: ReactNode;
  error: string | undefined;
  /** Keep the hint under a refused field; the model form's examples matter most then. */
  showHelpWithError: boolean;
}

function FieldMessage({ id, help, error, showHelpWithError }: FieldMessageProps) {
  const invalid = error !== undefined;
  return (
    <>
      {invalid ? <FieldError id={`${id}-error`}>{error}</FieldError> : null}
      {help !== undefined && (!invalid || showHelpWithError) ? (
        <p id={`${id}-help`} className={helpText}>
          {help}
        </p>
      ) : null}
    </>
  );
}

/** The ids a control points at: its error and, unless the error hides it, its hint. */
function describedBy(
  id: string,
  help: ReactNode,
  error: string | undefined,
  showHelpWithError: boolean,
  external: string | undefined,
) {
  const ids: string[] = [];
  if (error !== undefined) ids.push(`${id}-error`);
  if (help !== undefined && (error === undefined || showHelpWithError)) ids.push(`${id}-help`);
  if (external !== undefined) ids.push(...external.split(" "));
  return ids.length === 0 ? undefined : ids.join(" ");
}

const labelOf = (label: ReactNode, optional: boolean) => (
  <>
    {label}
    {optional ? <span className="font-normal text-muted-foreground"> (optional)</span> : null}
  </>
);

/**
 * A labelled text box with its hint or its problem under it. It owns the contract every form was
 * writing by hand: the label points at the box, a refused box points at its one error and takes focus
 * so the message is read with the field, a box with no error points at its hint instead, and a
 * refused box replaces the hint rather than showing both (pass `showHelpWithError` where the hint is
 * the fix's example). It renders the kit's Input and Label, so the 32px control and Label type come
 * from the design system and not from each screen.
 */
export function TextField({
  id,
  name = id,
  label,
  optional = false,
  alternateLabel,
  help,
  error,
  showHelpWithError = false,
  focusOnError = true,
  describedBy: externalDescription,
  className,
  controlClassName,
  ...input
}: {
  id: string;
  name?: string;
  label: ReactNode;
  optional?: boolean;
  /**
   * A second label that takes over while another control is chosen, as Add Source's URL field does
   * when Website is picked. Each stays its own <label>, so an accessible name is exactly one of
   * them and never both run together. Pass the two class strings that switch them, so this component
   * isn't tied to one form's `:has()` selector.
   */
  alternateLabel?: { label: ReactNode; className: string; primaryClassName: string };
  help?: ReactNode;
  error?: string | undefined;
  showHelpWithError?: boolean;
  /** False keeps focus where it is even when this field is refused; a form focuses its first problem. */
  focusOnError?: boolean;
  /** Another element's id (or ids) the control is described by, such as a section's description. */
  describedBy?: string;
  className?: string;
  controlClassName?: string;
} & Omit<ComponentProps<"input">, "id" | "name" | "className">) {
  const invalid = error !== undefined;
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {alternateLabel === undefined ? (
        <Label htmlFor={id}>{labelOf(label, optional)}</Label>
      ) : (
        <>
          <Label htmlFor={id} className={alternateLabel.primaryClassName}>
            {labelOf(label, optional)}
          </Label>
          <Label htmlFor={id} className={alternateLabel.className}>
            {labelOf(alternateLabel.label, optional)}
          </Label>
        </>
      )}
      <Input
        {...input}
        id={id}
        name={name}
        spellCheck={input.spellCheck ?? false}
        aria-invalid={invalid}
        aria-describedby={describedBy(id, help, error, showHelpWithError, externalDescription)}
        // eslint-disable-next-line jsx-a11y/no-autofocus -- only with an error on this field to fix
        autoFocus={input.autoFocus ?? (invalid && focusOnError)}
        className={controlClassName}
      />
      <FieldMessage id={id} help={help} error={error} showHelpWithError={showHelpWithError} />
    </div>
  );
}

/**
 * A labelled multi-line box, with the same label, hint, error and focus contract as TextField. The
 * kit's Textarea sizes itself to its content; pass `rows` for the height a screen wants before it
 * does.
 */
export function TextareaField({
  id,
  name = id,
  label,
  optional = false,
  help,
  error,
  showHelpWithError = false,
  focusOnError = true,
  describedBy: externalDescription,
  className,
  controlClassName,
  ...textarea
}: {
  id: string;
  name?: string;
  label: ReactNode;
  optional?: boolean;
  help?: ReactNode;
  error?: string | undefined;
  showHelpWithError?: boolean;
  /** False keeps focus where it is even when this field is refused; a form focuses its first problem. */
  focusOnError?: boolean;
  describedBy?: string;
  className?: string;
  controlClassName?: string;
} & Omit<ComponentProps<"textarea">, "id" | "name" | "className">) {
  const invalid = error !== undefined;
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <Label htmlFor={id}>{labelOf(label, optional)}</Label>
      <Textarea
        {...textarea}
        id={id}
        name={name}
        aria-invalid={invalid}
        aria-describedby={describedBy(id, help, error, showHelpWithError, externalDescription)}
        // eslint-disable-next-line jsx-a11y/no-autofocus -- only with an error on this field to fix
        autoFocus={invalid && focusOnError}
        className={controlClassName}
      />
      <FieldMessage id={id} help={help} error={error} showHelpWithError={showHelpWithError} />
    </div>
  );
}

/**
 * A labelled native select, on the kit's NativeSelect so the chevron, height and focus ring match a
 * text box. It stays a native `<select>`: a form of one post's values must work without JavaScript.
 * `controlClassName` sizes the select itself; `className` belongs to the field's column.
 */
export function SelectField({
  id,
  name = id,
  label,
  optional = false,
  help,
  error,
  showHelpWithError = false,
  focusOnError = true,
  describedBy: externalDescription,
  className,
  controlClassName,
  children,
  ...select
}: {
  id: string;
  name?: string;
  label: ReactNode;
  optional?: boolean;
  help?: ReactNode;
  error?: string | undefined;
  showHelpWithError?: boolean;
  /** False keeps focus where it is even when this field is refused; a form focuses its first problem. */
  focusOnError?: boolean;
  describedBy?: string;
  className?: string;
  controlClassName?: string;
  children: ReactNode;
} & Omit<ComponentProps<"select">, "id" | "name" | "className" | "children" | "size">) {
  const invalid = error !== undefined;
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <Label htmlFor={id}>{labelOf(label, optional)}</Label>
      <NativeSelect
        {...select}
        id={id}
        name={name}
        aria-invalid={invalid}
        aria-describedby={describedBy(id, help, error, showHelpWithError, externalDescription)}
        // eslint-disable-next-line jsx-a11y/no-autofocus -- only with an error on this field to fix
        autoFocus={invalid && focusOnError}
        className={cn("w-full", controlClassName)}
      >
        {children}
      </NativeSelect>
      <FieldMessage id={id} help={help} error={error} showHelpWithError={showHelpWithError} />
    </div>
  );
}

/**
 * A checkbox with its label as the target, so the whole row is clickable and a 16px box never has to
 * be hit exactly. It stays a native `<input type="checkbox">`, unlike the kit's Checkbox button,
 * because several screens must post their boxes without JavaScript. `help` indents under the label
 * at the box's width, so it reads as that box's line.
 */
export function CheckboxField({
  id,
  name = id,
  label,
  help,
  className,
  helpClassName,
  ...input
}: {
  id: string;
  name?: string;
  label: ReactNode;
  help?: ReactNode;
  className?: string;
  helpClassName?: string;
} & Omit<ComponentProps<"input">, "id" | "name" | "type" | "className">) {
  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <Label htmlFor={id} className="flex min-h-6 items-center gap-2">
        <input
          {...input}
          id={id}
          name={name}
          type="checkbox"
          aria-describedby={help === undefined ? input["aria-describedby"] : `${id}-help`}
          className={checkboxBox}
        />
        <span className="min-w-0 break-words">{label}</span>
      </Label>
      {help === undefined ? null : (
        <p id={`${id}-help`} className={cn("pl-6", helpText, helpClassName)}>
          {help}
        </p>
      )}
    </div>
  );
}

"use client";

import { draftToYaml } from "@watchdog/core/rules/draft";
import Link from "next/link";
import { createContext, use, useEffect, useMemo, useRef, useState } from "react";
import { dataBox, field as fieldClass, fieldError, label, textBox, textLink } from "@/components/field-classes";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  addPart,
  asList,
  blankField,
  blankTest,
  changeField,
  changeKind,
  changeOp,
  conditionPart,
  type DeclaredField,
  destinationFits,
  type DestinationChoice,
  digestScheduleName,
  digestSchedules,
  type Draft,
  fieldPart,
  fieldReading,
  formHides,
  fromLines,
  isMap,
  isNumericField,
  isScalarList,
  kindOf,
  negate,
  type Path,
  pathKey,
  removeAt,
  type RuleProblem,
  type RuleType,
  ruleTypeOf,
  setAt,
  textOf,
  typedValue,
  valueAt,
} from "@/lib/rule-draft";
import { cn } from "@/lib/utils";
import { destinationsLink, waitingForConfirmation } from "./words";

type Options = readonly (readonly [value: string, label: string])[];

const contentFields: Options = [
  ["title", "Title"],
  ["body", "Body"],
  ["author", "Author"],
  ["url", "URL"],
  ["language", "Language"],
  ["source.type", "Source type"],
  ["source", "Source"],
];
const categoryField: Options = [["category", "Category"]];
const ratingFields: Options = [
  ["severity", "Severity"],
  ["importance", "Importance"],
];
const operators: Options = [
  ["contains", "contains"],
  ["is", "is"],
  ["in", "is one of"],
  ["matches", "matches regex"],
  ["exists", "exists"],
];
const numberOperators: Options = [
  ["gte", "is at least"],
  ["lte", "is at most"],
  ["is", "is"],
  ["in", "is one of"],
  ["exists", "exists"],
];
const actionKinds: Options = [
  ["alert", "Alert"],
  ["webhook", "Webhook"],
  ["digest", "Digest"],
];
const destinationTypes: Record<DestinationChoice["type"], string> = {
  telegram: "Telegram",
  email: "Email",
  webhook: "Webhook",
};
const valueHints: Partial<Record<string, string>> = {
  contains: "Text to find",
  matches: "Regular expression, such as (?i)launch",
};
const singleTypes: Options = [
  ["string", "Text"],
  ["integer", "Whole number"],
];
const allTypes: Options = [
  ...singleTypes,
  ["string-array", "List of text"],
  ["integer-array", "List of whole numbers"],
];
const readsFrom: Options = [
  ["title", "Title, by regex"],
  ["body", "Body, by regex"],
  ["jsonpath", "Source payload, by JSONPath"],
  ["css", "Page HTML, by CSS selector"],
];
const patterns = {
  regex: { label: "Regular expression", placeholder: "(CVE-\\d+-\\d+)", hint: "The field takes the first capture group, so the regex needs one." },
  jsonpath: { label: "JSONPath", placeholder: "$.categories[*].name", hint: "The path reads the Source's own payload for this Item." },
  css: {
    label: "CSS selector",
    placeholder: ".plan-pro .price",
    hint: "The selector reads the HTML of the website Source's Region, which is what a website Item keeps. Without an attribute, the field takes each match's text.",
  },
};

const sourcesList = "rule-form-sources";
const categoriesList = "rule-form-categories";

interface Editing {
  draft: Draft;
  problems: RuleProblem[];
  /** A change of value: the problems still point at the right places. */
  edit: (path: Path, value: unknown) => void;
  /** A change of shape: entries may have moved, so the problems no longer hold. */
  reshape: (path: Path, value: unknown) => void;
  remove: (path: Path) => void;
  destinations: DestinationChoice[];
  declared: DeclaredField[];
  /** The Categories this Workspace knows, for the boxes that take one. */
  categories: string[];
}

const EditingContext = createContext<Editing | null>(null);

function useEditing() {
  const editing = use(EditingContext);
  if (editing === null) throw new Error("A rule form part outside RuleForm");
  return editing;
}

const isUnder = (problem: RuleProblem, key: string) =>
  problem.path === key || problem.path.startsWith(`${key}.`);

/** What a control says about the problems at its path, which the `Problems` block at `shownAt` holds. */
function useInvalid(path: Path, shownAt: Path = path) {
  const { problems } = useEditing();
  const key = pathKey(path);
  const invalid = problems.some((problem) => isUnder(problem, key));
  return { "aria-invalid": invalid, "aria-describedby": invalid ? `problems-${pathKey(shownAt)}` : undefined };
}

const describedBy = (...ids: (string | undefined)[]) => ids.filter((id) => id !== undefined).join(" ") || undefined;

/** The messages beside a field, without the path the field already shows. */
function Problems({ at, exact = false }: { at: Path; exact?: boolean }) {
  const { problems } = useEditing();
  const key = pathKey(at);
  const here = problems.filter((problem) => (exact ? problem.path === key : isUnder(problem, key)));
  if (here.length === 0) return null;
  return (
    <ul id={`problems-${key}`} className="flex flex-col gap-1">
      {here.map((problem) => (
        <li key={`${problem.path}:${problem.message}`} className={cn(fieldError, "break-words whitespace-pre-wrap")}>
          {problem.message}
        </li>
      ))}
    </ul>
  );
}

/** The form view: it edits the draft through paths and leaves alone whatever it has no control for. */
export function RuleForm({
  draft,
  sources,
  categories,
  destinations,
  declared,
  scheduleHelp,
  problems,
  onEdit,
  onReshape,
}: {
  draft: Draft;
  sources: { id: string; name: string }[];
  categories: string[];
  destinations: DestinationChoice[];
  declared: DeclaredField[];
  scheduleHelp: string;
  problems: RuleProblem[];
  onEdit: (draft: Draft) => void;
  onReshape: (draft: Draft) => void;
}) {
  const type = ruleTypeOf(draft);
  const agent = kindOf(draft) === "agent";
  const hidden = formHides(draft);
  const root = useRef<HTMLDivElement>(null);
  const changedAt = useRef<Path | null>(null);
  const editing = useMemo<Editing>(
    () => ({
      draft,
      problems,
      edit: (path, value) => {
        onEdit(setAt(draft, path, value));
      },
      reshape: (path, value) => {
        changedAt.current = path;
        onReshape(setAt(draft, path, value));
      },
      remove: (path) => {
        changedAt.current = path;
        onReshape(removeAt(draft, path));
      },
      destinations,
      declared,
      categories,
    }),
    [draft, problems, onEdit, onReshape, destinations, declared, categories],
  );

  // A change of shape can take away the button that was pressed, which drops focus out of the form.
  // It goes to the nearest part still there: the one at that path, or the one around it.
  useEffect(() => {
    const path = changedAt.current;
    changedAt.current = null;
    if (path === null || document.activeElement !== document.body) return;
    for (let end = path.length; end > 0; end -= 1) {
      const part = root.current?.querySelector(`[data-path="${pathKey(path.slice(0, end))}"]`);
      const control = part?.querySelector<HTMLElement>("select, input, textarea, button");
      if (control) {
        control.focus();
        return;
      }
    }
  }, [draft]);

  const conditionHelp = {
    classifier: "An Item that meets this gets this Classifier's Categories. It can test Source and content.",
    extractor: "The rule runs on Items that meet this. It can test Categories, Source and content, not the Rating.",
    action: "The Action fires on Items that meet this, rated or not. A test on Severity or Importance never passes on an unrated Item.",
  }[type];

  return (
    <EditingContext value={editing}>
      <div ref={root} className="flex flex-col gap-6">
        <TextField path={[type]} labelText="Name" hidden={hidden.includes(type)} />

        {type === "action" ? <KindField hidden={hidden.includes("kind")} /> : null}

        {agent && type === "classifier" ? (
          <>
            <TextField path={["prompt"]} labelText="Prompt" hidden={hidden.includes("prompt")} multiline help="What the Agent decides about each Item, in plain language." />
            <LinesField path={["categories"]} labelText="Categories the Agent may assign" hidden={hidden.includes("categories")} known={categories} />
          </>
        ) : (
          <fieldset className="flex min-w-0 flex-col gap-2">
            <legend className={cn(label, "mb-2")}>{type === "classifier" ? "When" : "Condition"}</legend>
            <ConditionPart path={["when"]} type={type} />
            <p className="text-xs text-muted-foreground">{conditionHelp}</p>
          </fieldset>
        )}

        {type === "classifier" && !agent ? (
          <LinesField path={["assign"]} labelText="Categories to assign" hidden={hidden.includes("assign")} known={categories} />
        ) : null}

        {type === "extractor" ? (
          <>
            {agent ? (
              <TextField path={["prompt"]} labelText="Prompt" hidden={hidden.includes("prompt")} multiline help="What the Agent pulls out of each Item, in plain language." />
            ) : null}
            <FieldList hidden={hidden.includes("fields")} />
          </>
        ) : null}

        {type === "action" ? (
          <>
            {draft.kind === "digest" ? <ScheduleField hidden={hidden.includes("schedule")} help={scheduleHelp} /> : null}
            <DestinationList hidden={hidden.includes("destinations")} />
          </>
        ) : null}

        {hidden.length === 0 ? null : (
          <p className="rounded-lg bg-muted px-3 py-2 text-sm">
            Only the YAML view shows <span className="font-mono text-[0.8125rem]">{hidden.join(", ")}</span>. It
            stays in the rule.
          </p>
        )}

        <datalist id={sourcesList}>
          {sources.map((source) => (
            <option key={source.id} value={source.id}>
              {source.name}
            </option>
          ))}
        </datalist>

        <datalist id={categoriesList}>
          {categories.map((category) => (
            <option key={category} value={category} />
          ))}
        </datalist>
      </div>
    </EditingContext>
  );
}

function TextField({
  path,
  labelText,
  hidden,
  multiline = false,
  data = false,
  help,
  problemsShown = true,
}: {
  path: Path;
  labelText: string;
  hidden: boolean;
  multiline?: boolean;
  /** Text a person reads as data, such as a cron expression. */
  data?: boolean;
  help?: string;
  /** A control whose owner shows the problems, so the box doesn't repeat them. */
  problemsShown?: boolean;
}) {
  const { draft, edit } = useEditing();
  const invalid = useInvalid(path);
  const id = `rule-${pathKey(path)}`;
  const text = textOf(valueAt(draft, path));
  const helpId = help === undefined ? undefined : `${id}-help`;
  const described = { ...invalid, "aria-describedby": describedBy(invalid["aria-describedby"], helpId) };
  const onChange = (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    edit(path, event.target.value);
  };
  const box = multiline ? (
    <textarea id={id} rows={5} value={text} onChange={onChange} className={cn(textBox, "py-2")} {...described} />
  ) : (
    <input
      id={id}
      type="text"
      value={text}
      spellCheck={data ? false : undefined}
      onChange={onChange}
      className={cn(fieldClass, data && dataBox)}
      {...described}
    />
  );
  return (
    <div className="flex flex-col gap-2">
      {hidden ? null : (
        <>
          <label htmlFor={id} className={label}>
            {labelText}
          </label>
          {box}
          {help === undefined ? null : (
            <p id={helpId} className="text-xs text-muted-foreground">
              {help}
            </p>
          )}
        </>
      )}
      {problemsShown ? <Problems at={path} /> : null}
    </div>
  );
}

function LinesField({
  path,
  labelText,
  hidden,
  known = [],
}: {
  path: Path;
  labelText: string;
  hidden: boolean;
  /** The Categories the Workspace knows, for a box that takes one. A textarea can't have a datalist. */
  known?: string[];
}) {
  const { draft } = useEditing();
  const id = `rule-${pathKey(path)}`;
  const value = valueAt(draft, path);
  const list = isScalarList(value) ? value : [];
  // The ones already typed are the box's own, so only what else the Workspace knows is worth saying.
  const suggestions = known.filter((category) => !list.includes(category));
  return (
    <div className="flex flex-col gap-2">
      {hidden ? null : (
        <>
          <label htmlFor={id} className={label}>
            {labelText}
          </label>
          <LinesBox id={id} path={path} list={list} helpId={`${id}-help`} />
          <p id={`${id}-help`} className="text-xs text-muted-foreground">
            One per line.
            {suggestions.length === 0 ? null : <> Known Categories: {suggestions.join(", ")}.</>}
          </p>
        </>
      )}
      <Problems at={path} />
    </div>
  );
}

/** A list as one text box, with a line for each entry, so an entry can hold a comma. */
function LinesBox({
  id,
  path,
  list,
  label: ariaLabel,
  problemsAt = path,
  helpId,
  numeric = false,
}: {
  id?: string;
  path: Path;
  list: (string | number)[];
  label?: string;
  problemsAt?: Path;
  helpId?: string;
  /** The entries are compared with numbers, and "4" never equals 4. */
  numeric?: boolean;
}) {
  const { edit } = useEditing();
  const invalid = useInvalid(path, problemsAt);
  const text = list.join("\n");
  const typed = (lines: string[]) => (numeric ? lines.map((line) => typedValue("in", undefined, line, true)) : lines);
  return (
    <textarea
      id={id}
      aria-label={ariaLabel}
      rows={3}
      spellCheck={false}
      value={text}
      onChange={(event) => { edit(path, typed(fromLines(event.target.value))); }}
      onBlur={() => {
        // Only when there's something to tidy, because this turns numbers from the YAML into text.
        const tidied = fromLines(text, { tidy: true });
        if (tidied.join("\n") !== text) edit(path, typed(tidied));
      }}
      className={cn(textBox, dataBox, "py-1.5")}
      {...invalid}
      aria-describedby={describedBy(invalid["aria-describedby"], helpId)}
    />
  );
}

/** A select that can also show a value it doesn't offer, so a value from the YAML stays as it is. */
function Choice({
  value,
  options,
  onChange,
  labelText,
  invalid,
  className,
}: {
  value: unknown;
  options: Options;
  onChange: (value: string) => void;
  labelText: string;
  invalid?: { "aria-invalid": boolean; "aria-describedby": string | undefined };
  className?: string;
}) {
  const current = textOf(value);
  const known = options.some(([option]) => option === current);
  return (
    <select aria-label={labelText} value={current} onChange={(event) => { onChange(event.target.value); }} className={cn(fieldClass, "bg-background", className)} {...invalid}>
      {known ? null : <option value={current}>{value === undefined ? "Choose…" : current}</option>}
      {options.map(([option, text]) => (
        <option key={option} value={option}>
          {text}
        </option>
      ))}
    </select>
  );
}

function KindField({ hidden }: { hidden: boolean }) {
  const { draft, reshape } = useEditing();
  const invalid = useInvalid(["kind"]);
  return (
    <div className="flex flex-col gap-2">
      {hidden ? null : (
        <FieldLabel text="Kind">
          <Choice
            labelText="Kind"
            value={draft.kind}
            options={actionKinds}
            invalid={invalid}
            className="sm:w-48"
            onChange={(next) => { reshape([], changeKind(draft, next)); }}
          />
        </FieldLabel>
      )}
      <Problems at={["kind"]} />
    </div>
  );
}

/** The value of the form's Custom Schedule option, which no cron expression can be. */
const customSchedule = "custom";

/**
 * A Digest's schedule: a named one, which writes its cron expression into the draft, or Custom,
 * which shows the box for one. A value the YAML holds shows as its name, and stays as Custom with
 * its text otherwise. A new Digest has chosen nothing.
 */
function ScheduleField({ hidden, help }: { hidden: boolean; help: string }) {
  const { draft, edit } = useEditing();
  const invalid = useInvalid(["schedule"]);
  const schedule = textOf(valueAt(draft, ["schedule"]));
  // Custom is a choice the draft can't hold while its box is empty, so the field remembers it.
  const [custom, setCustom] = useState(false);
  const chosen = custom || (schedule !== "" && digestScheduleName(schedule) === undefined) ? customSchedule : schedule;
  const options: Options = [
    ["", "Choose…"],
    ...digestSchedules.map(({ cron, label: name }) => [cron, name] as const),
    [customSchedule, "Custom"],
  ];
  return (
    <div className="flex flex-col gap-2">
      {hidden ? null : (
        <>
          <FieldLabel text="Schedule">
            <Choice
              labelText="Schedule"
              value={chosen}
              options={options}
              invalid={invalid}
              className="sm:w-64"
              onChange={(next) => {
                setCustom(next === customSchedule);
                edit(["schedule"], next === customSchedule ? "" : next);
              }}
            />
          </FieldLabel>
          {chosen === customSchedule ? (
            <TextField path={["schedule"]} labelText="Cron expression" hidden={false} data help={help} problemsShown={false} />
          ) : null}
        </>
      )}
      <Problems at={["schedule"]} />
    </div>
  );
}

/**
 * The Destinations the Action's kind allows. A name from the YAML that isn't one of those stays in the
 * draft until the user takes it out, because the save is what says why it's wrong.
 */
function DestinationList({ hidden }: { hidden: boolean }) {
  const { draft, reshape, problems, destinations } = useEditing();
  const path = ["destinations"];
  const value = valueAt(draft, path);
  const list = isScalarList(value) ? value : [];
  const isWebhook = draft.kind === "webhook";
  const offered = destinations.filter(({ type }) => destinationFits(draft.kind, type));
  const others = list.filter((entry) => !offered.some(({ name }) => name === entry));
  const allowed = isWebhook ? "webhook" : "Telegram or email";
  const describedAs = "destinations-help";
  const invalidAt = (index: number, position: number) => {
    const invalid = problems.some(
      (problem) => problem.path === `destinations.${String(index)}` || (position === 0 && problem.path === "destinations"),
    );
    return { "aria-invalid": invalid, "aria-describedby": invalid ? "problems-destinations" : undefined };
  };
  const rows: { entry: string | number; note: string }[] = [
    ...offered.map(({ name, type, confirmed }) => ({
      entry: name,
      note: confirmed ? destinationTypes[type] : `${destinationTypes[type]} · not confirmed yet`,
    })),
    ...others.map((entry) => ({
      entry,
      note: destinations.some(({ name }) => name === entry) ? "Doesn't fit this kind" : "Not in this Workspace",
    })),
  ];
  return (
    <fieldset data-path="destinations" aria-describedby={hidden ? undefined : describedAs} className="flex min-w-0 flex-col gap-2">
      <legend className={cn(label, "mb-2")}>Destinations</legend>
      {hidden ? null : (
        <>
          {rows.length === 0 ? (
            <div className="flex flex-col items-start gap-2">
              <p className="text-sm text-muted-foreground">This Workspace has no {allowed} Destination yet.</p>
              <Link href={destinationsLink} className={buttonVariants({ variant: "outline" })}>
                Add a Destination
              </Link>
            </div>
          ) : (
            <ul className="flex flex-col gap-1">
              {rows.map(({ entry, note }, position) => (
                <li key={entry}>
                  <label className="flex min-h-8 cursor-pointer items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={list.includes(entry)}
                      onChange={(event) => {
                        reshape(path, event.target.checked ? [...list, entry] : list.filter((other) => other !== entry));
                      }}
                      className="size-4 shrink-0 accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                      {...invalidAt(list.indexOf(entry), position)}
                    />
                    <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                      <span className="min-w-0 break-words">{entry}</span>
                      <span className="text-xs text-muted-foreground">{note}</span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          <p id={describedAs} className="text-xs text-muted-foreground">
            {isWebhook ? "A webhook Action calls webhook Destinations." : "An alert or Digest goes to Telegram and email Destinations."}
            {rows.length === 0 ? null : (
              <>
                {" "}
                <Link href={destinationsLink} className={cn(textLink, "inline-flex min-h-6 items-center")}>
                  Add a Destination
                </Link>
              </>
            )}
          </p>
          <WaitingNotice destinations={destinations} listed={value} />
        </>
      )}
      <Problems at={path} />
    </fieldset>
  );
}

/**
 * Says which listed Destinations can't receive this Action yet, beside them. The region is there before
 * its words, because a screen reader only announces a change inside a status it already knows about.
 */
export function WaitingNotice({ destinations, listed }: { destinations: DestinationChoice[]; listed: unknown }) {
  const waiting = destinations
    .filter(({ name, confirmed }) => !confirmed && asList(listed).includes(name))
    .map(({ name }) => name);
  return (
    <div role="status">
      {waiting.length === 0 ? null : (
        <p className="flex items-baseline gap-2 rounded-lg bg-muted px-3 py-2 text-sm">
          <span aria-hidden="true" className="size-1.5 shrink-0 translate-y-[-1px] rounded-full bg-caution" />
          <span className="min-w-0 break-words">
            {waitingForConfirmation(waiting)} You can still save this Action.{" "}
            <Link href={destinationsLink} className={textLink}>
              Go to Destinations
            </Link>
          </span>
        </p>
      )}
    </div>
  );
}

function SmallButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <Button type="button" variant="ghost" size="sm" onClick={onClick}>
      {children}
    </Button>
  );
}

interface PartProps {
  path: Path;
  type: RuleType;
  /** Absent on the Condition itself, which a rule can't do without. */
  onRemove?: (() => void) | undefined;
}

/** One node of a Condition, shown according to what it holds. */
function ConditionPart({ path, type, onRemove }: PartProps) {
  const { draft, reshape } = useEditing();
  const node = valueAt(draft, path);
  const part = conditionPart(node);
  if (part === "yaml-only") {
    // A rule that has lost its Condition altogether can start a new one, and a part the form can't
    // show is only replaced when the user asks.
    if (node === undefined) {
      return (
        <div className="flex flex-col gap-2">
          <SmallButton onClick={() => { reshape(path, blankTest); }}>Add a test</SmallButton>
          <Problems at={path} />
        </div>
      );
    }
    return (
      <YamlOnly path={path} value={node} removeLabel={onRemove === undefined ? "Replace with a test" : "Remove"} onRemove={onRemove ?? (() => { reshape(path, blankTest); })} />
    );
  }
  if (part === "predicate" && isMap(node)) return <PredicatePart path={path} node={node} type={type} onRemove={onRemove} />;
  if (part === "not") return <NotPart path={path} node={node} type={type} onRemove={onRemove} />;
  return <GroupPart path={path} node={node} part={part === "any" ? "any" : "all"} type={type} onRemove={onRemove} />;
}

function PredicatePart({ path, node, type, onRemove }: PartProps & { node: Record<string, unknown> }) {
  const { edit, reshape, declared } = useEditing();
  const fieldInvalid = useInvalid([...path, "field"], path);
  const opInvalid = useInvalid([...path, "op"], path);
  const numeric = type === "action" && isNumericField(node.field, declared);
  const fieldOptions: Options = {
    classifier: contentFields,
    extractor: [...contentFields, ...categoryField],
    action: [
      ...categoryField,
      ...ratingFields,
      ...contentFields,
      ...declared.map(({ name }) => [`fields.${name}`, `Field ${name}`] as const),
    ],
  }[type];
  return (
    <div data-path={pathKey(path)} className="flex flex-col gap-2">
      <div className="grid gap-2 sm:grid-cols-[9rem_11rem_minmax(0,1fr)] md:grid-cols-[9rem_11rem_minmax(0,1fr)_auto]">
        <Choice
          labelText="Field"
          value={node.field}
          options={fieldOptions}
          invalid={fieldInvalid}
          onChange={(next) => {
            if (type === "action") reshape(path, changeField(node, next, isNumericField(next, declared)));
            else edit([...path, "field"], next);
          }}
        />
        <Choice
          labelText="Operator"
          value={node.op}
          options={numeric ? numberOperators : operators}
          invalid={opInvalid}
          onChange={(next) => {
            reshape(path, changeOp(node, next));
          }}
        />
        <PredicateValue path={path} node={node} numeric={numeric} />
        <div className="sm:col-span-3 md:col-span-1">
          <PartActions path={path} node={node} onRemove={onRemove} />
        </div>
      </div>
      <Problems at={path} />
    </div>
  );
}

/** A Rating is on a scale of its own, and an Item is never rated outside it. */
function numericHint(field: unknown, numeric: boolean) {
  if (!numeric) return undefined;
  return ratingFields.some(([rating]) => rating === field) ? "1 to 5" : "A number";
}

/** What the value box suggests: a Source's id, or a Category the Workspace knows. */
function suggestedValues(field: unknown) {
  if (field === "source") return sourcesList;
  return field === "category" ? categoriesList : undefined;
}

function PredicateValue({ path, node, numeric }: { path: Path; node: Record<string, unknown>; numeric: boolean }) {
  const { edit } = useEditing();
  const valuePath = [...path, "value"];
  const invalid = useInvalid(valuePath, path);
  const { value } = node;
  const op = textOf(node.op);
  if (isScalarList(value)) {
    return <LinesBox path={valuePath} list={value} label="Values, one per line" problemsAt={path} numeric={numeric} />;
  }
  if (op === "exists" && value === undefined) return null;
  return (
    <input
      type="text"
      aria-label="Value"
      spellCheck={false}
      placeholder={numericHint(node.field, numeric) ?? valueHints[op]}
      list={suggestedValues(node.field)}
      value={textOf(value)}
      onChange={(event) => {
        edit(valuePath, typedValue(op, value, event.target.value, numeric));
      }}
      className={cn(fieldClass, dataBox)}
      {...invalid}
    />
  );
}

/** What can be done to any part of a Condition. */
function PartActions({
  path,
  node,
  onRemove,
  children,
}: Pick<PartProps, "path" | "onRemove"> & { node: unknown; children?: React.ReactNode }) {
  const { reshape } = useEditing();
  const part = conditionPart(node);
  // A test inside a group is added from the group.
  const addsTest = part === "all" || part === "any" || (part === "predicate" && onRemove === undefined);
  return (
    <div className="flex flex-wrap items-center gap-1">
      {addsTest ? <SmallButton onClick={() => { reshape(path, addPart(node)); }}>Add a test</SmallButton> : null}
      {children}
      <SmallButton onClick={() => { reshape(path, negate(node)); }}>{part === "not" ? "Remove not" : "Not"}</SmallButton>
      {onRemove === undefined ? null : <SmallButton onClick={onRemove}>Remove</SmallButton>}
    </div>
  );
}

function NotPart({ path, node, type, onRemove }: PartProps & { node: unknown }) {
  return (
    <div data-path={pathKey(path)} className="flex flex-col gap-3 rounded-lg border p-3">
      <p className={label}>Not</p>
      <ConditionPart path={[...path, "not"]} type={type} />
      <Problems at={path} exact />
      <PartActions path={path} node={node} onRemove={onRemove} />
    </div>
  );
}

function GroupPart({ path, node, part, type, onRemove }: PartProps & { node: unknown; part: "all" | "any" }) {
  const { draft, reshape, remove } = useEditing();
  const listPath = [...path, part];
  const list = asList(valueAt(draft, listPath));
  return (
    <div data-path={pathKey(path)} className="flex flex-col gap-3 rounded-lg border p-3">
      <Choice
        labelText="How the tests combine"
        value={part}
        options={[
          ["all", "All of these"],
          ["any", "Any of these"],
        ]}
        className="sm:w-48"
        onChange={(next) => { reshape(path, { [next]: list }); }}
      />
      <Problems at={path} exact />
      <Problems at={listPath} exact />
      {list.map((_child, index) => {
        const childPath = [...listPath, index];
        // Entries have no ids, and every control here is controlled, so an index is a safe key.
        return (
          <div key={pathKey(childPath)} role="group" aria-label={`Part ${String(index + 1)}`}>
            <ConditionPart path={childPath} type={type} onRemove={() => { remove(childPath); }} />
          </div>
        );
      })}
      <PartActions path={path} node={node} onRemove={onRemove}>
        <SmallButton onClick={() => { reshape(path, addPart(node, { any: [blankTest] })); }}>Add a group</SmallButton>
      </PartActions>
    </div>
  );
}

/** A part of the rule the form has no controls for: shown as it is, and kept. */
function YamlOnly({ path, value, removeLabel, onRemove }: { path: Path; value: unknown; removeLabel: string; onRemove: () => void }) {
  return (
    <div data-path={pathKey(path)} className="flex flex-col gap-2 rounded-lg border p-3">
      <p className="text-xs text-muted-foreground">Only the YAML view can edit this part. It stays in the rule.</p>
      <pre className="overflow-x-auto font-mono text-[0.8125rem]">{draftToYaml(value)}</pre>
      <Problems at={path} />
      <div>
        <SmallButton onClick={onRemove}>{removeLabel}</SmallButton>
      </div>
    </div>
  );
}

function FieldList({ hidden }: { hidden: boolean }) {
  const { draft, reshape, remove } = useEditing();
  const kind = kindOf(draft);
  const fields = asList(valueAt(draft, ["fields"]));
  return (
    <fieldset data-path="fields" className="flex min-w-0 flex-col gap-3">
      <legend className={cn(label, "mb-2")}>Fields</legend>
      <Problems at={["fields"]} exact />
      {hidden
        ? null
        : fields.map((entry, index) => {
            const path = ["fields", index];
            const onRemove = () => { remove(path); };
            const part = fieldPart(entry, kind);
            return (
              <div key={pathKey(path)} role="group" aria-label={`Field ${String(index + 1)}`}>
                {part === "yaml-only" || !isMap(entry) ? (
                  <YamlOnly path={path} value={entry} removeLabel="Remove" onRemove={onRemove} />
                ) : (
                  <FieldRow path={path} entry={entry} part={part} onRemove={onRemove} />
                )}
              </div>
            );
          })}
      {hidden ? null : (
        <div>
          <SmallButton onClick={() => { reshape(["fields"], [...fields, blankField(kind)]); }}>Add a field</SmallButton>
        </div>
      )}
    </fieldset>
  );
}

function FieldLabel({ text, children }: { text: React.ReactNode; children: React.ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col gap-1">
      <span className={label}>{text}</span>
      {children}
    </label>
  );
}

function FieldRow({
  path,
  entry,
  part,
  onRemove,
}: {
  path: Path;
  entry: Record<string, unknown>;
  part: "regex" | "jsonpath" | "css" | "agent";
  onRemove: () => void;
}) {
  const { edit, reshape, remove } = useEditing();
  const nameInvalid = useInvalid([...path, "name"], path);
  const typeInvalid = useInvalid([...path, "type"], path);
  const fromInvalid = useInvalid([...path, "from"], path);
  const patternKey = part === "agent" ? "regex" : part;
  const pattern = patterns[patternKey];
  const patternPath = [...path, patternKey];
  const patternInvalid = useInvalid(patternPath, path);
  const attrPath = [...path, "attr"];
  const attrInvalid = useInvalid(attrPath, path);

  function readFrom(next: string) {
    if (next === "jsonpath" || next === "css") reshape(path, fieldReading(entry, next));
    else if (part === "regex") edit([...path, "from"], next);
    else reshape(path, { ...fieldReading(entry, "regex"), from: next });
  }

  return (
    <div data-path={pathKey(path)} className="flex flex-col gap-2 rounded-lg border p-3">
      <div className="grid gap-2 sm:grid-cols-2">
        <FieldLabel text="Field name">
          <input
            type="text"
            placeholder="cve"
            spellCheck={false}
            value={textOf(entry.name)}
            onChange={(event) => { edit([...path, "name"], event.target.value); }}
            className={cn(fieldClass, dataBox)}
            {...nameInvalid}
          />
        </FieldLabel>
        <FieldLabel text="Type">
          <Choice labelText="Type" value={entry.type} options={part === "regex" ? singleTypes : allTypes} invalid={typeInvalid} onChange={(next) => { edit([...path, "type"], next); }} />
        </FieldLabel>
        {part === "agent" ? null : (
          <>
            <FieldLabel text="Reads from">
              <Choice labelText="Reads from" value={part === "regex" ? entry.from : part} options={readsFrom} invalid={fromInvalid} onChange={readFrom} />
            </FieldLabel>
            <FieldLabel text={pattern.label}>
              <input
                type="text"
                placeholder={pattern.placeholder}
                spellCheck={false}
                value={textOf(entry[patternKey])}
                onChange={(event) => { edit(patternPath, event.target.value); }}
                className={cn(fieldClass, dataBox)}
                {...patternInvalid}
              />
            </FieldLabel>
            {part === "css" ? (
              <FieldLabel
                text={
                  <>
                    Attribute <span className="font-normal text-muted-foreground">(optional)</span>
                  </>
                }
              >
                <input
                  type="text"
                  placeholder="href"
                  spellCheck={false}
                  value={textOf(entry.attr)}
                  onChange={(event) => {
                    // An empty attribute isn't one: the field reads each match's text.
                    if (event.target.value === "") remove(attrPath);
                    else edit(attrPath, event.target.value);
                  }}
                  className={cn(fieldClass, dataBox)}
                  {...attrInvalid}
                />
              </FieldLabel>
            ) : null}
          </>
        )}
      </div>
      {part === "agent" ? null : <p className="text-xs text-muted-foreground">{pattern.hint}</p>}
      <Problems at={path} />
      <div>
        <SmallButton onClick={onRemove}>Remove</SmallButton>
      </div>
    </div>
  );
}

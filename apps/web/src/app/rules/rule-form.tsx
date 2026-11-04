"use client";

import { draftToYaml } from "@watchdog/core/rules/draft";
import { createContext, use, useEffect, useMemo, useRef } from "react";
import { dataBox, field as fieldClass, fieldError, label, textBox } from "@/components/field-classes";
import { Button } from "@/components/ui/button";
import {
  addPart,
  asList,
  blankField,
  blankTest,
  changeOp,
  conditionPart,
  type Draft,
  fieldPart,
  fieldReading,
  formHides,
  fromLines,
  isMap,
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
const operators: Options = [
  ["contains", "contains"],
  ["is", "is"],
  ["in", "is one of"],
  ["matches", "matches regex"],
  ["exists", "exists"],
];
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
];

const sourcesList = "rule-form-sources";

interface Editing {
  draft: Draft;
  problems: RuleProblem[];
  /** A change of value: the problems still point at the right places. */
  edit: (path: Path, value: unknown) => void;
  /** A change of shape: entries may have moved, so the problems no longer hold. */
  reshape: (path: Path, value: unknown) => void;
  remove: (path: Path) => void;
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
  problems,
  onEdit,
  onReshape,
}: {
  draft: Draft;
  sources: { id: string; name: string }[];
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
    }),
    [draft, problems, onEdit, onReshape],
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

  const conditionHelp =
    type === "classifier"
      ? "An Item that meets this gets this Classifier's Categories. It can test Source and content."
      : "The rule runs on Items that meet this. It can test Categories, Source and content, not the Rating.";

  return (
    <EditingContext value={editing}>
      <div ref={root} className="flex flex-col gap-6">
        <TextField path={[type]} labelText="Name" hidden={hidden.includes(type)} />

        {agent && type === "classifier" ? (
          <>
            <TextField path={["prompt"]} labelText="Prompt" hidden={hidden.includes("prompt")} multiline help="What the Agent decides about each Item, in plain language." />
            <LinesField path={["categories"]} labelText="Categories the Agent may assign" hidden={hidden.includes("categories")} />
          </>
        ) : (
          <fieldset className="flex min-w-0 flex-col gap-2">
            <legend className={cn(label, "mb-2")}>{type === "classifier" ? "When" : "Condition"}</legend>
            <ConditionPart path={["when"]} type={type} />
            <p className="text-xs text-muted-foreground">{conditionHelp}</p>
          </fieldset>
        )}

        {type === "classifier" && !agent ? (
          <LinesField path={["assign"]} labelText="Categories to assign" hidden={hidden.includes("assign")} />
        ) : null}

        {type === "extractor" ? (
          <>
            {agent ? (
              <TextField path={["prompt"]} labelText="Prompt" hidden={hidden.includes("prompt")} multiline help="What the Agent pulls out of each Item, in plain language." />
            ) : null}
            <FieldList hidden={hidden.includes("fields")} />
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
      </div>
    </EditingContext>
  );
}

function TextField({
  path,
  labelText,
  hidden,
  multiline = false,
  help,
}: {
  path: Path;
  labelText: string;
  hidden: boolean;
  multiline?: boolean;
  help?: string;
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
    <input id={id} type="text" value={text} onChange={onChange} className={fieldClass} {...described} />
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
      <Problems at={path} />
    </div>
  );
}

function LinesField({ path, labelText, hidden }: { path: Path; labelText: string; hidden: boolean }) {
  const { draft } = useEditing();
  const id = `rule-${pathKey(path)}`;
  const value = valueAt(draft, path);
  return (
    <div className="flex flex-col gap-2">
      {hidden ? null : (
        <>
          <label htmlFor={id} className={label}>
            {labelText}
          </label>
          <LinesBox id={id} path={path} list={isScalarList(value) ? value : []} helpId={`${id}-help`} />
          <p id={`${id}-help`} className="text-xs text-muted-foreground">
            One per line.
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
}: {
  id?: string;
  path: Path;
  list: (string | number)[];
  label?: string;
  problemsAt?: Path;
  helpId?: string;
}) {
  const { edit } = useEditing();
  const invalid = useInvalid(path, problemsAt);
  const text = list.join("\n");
  return (
    <textarea
      id={id}
      aria-label={ariaLabel}
      rows={3}
      spellCheck={false}
      value={text}
      onChange={(event) => { edit(path, fromLines(event.target.value)); }}
      onBlur={() => {
        // Only when there's something to tidy, because this turns numbers from the YAML into text.
        const tidied = fromLines(text, { tidy: true });
        if (tidied.join("\n") !== text) edit(path, tidied);
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
  const { edit, reshape } = useEditing();
  const fieldInvalid = useInvalid([...path, "field"], path);
  const opInvalid = useInvalid([...path, "op"], path);
  const fieldOptions = type === "extractor" ? [...contentFields, ...categoryField] : contentFields;
  return (
    <div data-path={pathKey(path)} className="flex flex-col gap-2">
      <div className="grid gap-2 sm:grid-cols-[9rem_9rem_minmax(0,1fr)] md:grid-cols-[9rem_9rem_minmax(0,1fr)_auto]">
        <Choice
          labelText="Field"
          value={node.field}
          options={fieldOptions}
          invalid={fieldInvalid}
          onChange={(next) => {
            edit([...path, "field"], next);
          }}
        />
        <Choice
          labelText="Operator"
          value={node.op}
          options={operators}
          invalid={opInvalid}
          onChange={(next) => {
            reshape(path, changeOp(node, next));
          }}
        />
        <PredicateValue path={path} node={node} />
        <div className="sm:col-span-3 md:col-span-1">
          <PartActions path={path} node={node} onRemove={onRemove} />
        </div>
      </div>
      <Problems at={path} />
    </div>
  );
}

function PredicateValue({ path, node }: { path: Path; node: Record<string, unknown> }) {
  const { edit } = useEditing();
  const valuePath = [...path, "value"];
  const invalid = useInvalid(valuePath, path);
  const { value } = node;
  const op = textOf(node.op);
  if (isScalarList(value)) {
    return <LinesBox path={valuePath} list={value} label="Values, one per line" problemsAt={path} />;
  }
  if (op === "exists" && value === undefined) return null;
  return (
    <input
      type="text"
      aria-label="Value"
      spellCheck={false}
      placeholder={valueHints[op]}
      list={node.field === "source" ? sourcesList : undefined}
      value={textOf(value)}
      onChange={(event) => {
        edit(valuePath, typedValue(op, value, event.target.value));
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

function FieldLabel({ text, children }: { text: string; children: React.ReactNode }) {
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
  part: "regex" | "jsonpath" | "agent";
  onRemove: () => void;
}) {
  const { edit, reshape } = useEditing();
  const nameInvalid = useInvalid([...path, "name"], path);
  const typeInvalid = useInvalid([...path, "type"], path);
  const fromInvalid = useInvalid([...path, "from"], path);
  const patternKey = part === "jsonpath" ? "jsonpath" : "regex";
  const patternPath = [...path, patternKey];
  const patternInvalid = useInvalid(patternPath, path);

  function readFrom(next: string) {
    if (next === "jsonpath") reshape(path, fieldReading(entry, "jsonpath"));
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
              <Choice labelText="Reads from" value={part === "jsonpath" ? "jsonpath" : entry.from} options={readsFrom} invalid={fromInvalid} onChange={readFrom} />
            </FieldLabel>
            <FieldLabel text={part === "jsonpath" ? "JSONPath" : "Regular expression"}>
              <input
                type="text"
                placeholder={part === "jsonpath" ? "$.categories[*].name" : "(CVE-\\d+-\\d+)"}
                spellCheck={false}
                value={textOf(entry[patternKey])}
                onChange={(event) => { edit(patternPath, event.target.value); }}
                className={cn(fieldClass, dataBox)}
                {...patternInvalid}
              />
            </FieldLabel>
          </>
        )}
      </div>
      {part === "agent" ? null : (
        <p className="text-xs text-muted-foreground">
          {part === "regex"
            ? "The field takes the first capture group, so the regex needs one."
            : "The path reads the Source's own payload for this Item."}
        </p>
      )}
      <Problems at={path} />
      <div>
        <SmallButton onClick={onRemove}>Remove</SmallButton>
      </div>
    </div>
  );
}

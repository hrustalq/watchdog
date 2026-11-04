"use client";

import { draftToYaml } from "@watchdog/core/rules/draft";
import { createContext, use, useMemo } from "react";
import { field as fieldClass, fieldError, label, textBox } from "@/components/field-classes";
import { Button } from "@/components/ui/button";
import {
  addPart,
  addTest,
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

/** The problems at this path and below it. */
function useProblems(path: Path) {
  const { problems } = useEditing();
  const key = pathKey(path);
  return problems.filter((problem) => isUnder(problem, key));
}

/** What a control says about the problems at its path, which the `Problems` block at `shownAt` holds. */
function useInvalid(path: Path, shownAt: Path = path) {
  const invalid = useProblems(path).length > 0;
  return { "aria-invalid": invalid, "aria-describedby": invalid ? `problems-${pathKey(shownAt)}` : undefined };
}

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
  const editing = useMemo<Editing>(
    () => ({
      draft,
      problems,
      edit: (path, value) => {
        onEdit(setAt(draft, path, value));
      },
      reshape: (path, value) => {
        onReshape(setAt(draft, path, value));
      },
      remove: (path) => {
        onReshape(removeAt(draft, path));
      },
    }),
    [draft, problems, onEdit, onReshape],
  );
  const conditionHelp =
    type === "classifier"
      ? "An Item that passes gets this Classifier's Categories. It can test Source and content."
      : "The rule runs on Items that meet this. It can test Categories, Source and content, not the Rating.";

  return (
    <EditingContext value={editing}>
      <div className="flex flex-col gap-6">
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
  const onChange = (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    edit(path, event.target.value);
  };
  const box = multiline ? (
    <textarea id={id} rows={5} value={text} onChange={onChange} className={cn(textBox, "py-2")} {...invalid} />
  ) : (
    <input id={id} type="text" value={text} onChange={onChange} className={fieldClass} {...invalid} />
  );
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className={label}>
        {labelText}
      </label>
      {hidden ? null : box}
      {help === undefined ? null : <p className="text-xs text-muted-foreground">{help}</p>}
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
      <label htmlFor={id} className={label}>
        {labelText}
      </label>
      {hidden ? null : <LinesBox id={id} path={path} list={isScalarList(value) ? value : []} />}
      <p className="text-xs text-muted-foreground">One per line.</p>
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
}: {
  id?: string;
  path: Path;
  list: (string | number)[];
  label?: string;
  problemsAt?: Path;
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
      className={cn(textBox, "py-1.5 font-mono text-[0.8125rem] sm:text-[0.8125rem]")}
      {...invalid}
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
    <div className="flex flex-col gap-2">
      <div className="grid gap-2 sm:grid-cols-[9rem_9rem_minmax(0,1fr)]">
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
      </div>
      <Problems at={path} />
      <PartActions path={path} node={node} onRemove={onRemove} />
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
      className={cn(fieldClass, "font-mono text-[0.8125rem] sm:text-[0.8125rem]")}
      {...invalid}
    />
  );
}

/** What can be done to any part of a Condition. */
function PartActions({ path, node, onRemove }: Pick<PartProps, "path" | "onRemove"> & { node: unknown }) {
  const { reshape } = useEditing();
  return (
    <div className="flex flex-wrap items-center gap-1">
      {onRemove === undefined && conditionPart(node) === "predicate" ? (
        <SmallButton onClick={() => { reshape(path, addTest(node)); }}>Add a test</SmallButton>
      ) : null}
      <SmallButton onClick={() => { reshape(path, negate(node)); }}>
        {conditionPart(node) === "not" ? "Remove not" : "Not"}
      </SmallButton>
      {onRemove === undefined ? null : <SmallButton onClick={onRemove}>Remove</SmallButton>}
    </div>
  );
}

function NotPart({ path, node, type, onRemove }: PartProps & { node: unknown }) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border p-3">
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
    <div className="flex flex-col gap-3 rounded-lg border p-3">
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
        return <ConditionPart key={pathKey(childPath)} path={childPath} type={type} onRemove={() => { remove(childPath); }} />;
      })}
      <div className="flex flex-wrap items-center gap-1">
        <SmallButton onClick={() => { reshape(path, addTest(node)); }}>Add a test</SmallButton>
        <SmallButton onClick={() => { reshape(path, addPart(node, { any: [blankTest] })); }}>Add a group</SmallButton>
        <SmallButton onClick={() => { reshape(path, negate(node)); }}>Not</SmallButton>
        {onRemove === undefined ? null : <SmallButton onClick={onRemove}>Remove</SmallButton>}
      </div>
    </div>
  );
}

/** A part of the rule the form has no controls for: shown as it is, and kept. */
function YamlOnly({ path, value, removeLabel, onRemove }: { path: Path; value: unknown; removeLabel: string; onRemove: () => void }) {
  return (
    <div className="flex flex-col gap-2 rounded-lg bg-muted p-3">
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
    <fieldset className="flex min-w-0 flex-col gap-3">
      <legend className={cn(label, "mb-2")}>Fields</legend>
      <Problems at={["fields"]} exact />
      {hidden
        ? null
        : fields.map((entry, index) => {
            const path = ["fields", index];
            const onRemove = () => { remove(path); };
            const part = fieldPart(entry, kind);
            return part === "yaml-only" || !isMap(entry) ? (
              <YamlOnly key={pathKey(path)} path={path} value={entry} removeLabel="Remove" onRemove={onRemove} />
            ) : (
              <FieldRow key={pathKey(path)} path={path} entry={entry} part={part} onRemove={onRemove} />
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
    <div className="flex flex-col gap-2 rounded-lg border p-3">
      <div className="grid gap-2 sm:grid-cols-2">
        <input
          type="text"
          aria-label="Field name"
          placeholder="Field name, such as cve"
          spellCheck={false}
          value={textOf(entry.name)}
          onChange={(event) => { edit([...path, "name"], event.target.value); }}
          className={cn(fieldClass, "font-mono text-[0.8125rem] sm:text-[0.8125rem]")}
          {...nameInvalid}
        />
        <Choice labelText="Type" value={entry.type} options={part === "regex" ? singleTypes : allTypes} invalid={typeInvalid} onChange={(next) => { edit([...path, "type"], next); }} />
        {part === "agent" ? null : (
          <>
            <Choice labelText="Reads from" value={part === "jsonpath" ? "jsonpath" : entry.from} options={readsFrom} invalid={fromInvalid} onChange={readFrom} />
            <input
              type="text"
              aria-label={part === "jsonpath" ? "JSONPath" : "Regular expression"}
              placeholder={part === "jsonpath" ? "$.categories[*].name" : "With one capture group, such as (CVE-\\d+-\\d+)"}
              spellCheck={false}
              value={textOf(entry[patternKey])}
              onChange={(event) => { edit(patternPath, event.target.value); }}
              className={cn(fieldClass, "font-mono text-[0.8125rem] sm:text-[0.8125rem]")}
              {...patternInvalid}
            />
          </>
        )}
      </div>
      <Problems at={path} />
      <div>
        <SmallButton onClick={onRemove}>Remove</SmallButton>
      </div>
    </div>
  );
}

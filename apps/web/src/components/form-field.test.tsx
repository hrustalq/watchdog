import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CheckboxField, SelectField, TextField } from "./form-field.tsx";

describe("TextField", () => {
  it("points its label at the box and its hint at the help line", () => {
    const html = renderToStaticMarkup(<TextField id="name" label="Name" help="Actions refer to it by this name." />);
    expect(html).toContain('for="name"');
    expect(html).toContain('id="name"');
    expect(html).toContain('name="name"');
    expect(html).toContain('aria-describedby="name-help"');
    expect(html).toContain('id="name-help"');
    expect(html).toContain('aria-invalid="false"');
  });

  it("turns a refusal into one error the box points at, and takes focus there", () => {
    const html = renderToStaticMarkup(
      <TextField id="url" label="URL" type="url" error="Enter a full URL." help="The receiver's address." />,
    );
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('aria-describedby="url-error"');
    expect(html).toContain('role="alert"');
    expect(html).toContain("Enter a full URL.");
    expect(html).toContain("autofocus");
    expect(html).not.toContain("The receiver");
  });

  it("keeps the hint beside a refusal where the hint is the example to fix it with", () => {
    const html = renderToStaticMarkup(
      <TextField id="base-url" label="Base URL" error="Enter a URL." help="Include the version." showHelpWithError />,
    );
    expect(html).toContain('aria-describedby="base-url-error base-url-help"');
    expect(html).toContain("Include the version.");
  });

  it("does not take focus from a form that focuses its own first problem", () => {
    const html = renderToStaticMarkup(<TextField id="name" label="Name" error="Enter it." focusOnError={false} />);
    expect(html).not.toContain("autofocus");
  });

  it("marks an optional field in the label, not the placeholder", () => {
    const html = renderToStaticMarkup(<TextField id="name" label="Name" optional />);
    expect(html).toContain("(optional)");
  });

  it("lets a caller size the control without touching the field column", () => {
    const html = renderToStaticMarkup(<TextField id="q" label="Query" className="flex" controlClassName="sm:max-w-xs" />);
    expect(html).toContain("sm:max-w-xs");
    expect(html).toContain("flex");
  });
});

describe("SelectField", () => {
  it("renders a native select with the kit's chevron and a real label", () => {
    const html = renderToStaticMarkup(
      <SelectField id="schedule" label="Schedule">
        <option value="hourly">Every hour</option>
      </SelectField>,
    );
    expect(html).toContain("<select");
    expect(html).toContain('for="schedule"');
    expect(html).toContain("Every hour");
  });
});

describe("CheckboxField", () => {
  it("makes the whole label the box's target and describes it with its help", () => {
    const html = renderToStaticMarkup(
      <CheckboxField id="quiet-hours" label="Hold alerts during quiet hours" help="Alerts wait, never drop." />,
    );
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('id="quiet-hours"');
    expect(html).toContain('for="quiet-hours"');
    expect(html).toContain('aria-describedby="quiet-hours-help"');
    expect(html).toContain("Hold alerts during quiet hours");
  });
});

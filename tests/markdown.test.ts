import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "../apps/web/app/markdown.js";

const html = (text: string) =>
  renderToStaticMarkup(createElement(Markdown, { text }));

describe("answer Markdown", () => {
  it("renders bold, italic, code and lists", () => {
    expect(
      html(
        "**Update vendor reconciliation** before *Friday*:\n\n- check `cost center`\n- tell Birgit\n\n1. one\n2. two",
      ),
    ).toBe(
      "<p><strong>Update vendor reconciliation</strong> before <em>Friday</em>:</p><ul><li>check <code>cost center</code></li><li>tell Birgit</li></ul><ol><li>one</li><li>two</li></ol>",
    );
  });
  it("never interprets HTML and leaves snake_case and lone stars alone", () => {
    expect(html("<img src=x onerror=alert(1)> a_b_c 2 * 3 * 4")).toBe(
      "<p>&lt;img src=x onerror=alert(1)&gt; a_b_c 2 * 3 * 4</p>",
    );
  });
});

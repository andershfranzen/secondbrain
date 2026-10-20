import { test, expect, type BrowserContext } from "@playwright/test";
let sessionCookies: Awaited<ReturnType<BrowserContext["cookies"]>> | undefined;
/** Waits for the newest turn's agent reply to finish. */
async function lastTurn(page: any, text: string) {
  const turn = page.locator(".chat-turn").last();
  await expect(turn.locator(".user-message")).toHaveText(text);
  await expect(turn.locator('[data-pending="true"]')).toHaveCount(0, {
    timeout: 20000,
  });
  return turn;
}
async function send(page: any, text: string) {
  await page.getByLabel("Write or ask").fill(text);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  return lastTurn(page, text);
}
async function menu(page: any, name: string) {
  await page.getByLabel("Open menu").click();
  await page.getByRole("button", { name, exact: true }).click();
}
async function signIn(page: any) {
  if (sessionCookies) {
    await page.context().addCookies(sessionCookies);
    await page.goto("/");
    await expect(page.getByLabel("Write or ask")).toBeVisible();
    return;
  }
  await page.goto("/");
  await page
    .getByLabel("Password", { exact: true })
    .fill("e2e-preview-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByLabel("Write or ask")).toBeVisible();
  sessionCookies = await page.context().cookies();
}
test("capture, retrieve, inspect source and correct a memory", async ({
  page,
}, info) => {
  const prefix = `${info.project.name}-${Date.now()}`;
  const text = `${prefix}: Forgejo is installed on the home server.`;
  await signIn(page);
  const saved = await send(page, text);
  await expect(
    saved.getByRole("status").filter({ hasText: "Saved" }),
  ).toBeVisible();
  await expect(saved.locator(".action-row")).toContainText(prefix, {
    ignoreCase: true,
  });
  await expect(page.getByLabel("Write or ask")).toHaveValue("");
  const found = await send(page, "Find " + prefix);
  const claim = found.locator(".answer-claims li").filter({ hasText: text });
  await expect(claim).toBeVisible();
  await claim.getByRole("button", { name: "Source" }).click();
  await expect(
    page.getByRole("heading", { name: "Source", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".source-text")).toContainText(text);
  await menu(page, "Records");
  await page.getByLabel("Record type").selectOption("memory");
  await expect(
    page.locator(".capture-row:visible").filter({ hasText: prefix }),
  ).toBeVisible({ timeout: 30000 });
  await page
    .locator(".capture-row:visible")
    .filter({ hasText: prefix })
    .click();
  await page.getByRole("button", { name: "I changed my mind" }).click();
  await page
    .getByLabel("Current assertion")
    .fill(`${prefix}: Forgejo has been moved to the backup server.`);
  await page
    .getByLabel("Reason", { exact: true })
    .fill("Updated the deployment.");
  await page.getByRole("button", { name: "Save correction" }).click();
  await expect(page.locator(".source-text")).toContainText("backup server");
  await page.getByRole("button", { name: "Second Brain", exact: true }).click();
  const after = await send(page, `Find ${prefix} backup server`);
  await expect(
    after
      .locator(".answer-claims li")
      .filter({ hasText: "backup server" })
      .first(),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
test("records a deferred commitment and lists it when asked what is outstanding", async ({
  page,
}, info) => {
  const tag = `${info.project.name}-${Date.now()}`;
  const dump = `Mette asked me to build the ${tag} dashboard next month, and I said yes.`;
  await signIn(page);
  const saved = await send(page, dump);
  const row = saved.locator(".action-row").filter({ hasText: tag });
  await expect(row).toContainText("Commitment");
  await expect(row).toContainText("for Mette, next month");
  const answer = await send(page, "What do I have outstanding?");
  await expect(
    answer.locator(".answer-claims li").filter({ hasText: tag }),
  ).toContainText("for Mette");
  await menu(page, "Records");
  await expect(
    page.locator(".capture-row:visible").filter({ hasText: tag }),
  ).toContainText("for Mette · next month");
});
test("undoes what a message recorded with one tap", async ({ page }, info) => {
  const tag = `${info.project.name}-${Date.now()}`;
  await signIn(page);
  const saved = await send(
    page,
    `Jonas asked me to review the ${tag} rollout plan.`,
  );
  await expect(
    saved.locator(".action-row").filter({ hasText: tag }),
  ).toBeVisible();
  await saved.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(saved.locator(".message-status")).toHaveText("Saved · undone");
  await expect(saved.locator(".action-row")).toHaveCount(0);
  await menu(page, "Records");
  await expect(
    page.locator(".capture-row:visible").filter({ hasText: tag }),
  ).toHaveCount(0);
});
test("keeps follow-up messages in the same durable conversation", async ({
  page,
}) => {
  await signIn(page);
  const post = async (text: string) => {
    const response = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/v1/messages") && r.request().method() === "POST",
    );
    await send(page, text);
    return (await response).json();
  };
  const first = await post("Find my home server notes");
  const second = await post("What was the blocker?");
  expect(second.conversationId).toBe(first.conversationId);
  const saved = await (
    await page.request.get(`/api/v1/conversations/${first.conversationId}`)
  ).json();
  expect(saved.messages.map((m: any) => m.role)).toEqual([
    "user",
    "assistant",
    "user",
    "assistant",
  ]);
  expect(saved.messages[2].content).toBe("What was the blocker?");
  expect(saved.turns).toHaveLength(2);
});
test("preserves an unsaved draft when switching views; creates and archives a project", async ({
  page,
}, info) => {
  await signIn(page);
  await page.getByLabel("Write or ask").fill("A draft that is not saved yet.");
  await menu(page, "Settings");
  await page.getByRole("button", { name: "Second Brain", exact: true }).click();
  await expect(page.getByLabel("Write or ask")).toHaveValue(
    "A draft that is not saved yet.",
  );
  await menu(page, "Records");
  await page.getByRole("button", { name: "Manage projects" }).click();
  await page.getByRole("button", { name: "New project", exact: true }).click();
  const title = `Project ${info.project.name}-${Date.now()}`;
  await page.getByLabel("Project name").fill(title);
  await page
    .getByLabel("What is this about?")
    .fill("Run PostgreSQL and Forgejo at home.");
  await page
    .getByRole("button", { name: "Create project", exact: true })
    .click();
  await page.locator(".project-card").filter({ hasText: title }).click();
  await page.getByRole("button", { name: "Archive", exact: true }).click();
  await expect(page.locator(".detail-toolbar")).toContainText("archived");
});
test("has a valid install manifest and does not cache private API responses", async ({
  page,
}) => {
  await signIn(page);
  const manifest = await (
    await page.request.get("/manifest.webmanifest")
  ).json();
  expect(manifest.display).toBe("standalone");
  for (const icon of manifest.icons) {
    const response = await page.request.get(icon.src);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("image/png");
  }
  const me = await page.request.get("/api/v1/me");
  expect(me.headers()["cache-control"]).toBe("no-store");
  const keys = await page.evaluate(async () => {
    const stores = await caches.keys();
    return (
      await Promise.all(
        stores.map(async (key) =>
          (await (await caches.open(key)).keys()).map((r) => r.url),
        ),
      )
    ).flat();
  });
  expect(keys.filter((url) => url.includes("/api/"))).toEqual([]);
});

test("opens with only one composer and restores saved conversations in place", async ({
  page,
}) => {
  await signIn(page);
  await expect(
    page.getByRole("navigation", { name: "Main navigation" }),
  ).toHaveCount(0);
  await expect(page.locator(".chat-timeline")).toBeEmpty();
  await expect(
    page.getByRole("heading", { name: "Recent", exact: true }),
  ).toHaveCount(0);
  const box = await page.getByLabel("Write or ask").boundingBox();
  expect(box!.y).toBeGreaterThan(120);
  const text = "Remember that my test notebook lives beside the home server.";
  await send(page, text);
  await page.reload();
  await expect(page.getByLabel("Write or ask")).toBeVisible();
  await expect(page.locator(".chat-timeline")).toBeEmpty();
  await menu(page, "Earlier conversations");
  await page.locator(".past-heading").filter({ hasText: text }).first().click();
  await expect(page.locator(".past-body")).toContainText(text);
});

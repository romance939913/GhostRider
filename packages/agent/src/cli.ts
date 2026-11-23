import { parseArgs } from "node:util";
import { launchBrowser } from "./browser.js";
import { AnthropicLlm, DEFAULT_ANTHROPIC_MODEL } from "./llm/anthropic.js";
import { observe } from "./observe.js";
import { DEFAULT_SNAPSHOT_BUDGET_CHARS } from "./snapshot.js";

const USAGE = `Usage: pnpm --filter @ghostrider/agent record --url <url> [options]

Without --goal, prints the page's (compacted) accessibility snapshot.
With --goal, asks the model for the first action and prints it (nothing is
executed yet; the full agent loop is M1 step 6).

Options:
  --url       Page to start on (http or https). Required.
  --goal      The journey in plain English.
  --secret    name=value, repeatable. The model only sees {{secrets.name}}.
  --model     Anthropic model (default ${DEFAULT_ANTHROPIC_MODEL}).
  --budget    Max snapshot size in characters (default ${DEFAULT_SNAPSHOT_BUDGET_CHARS}).
  --headed    Show the browser window.
  -h, --help  Show this message.`;

interface CliArgs {
  url: string;
  goal: string | undefined;
  secrets: Record<string, string>;
  model: string;
  budgetChars: number;
  headed: boolean;
}

function parseCliArgs(argv: string[]): CliArgs | { error: string } | "help" {
  let values: {
    url?: string;
    goal?: string;
    secret?: string[];
    model?: string;
    budget?: string;
    headed?: boolean;
    help?: boolean;
  };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        url: { type: "string" },
        goal: { type: "string" },
        secret: { type: "string", multiple: true },
        model: { type: "string" },
        budget: { type: "string" },
        headed: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      // pnpm can forward a bare "--"; ignore positionals instead of failing.
      allowPositionals: true,
      strict: true,
    }));
  } catch (error) {
    return { error: (error as Error).message };
  }

  if (values.help) return "help";
  if (!values.url) return { error: "--url is required" };

  let parsed: URL;
  try {
    parsed = new URL(values.url);
  } catch {
    return { error: `Not a valid URL: ${values.url}` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { error: `URL must be http or https, got ${parsed.protocol}` };
  }

  const budgetChars =
    values.budget === undefined
      ? DEFAULT_SNAPSHOT_BUDGET_CHARS
      : Number(values.budget);
  if (!Number.isInteger(budgetChars) || budgetChars <= 0) {
    return {
      error: `--budget must be a positive integer, got ${values.budget}`,
    };
  }

  const secrets: Record<string, string> = {};
  for (const pair of values.secret ?? []) {
    const match = /^([A-Za-z0-9_]+)=(.*)$/s.exec(pair);
    if (!match?.[1] || match[2] === undefined) {
      return { error: "--secret must look like name=value (name: A-Z, 0-9, _)" };
    }
    secrets[match[1]] = match[2];
  }

  return {
    url: parsed.href,
    goal: values.goal,
    secrets,
    model: values.model ?? DEFAULT_ANTHROPIC_MODEL,
    budgetChars,
    headed: values.headed ?? false,
  };
}

async function main(): Promise<number> {
  const args = parseCliArgs(process.argv.slice(2));

  if (args === "help") {
    console.log(USAGE);
    return 0;
  }
  if ("error" in args) {
    console.error(`Error: ${args.error}\n\n${USAGE}`);
    return 1;
  }
  if (args.goal && !process.env.ANTHROPIC_API_KEY) {
    console.error("Error: --goal needs ANTHROPIC_API_KEY (set it in .env).");
    return 1;
  }

  const session = await launchBrowser({ headed: args.headed });
  try {
    await session.page.goto(args.url, { waitUntil: "domcontentloaded" });
    const observation = await observe(session.page, {
      budgetChars: args.budgetChars,
      secrets: args.secrets,
    });

    console.log(`URL:   ${observation.url}`);
    console.log(`Title: ${observation.title}`);
    const compacted = observation.truncated
      ? ` → ${observation.snapshot.length} chars (compacted)`
      : "";
    console.log(`Snapshot: ${observation.snapshotChars} chars${compacted}`);

    if (!args.goal) {
      console.log(`\n${observation.snapshot}`);
      return 0;
    }

    const llm = new AnthropicLlm({ model: args.model });
    const startedAt = performance.now();
    const result = await llm.nextAction({
      goal: args.goal,
      startUrl: args.url,
      observation,
      history: [],
      secretNames: Object.keys(args.secrets),
    });
    const seconds = ((performance.now() - startedAt) / 1000).toFixed(1);
    const cost =
      result.costUsd === undefined ? "?" : `$${result.costUsd.toFixed(4)}`;

    console.log(`\nGoal:  ${args.goal}`);
    console.log(
      `Model: ${llm.model} · ${result.usage.inputTokens} in / ${result.usage.outputTokens} out · ${cost} · ${seconds}s\n`,
    );
    if (!result.ok) {
      console.error(`${result.error.code}: ${result.error.message}`);
      return 1;
    }
    console.log(`Intent:  ${result.decision.intent}`);
    console.log(`Thought: ${result.decision.thought}`);
    console.log(`Action:  ${JSON.stringify(result.decision.action)}`);
    return 0;
  } catch (error) {
    console.error(`Failed on ${args.url}:`, error);
    return 1;
  } finally {
    await session.close();
  }
}

process.exitCode = await main();

import { parseArgs } from "node:util";
import { launchBrowser } from "./browser.js";
import { observe } from "./observe.js";
import { DEFAULT_SNAPSHOT_BUDGET_CHARS } from "./snapshot.js";

const USAGE = `Usage: pnpm --filter @ghostrider/agent record --url <url> [--goal "<english goal>"] [--headed] [--budget <chars>]

Options:
  --url      Page to start the journey on (http or https). Required.
  --goal     The journey in plain English. Not used yet (M1 step 6).
  --headed   Show the browser window.
  --budget   Max snapshot size in characters (default ${DEFAULT_SNAPSHOT_BUDGET_CHARS}).
  -h, --help Show this message.`;

interface CliArgs {
  url: string;
  goal: string | undefined;
  headed: boolean;
  budgetChars: number;
}

function parseCliArgs(argv: string[]): CliArgs | { error: string } | "help" {
  let values: {
    url?: string;
    goal?: string;
    headed?: boolean;
    budget?: string;
    help?: boolean;
  };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        url: { type: "string" },
        goal: { type: "string" },
        headed: { type: "boolean", default: false },
        budget: { type: "string" },
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

  const budgetChars = values.budget === undefined ? DEFAULT_SNAPSHOT_BUDGET_CHARS : Number(values.budget);
  if (!Number.isInteger(budgetChars) || budgetChars <= 0) {
    return { error: `--budget must be a positive integer, got ${values.budget}` };
  }

  return {
    url: parsed.href,
    goal: values.goal,
    headed: values.headed ?? false,
    budgetChars,
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

  const session = await launchBrowser({ headed: args.headed });
  try {
    await session.page.goto(args.url, { waitUntil: "domcontentloaded" });
    const observation = await observe(session.page, {
      budgetChars: args.budgetChars,
    });

    console.log(`URL:   ${observation.url}`);
    console.log(`Title: ${observation.title}`);
    if (args.goal) console.log(`Goal:  ${args.goal}`);
    const compacted = observation.truncated ? ` → ${observation.snapshot.length} chars (compacted)` : "";
    console.log(`Snapshot: ${observation.snapshotChars} chars${compacted}\n`);
    console.log(observation.snapshot);
    return 0;
  } catch (error) {
    console.error(`Failed to observe ${args.url}:`, error);
    return 1;
  } finally {
    await session.close();
  }
}

process.exitCode = await main();

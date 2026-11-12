import { parseArgs } from "node:util";
import { launchBrowser } from "./browser.js";
import { observe } from "./observe.js";

const USAGE = `Usage: pnpm --filter @ghostrider/agent record --url <url> [--goal "<english goal>"] [--headed]

Options:
  --url      Page to start the journey on (http or https). Required.
  --goal     The journey in plain English. Not used yet (M1 step 6).
  --headed   Show the browser window.
  -h, --help Show this message.`;

interface CliArgs {
  url: string;
  goal: string | undefined;
  headed: boolean;
}

function parseCliArgs(argv: string[]): CliArgs | { error: string } | "help" {
  let values: { url?: string; goal?: string; headed?: boolean; help?: boolean };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        url: { type: "string" },
        goal: { type: "string" },
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

  return {
    url: parsed.href,
    goal: values.goal,
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

  const session = await launchBrowser({ headed: args.headed });
  try {
    await session.page.goto(args.url, { waitUntil: "domcontentloaded" });
    const observation = await observe(session.page);

    console.log(`URL:   ${observation.url}`);
    console.log(`Title: ${observation.title}`);
    if (args.goal) console.log(`Goal:  ${args.goal}`);
    console.log(`Snapshot: ${observation.snapshotChars} chars\n`);
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

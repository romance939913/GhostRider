import { connection } from "next/server";
import { getHealth, type HealthResult } from "../lib/health";

export default async function HealthPage() {
  // Opt into per-request rendering so the API is never called at build time.
  await connection();
  const result = await getHealth();

  return (
    <main>
      <h1>GhostRider</h1>
      <HealthView result={result} />
      <p>
        <a href="/">Refresh</a>
      </p>
    </main>
  );
}

function StatusText({ value }: { value: string }) {
  const good = value === "ok";
  return (
    <strong style={{ color: good ? "seagreen" : "crimson" }}>{value}</strong>
  );
}

function HealthView({ result }: { result: HealthResult }) {
  switch (result.kind) {
    case "unreachable":
      return (
        <section>
          <h2>
            API <StatusText value="unreachable" />
          </h2>
          <p>{result.error}</p>
        </section>
      );
    case "invalid":
      return (
        <section>
          <h2>
            API <StatusText value="invalid response" />
          </h2>
          <p>{result.error}</p>
        </section>
      );
    case "reachable": {
      const { health } = result;
      return (
        <section>
          <h2>
            API <StatusText value={health.status} />
          </h2>
          <table>
            <tbody>
              {Object.entries(health.checks).map(([name, status]) => (
                <tr key={name}>
                  <th
                    scope="row"
                    style={{ textAlign: "left", paddingRight: 16 }}
                  >
                    {name}
                  </th>
                  <td>
                    <StatusText value={status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p>
            Version {health.version} · checked{" "}
            <time dateTime={health.timestamp}>{health.timestamp}</time>
          </p>
        </section>
      );
    }
  }
}

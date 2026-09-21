// Runs a query on DATABASE_URL and prints the rows separated by "|", like `psql -At`.
// Lets the test scripts avoid depending on an installed psql or on a container by name.
import pg from "pg";
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
const r = await c.query(process.argv[2]);
for (const row of r.rows) console.log(Object.values(row).join("|"));
await c.end();

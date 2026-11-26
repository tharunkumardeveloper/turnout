// Exits unless DATABASE_URL points at a database that answers (a TCP connect is enough for the sample).
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('Error: DATABASE_URL is not set');
  process.exit(1);
}
const { hostname, port } = new URL(url);
require('net').connect(Number(port) || 5432, hostname)
  .on('connect', function () { this.end(); require('./server.js'); })
  .on('error', (e) => { console.error("Error: can't reach the database at DATABASE_URL (" + e.message + ')'); process.exit(1); });

if (!process.env.SECRET_KEY) {
  console.error('Error: SECRET_KEY is not set');
  process.exit(1);
}
const http = require('http');
const port = Number(process.env.PORT) || 3000;
http.createServer((q, r) => {
  if (q.method === 'POST' && q.url === '/signup') return r.writeHead(303, { location: '/' }).end();
  r.writeHead(200, { 'content-type': 'text/html' }).end(q.url === '/about' ? '<h1>About</h1>' : '<!doctype html><title>Sample</title><h1>Sample app</h1><p><a href="/about">About</a></p><form method="post" action="/signup"><input name="email" type="email" value="a@b.c"><button>Sign up</button></form>');
}).listen(port, () => console.log('listening on port ' + port));

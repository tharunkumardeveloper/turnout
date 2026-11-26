const express = require('express');
const app = express();
app.get('/', (_q, r) => r.send('<!doctype html><title>Sample</title><h1>Sample app</h1><p><a href="/about">About</a></p><form method="post" action="/signup"><input name="email" type="email" value="a@b.c"><button>Sign up</button></form>'));
app.get('/about', (_q, r) => r.send('<h1>About</h1>'));
app.post('/signup', (_q, r) => r.redirect(303, '/'));
app.listen(3000, () => console.log('listening on port 3000'));

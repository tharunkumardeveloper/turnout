import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { databaseFor, generatedDockerfile, missingSettings, tarAppend, tarIndex, wantsDatabase } from '../src/tryit/autobuild.ts';

const none = () => null;

test('a Node app with a start script runs npm start', () => {
  const d = generatedDockerfile(['package.json', 'server.js'], () => '{"scripts":{"start":"node server.js"}}')!;
  assert.match(d, /FROM node:22-alpine/);
  assert.match(d, /CMD \["npm", "start"\]/);
});

test('a Node project with only a build script is served as a static site', () => {
  const d = generatedDockerfile(['package.json'], () => '{"scripts":{"build":"vite build"}}')!;
  assert.match(d, /nginx/);
  assert.match(d, /for d in dist build out public/);
});

test('Python, Go, PHP and plain HTML each get their own', () => {
  assert.match(generatedDockerfile(['requirements.txt', 'app.py'], () => 'flask==3')!, /flask", "--app", "app"/);
  assert.match(generatedDockerfile(['requirements.txt', 'manage.py'], () => 'django')!, /manage.py migrate --noinput && exec python manage.py runserver/);
  assert.match(generatedDockerfile(['go.mod', 'main.go'], none)!, /golang/);
  assert.match(generatedDockerfile(['index.php'], none)!, /php:8.4-apache/);
  assert.match(generatedDockerfile(['index.html', 'style.css'], none)!, /nginx/);
  assert.equal(generatedDockerfile(['notes.txt'], none), null);
});

test('settings named in an error', () => {
  assert.deepEqual(missingSettings('Error: SECRET_KEY is not set'), ['SECRET_KEY']);
  assert.deepEqual(missingSettings("KeyError: 'STRIPE_KEY'"), ['STRIPE_KEY']);
  assert.deepEqual(missingSettings('Error: DATABASE_URL is not set'), ['DATABASE_URL']);
  assert.deepEqual(missingSettings('missing environment variable API_TOKEN'), ['API_TOKEN']);
  assert.deepEqual(missingSettings('listening on port 3000'), []);
});

test('a database when the settings point at one', () => {
  assert.equal(wantsDatabase(['DATABASE_URL']), 'postgres');
  assert.equal(wantsDatabase(['MYSQL_HOST']), 'mysql');
  assert.equal(wantsDatabase(['SECRET_KEY']), null);
  assert.equal(wantsDatabase([], 'connect ECONNREFUSED 127.0.0.1:5432'), 'postgres');
  assert.match(databaseFor('postgres').appEnv[0]!, /^DATABASE_URL=postgres:\/\/.*@try-db:5432/);
});

test('a tar is read and added to without unpacking it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tn-tar-'));
  const file = join(dir, 'a.tar');
  writeFileSync(file, Buffer.alloc(1024));
  tarAppend(file, 'package.json', '{"name":"x"}');
  tarAppend(file, 'Dockerfile.turnout', 'FROM node\n');
  const { files, read } = tarIndex(readFileSync(file));
  assert.deepEqual(files, ['package.json', 'Dockerfile.turnout']);
  assert.equal(read('package.json'), '{"name":"x"}');
  assert.equal(read('Dockerfile.turnout'), 'FROM node\n');
});

test('the running site is walked once and only actions every version has are offered', async () => {
  const { walk, common, describeAction } = await import('../src/tryit/discover.ts');
  const pages: Record<string, string> = {
    '/': '<a href="/about">About</a><form method="post" action="/signup"></form>',
    '/about': '<a href="/cv.pdf">CV</a><a href="/gone">Gone</a>',
    '/cv.pdf': '%PDF',
  };
  const fake = (async (u: URL) => new Response(pages[u.pathname] ?? 'nope', { status: pages[u.pathname] ? 200 : 404, headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch;
  const goals = await walk('http://x', 8, fake);
  assert.deepEqual(goals, ['POST /signup', 'GET /about*', 'GET /cv.pdf']);
  assert.deepEqual(common([goals, ['GET /cv.pdf', 'POST /signup']]), ['POST /signup', 'GET /cv.pdf']);
  assert.equal(describeAction('POST /signup'), 'sends the form to /signup');
  assert.equal(describeAction('GET /cv.pdf'), 'downloads cv.pdf');
});

test('a Node app with no start script runs the entry file that is there, not npm\'s default main', () => {
  // docker/getting-started-app: "main": "index.js", but the code is src/index.js and "dev" runs nodemon on it.
  const pkg = JSON.stringify({ main: 'index.js', scripts: { dev: 'nodemon -L src/index.js' } });
  assert.match(generatedDockerfile(['package.json', 'src/index.js'], () => pkg)!, /CMD \["node", "src\/index.js"\]/);
  assert.match(generatedDockerfile(['package.json', 'index.js'], () => pkg)!, /CMD \["node", "index.js"\]/);
});

test('Go builds with a Go new enough for its go.mod and keeps the files it reads at run time', () => {
  const d = generatedDockerfile(['go.mod', 'main.go', 'templates/index.tmpl'], none)!;
  assert.match(d, /FROM golang:alpine/);
  assert.match(d, /GOTOOLCHAIN=auto/);
  assert.match(d, /COPY --from=build \/src \/srv/);
});

test('a database is recognised from how each client says it was refused, Mongo included', () => {
  // render-examples/django (psycopg), heroku/ruby-getting-started (Rails), bradtraversy/nodekb (Mongoose).
  assert.equal(wantsDatabase([], 'psycopg.OperationalError: connection failed: connection to server at "127.0.0.1", port 5432 failed: Connection refused'), 'postgres');
  assert.equal(wantsDatabase([], 'PG::ConnectionBad: could not connect to server'), 'postgres');
  assert.equal(wantsDatabase([], "Mysql2::Error::ConnectionError: Can't connect to MySQL server on 'localhost'"), 'mysql');
  assert.equal(wantsDatabase([], 'MongooseError: The `uri` parameter to `openUri()` must be a string, got "undefined"'), 'mongo');
  assert.equal(wantsDatabase([], 'MongooseServerSelectionError: connect ECONNREFUSED 127.0.0.1:27017'), 'mongo');
  assert.equal(wantsDatabase(['MONGODB_URI']), 'mongo');
  assert.equal(wantsDatabase([], 'Error: listen EADDRINUSE :::3000'), null);
  assert.ok(databaseFor('mongo').appEnv.includes('MONGODB_URI=mongodb://try-db:27017/app'));
});

test('Ruby: Rails prepares its database and serves on 3000; gems with native parts can build', () => {
  const rails = generatedDockerfile(['Gemfile', 'bin/rails', 'config.ru'], none)!;
  assert.match(rails, /FROM ruby:3\.4\n/);
  assert.match(rails, /ruby bin\/rails db:prepare && exec ruby bin\/rails server -b 0.0.0.0 -p 3000/);
  assert.match(generatedDockerfile(['Gemfile', 'config.ru'], none)!, /rackup/);
});

test('PHP serves the folder its front controller is in, with Composer packages; Django collects static files', () => {
  // heroku/php-getting-started: "web: heroku-php-apache2 web/", Slim through Composer.
  const php = generatedDockerfile(['composer.json', 'Procfile', 'web/index.php'], (p) => (p === 'Procfile' ? 'web: heroku-php-apache2 web/\n' : '{}'))!;
  assert.match(php, /APACHE_DOCUMENT_ROOT=\/var\/www\/html\/web/);
  assert.match(php, /composer install --no-dev/);
  assert.match(generatedDockerfile(['composer.json', 'public/index.php'], () => '{}')!, /html\/public/);
  assert.doesNotMatch(generatedDockerfile(['index.php'], none)!, /APACHE_DOCUMENT_ROOT|composer/);
  // heroku/python-getting-started: WhiteNoise's manifest storage answers 500 until collectstatic has run.
  assert.match(generatedDockerfile(['requirements.txt', 'manage.py'], () => 'django\nwhitenoise')!, /collectstatic --noinput/);
});

test('SvelteKit on Node, a static build in any folder, Java with Maven, and the Python a project pins', () => {
  // render-examples/sveltekit: adapter-node, "build": "vite build", no start script.
  const svelte = generatedDockerfile(['package.json', 'svelte.config.js'], () => JSON.stringify({ scripts: { build: 'vite build' }, devDependencies: { '@sveltejs/adapter-node': '^5' } }))!;
  assert.match(svelte, /CMD \["node", "build"\]/);
  // heroku/java-getting-started: Maven wrapper, Java 17 in system.properties.
  const java = generatedDockerfile(['pom.xml', 'mvnw', 'system.properties'], (p) => (p === 'system.properties' ? 'java.runtime.version=17\n' : '<java.version>17</java.version>'))!;
  assert.match(java, /FROM maven:3-eclipse-temurin-17 AS build/);
  assert.match(java, /mvn -q -B -DskipTests package/);
  assert.match(java, /FROM eclipse-temurin:17-jre/);
  // digitalocean/sample-django: psycopg2 from source; runtime.txt asks for 3.10.
  const py = generatedDockerfile(['requirements.txt', 'manage.py', 'runtime.txt'], (p) => (p === 'runtime.txt' ? 'python-3.10.4\n' : 'Django==4.0.3\npsycopg2-binary==2.9.3\n'))!;
  assert.match(py, /FROM python:3\.10-slim/);
  assert.match(py, /libpq-dev/);
  assert.match(generatedDockerfile(['requirements.txt', 'app.py'], () => 'flask')!, /FROM python:3\.12-slim/);
});

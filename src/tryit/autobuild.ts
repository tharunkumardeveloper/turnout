// Any repo runs: a Dockerfile for a folder that has none, the settings an app's error asks for,
// and a throwaway database for the test. The repo's own Dockerfile always wins.
import { readFileSync, writeFileSync } from 'node:fs';

type Read = (path: string) => string | null;

/** A Dockerfile for a project that has none, from what the project is (Node, Python, Go, PHP, Ruby, plain HTML); null: can't tell. */
export function generatedDockerfile(files: string[], read: Read): string | null {
  const has = (p: string) => files.includes(p);
  // Laravel first: it has a package.json too (Vite for its assets), but it is a PHP app (laravel/laravel was served
  // as a static site and failed).
  if (has('artisan') && has('composer.json')) return phpDockerfile(files, read, true);
  if (has('package.json')) {
    let pkg: { scripts?: Record<string, string>; main?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string>; engines?: { node?: string } } = {};
    try {
      pkg = JSON.parse(read('package.json') ?? '{}');
    } catch {}
    const s = pkg.scripts ?? {};
    // The repository's own package manager (its lockfile), and the Node major it asks for (.nvmrc, .node-version,
    // engines), else 22. npm falls back to --legacy-peer-deps: older trees fail npm 7+'s peer check.
    const pm = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : 'npm';
    const major = Number(((read('.nvmrc') ?? read('.node-version') ?? '').match(/(\d+)/) ?? (pkg.engines?.node ?? '').match(/(\d+)/))?.[1]);
    const node = major >= 18 && major <= 24 ? major : 22;
    const install = pm === 'npm'
      ? 'RUN npm install --no-audit --no-fund || npm install --no-audit --no-fund --legacy-peer-deps\n'
      : `RUN corepack enable && ${pm === 'pnpm' ? `${pnpmFor(read('pnpm-lock.yaml'))}pnpm install --no-frozen-lockfile` : 'yarn install'}\n`;
    // Old webpack (4) on Node 17+ stops at OpenSSL's "digital envelope routines": try again with the legacy provider.
    const build = s.build ? `RUN ${pm} run build || NODE_OPTIONS=--openssl-legacy-provider ${pm} run build\n` : '';
    const head = `FROM node:${node}-alpine\nWORKDIR /app\nCOPY . .\n${install}`;
    // A static HTML template carrying a package.json for its tooling (gulp, Sass, browser-sync), with index.html at the
    // top: the pages are already there, so serve them as they are (startbootstrap-sb-admin-2's npm install failed).
    const bundler = /\b(vite|webpack|react-scripts|parcel|rollup|esbuild|ng|next|nuxt|astro|svelte-kit|gatsby|tsc|vue-cli-service)\b/;
    if (has('index.html') && !bundler.test(s.build ?? '') && (!s.start || /\b(gulp|grunt|browser-sync|live-server|lite-server|http-server|serve)\b/.test(s.start))) {
      return 'FROM nginx:1.27-alpine\nCOPY . /usr/share/nginx/html\n';
    }
    // No start script: the entry file that is really there ("main" is often left at npm's default index.js), then the
    // file a dev script runs (nodemon src/index.js).
    const bare = (f: string | undefined) => f?.replace(/^\.\//, '');
    const fromDev = Object.values(s).map((c) => c.match(/\b(?:node|nodemon)\b(?:\s+-\S+)*\s+([\w./-]+\.[cm]?js)\b/)?.[1]).find((f) => f && has(bare(f)!));
    const entry = [pkg.main, 'server.js', 'index.js', 'app.js', fromDev, 'src/index.js', 'src/server.js', 'src/app.js'].map(bare).find((f) => f && has(f)) ?? pkg.main ?? 'index.js';
    const start = s.start ? `["${pm}", "start"]` : `["node", "${entry}"]`;
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    // SvelteKit with its Node adapter builds a server into build/: run it.
    if (!s.start && s.build && deps['@sveltejs/adapter-node']) {
      return `${head}${build}ENV PORT=3000 HOST=0.0.0.0\nEXPOSE 3000\nCMD ["node", "build"]\n`;
    }
    // A start script that is a development server (webpack serve, Vite, react-scripts start, Parcel, ng serve…) listens
    // on the container's own loopback and rebuilds on every change: with a build script, serve what the build makes.
    // (puikinsh/adminator-admin-dashboard: webpack-dev-server on 127.0.0.1:4000, unreachable.)
    const devServer = /\b(webpack(-dev-server|\s+serve)|vite(?!\s+(build|preview))\b|react-scripts\s+start|parcel(?!\s+build)\b|ng\s+serve|vue-cli-service\s+serve|gatsby\s+develop|nuxt\s+dev|astro\s+dev|browser-sync|live-server|http-server)/.test(s.start ?? '');
    // A build with no start script (or only a development server) is a static site: serve what it built, from whichever
    // folder it built into (Vite dist/, Create React App and SvelteKit's static adapter build/, Next's export out/).
    if ((!s.start || devServer) && s.build && (!pkg.main || /\.html?$/i.test(pkg.main))) {
      return `${head.replace('-alpine\n', '-alpine AS build\n')}${build}RUN for d in dist build out public; do if [ -f "$d/index.html" ]; then cp -r "$d" /site; break; fi; done; test -d /site\nFROM nginx:1.27-alpine\nCOPY --from=build /site /usr/share/nginx/html\n`;
    }
    // Something to run: a start script or an entry file that is there. A package.json with neither (a library, like
    // knadh/oat) isn't an app: look at it as a static site below instead of starting a container that crashes.
    // HOST=0.0.0.0: servers that read it listen on every interface, not only the container's own loopback.
    if (s.start || has(entry)) return `${head}${build}ENV PORT=3000 HOST=0.0.0.0\nEXPOSE 3000\nCMD ${start}\n`;
  }
  if (has('requirements.txt') || has('pyproject.toml')) {
    const reqs = (read('requirements.txt') ?? '').toLowerCase();
    const install = has('requirements.txt') ? 'RUN pip install --no-cache-dir -r requirements.txt' : 'RUN pip install --no-cache-dir .';
    let cmd = '["python", "app.py"]';
    // Migrations first: a page that reads a table needs it. With no database to reach, migrate fails and says why,
    // which is what offers the throwaway one.
    const module = has('app.py') ? 'app' : has('main.py') ? 'main' : has('wsgi.py') ? 'wsgi' : 'app';
    // The project's own start command first: a Procfile's web: line (Heroku) or railway.json's startCommand, made to
    // listen on 0.0.0.0:8000. Then gunicorn when it's installed. (railwayapp-templates/flask: Flask 1.1 has no --app.)
    let own = (read('Procfile') ?? '').match(/^web:\s*(.+)$/m)?.[1]?.trim();
    try {
      own ??= JSON.parse(read('railway.json') ?? '{}')?.deploy?.startCommand;
    } catch {}
    if (own && /^(gunicorn|uvicorn|hypercorn|waitress-serve|python)\b/.test(own) && !has('manage.py')) {
      let c = own.replace(/\$\{?PORT\}?/g, '8000');
      if (/^gunicorn\b/.test(c) && !/(--bind|-b)\b/.test(c)) c += ' --bind 0.0.0.0:8000';
      if (/^(uvicorn|hypercorn)\b/.test(c) && !/--host\b/.test(c)) c += ' --host 0.0.0.0 --port 8000';
      cmd = JSON.stringify(['sh', '-c', c]);
    } else if (has('manage.py')) cmd = '["sh", "-c", "python manage.py migrate --noinput && exec python manage.py runserver 0.0.0.0:8000 --noreload"]';
    else if (/\bgunicorn\b/.test(reqs) && /\bflask\b/.test(reqs)) cmd = `["gunicorn", "${module}:app", "--bind", "0.0.0.0:8000"]`;
    // FLASK_APP instead of --app: Flask before 2.2 has no --app option.
    else if (/\bflask\b/.test(reqs)) cmd = `["sh", "-c", "FLASK_APP=${module} exec python -m flask run --host=0.0.0.0 --port=8000"]`;
    else if (/\b(fastapi|uvicorn)\b/.test(reqs)) cmd = `["python", "-m", "uvicorn", "${has('main.py') ? 'main' : 'app'}:app", "--host", "0.0.0.0", "--port", "8000"]`;
    // Django's static files collected at build: with WhiteNoise's manifest storage every page is a 500 without them.
    const statics = has('manage.py') ? 'RUN python manage.py collectstatic --noinput >/dev/null 2>&1 || true\n' : '';
    // The Python the project asks for (runtime.txt python-3.10.4, .python-version 3.10), else 3.12: old pins often have
    // no package for a newer Python. A database driver built from source gets its compiler and client library.
    const wanted = ((read('runtime.txt') ?? '').match(/python-(\d+\.\d+)/)?.[1] ?? (read('.python-version') ?? '').match(/^(\d+\.\d+)/m)?.[1]) || '3.12';
    const native = /\b(psycopg2|mysqlclient)\b/.test(reqs)
      ? 'RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends gcc libpq-dev default-libmysqlclient-dev pkg-config >/dev/null && rm -rf /var/lib/apt/lists/*\n'
      : '';
    // setuptools (before 81, which dropped pkg_resources) first: Python 3.12 no longer brings it, and older packages import pkg_resources from it (gunicorn 20:
    // railwayapp-templates/flask crashed on start).
    return `FROM python:${wanted}-slim\nWORKDIR /app\n${native}RUN pip install --no-cache-dir "setuptools<81" >/dev/null\nCOPY . .\n${install}\n${statics}EXPOSE 8000\nCMD ${cmd}\n`;
  }
  if (has('go.mod')) {
    // The newest Go builds any go.mod (GOTOOLCHAIN=auto fetches a newer one if it asks). The project's files go into the
    // final image with the binary: templates/ and static/ are read at run time.
    // SQLite through mattn/go-sqlite3 (also under gorm's sqlite driver) is C: built with cgo, against musl like the
    // final image. (gothinkster/golang-gin-realworld-example-app crashed: "requires cgo to work".)
    const cgo = /mattn\/go-sqlite3|gorm\.io\/driver\/sqlite/.test(read('go.mod') ?? '');
    const env = cgo ? 'ENV GOTOOLCHAIN=auto CGO_ENABLED=1\nRUN apk add --no-cache build-base\n' : 'ENV GOTOOLCHAIN=auto CGO_ENABLED=0\n';
    return `FROM golang:alpine AS build\n${env}WORKDIR /src\nCOPY . .\nRUN go build -o /app .\nFROM alpine:3.20\nWORKDIR /srv\nCOPY --from=build /src /srv\nCOPY --from=build /app /app\nENV PORT=8080\nEXPOSE 8080\nCMD ["/app"]\n`;
  }
  if (has('pom.xml') || has('build.gradle') || has('build.gradle.kts')) {
    // Java: Maven or Gradle builds the jar (tests skipped: Turnout compares the app, not its test suite), then it runs.
    // Spring Boot reads PORT when its properties say server.port=${PORT:…}; 8080 is its default otherwise.
    const maven = has('pom.xml');
    const jdk = (read('system.properties') ?? '').match(/java\.runtime\.version\s*=\s*(\d+)/)?.[1] ?? (read('pom.xml') ?? '').match(/<java\.version>(\d+)/)?.[1] ?? '21';
    const buildCmd = maven ? 'mvn -q -B -DskipTests package' : 'gradle -q build -x test'; // the image's own tool: a wrapper script may need bash or CRLF-free files
    const out = maven ? 'target' : 'build/libs';
    const image = maven ? `maven:3-eclipse-temurin-${jdk}` : `gradle:jdk${jdk}`;
    return `FROM ${image} AS build\nWORKDIR /src\nCOPY . .\nRUN ${buildCmd}\nRUN cp "$(ls ${out}/*.jar | grep -v -e plain -e sources -e javadoc | head -1)" /app.jar\nFROM eclipse-temurin:${jdk}-jre\nCOPY --from=build /app.jar /app.jar\nENV PORT=8080\nEXPOSE 8080\nCMD ["java", "-jar", "/app.jar"]\n`;
  }
  if (has('Gemfile')) {
    // The full image: gems with native parts (pg, mysql2, nokogiri) need its compiler and client libraries.
    const head = 'FROM ruby:3.4\nWORKDIR /app\nCOPY . .\nRUN bundle install\n';
    if (has('bin/rails')) return `${head}ENV RAILS_ENV=development RAILS_LOG_TO_STDOUT=1\nEXPOSE 3000\nCMD ["sh", "-c", "ruby bin/rails db:prepare && exec ruby bin/rails server -b 0.0.0.0 -p 3000"]\n`;
    if (has('config.ru')) return `${head}EXPOSE 4567\nCMD ["bundle", "exec", "rackup", "-o", "0.0.0.0", "-p", "4567"]\n`;
    return `${head}EXPOSE 4567\nCMD ["ruby", "app.rb", "-o", "0.0.0.0", "-p", "4567"]\n`;
  }
  if (files.some((f) => /^[^/]+\.php$/i.test(f)) || has('composer.json')) return phpDockerfile(files, read, false);
  if (has('index.html')) return 'FROM nginx:1.27-alpine\nCOPY . /usr/share/nginx/html\n';
  // HTML pages in folders with none at the top (a gallery of pages, like RayVelez27/instalanding.ai): served as they
  // are, the top level as a folder listing so every page can be reached.
  if (files.some((f) => /\.html?$/i.test(f) && !/(^|\/)node_modules\//.test(f))) {
    return "FROM nginx:1.27-alpine\nCOPY . /usr/share/nginx/html\nRUN printf 'server {\\n  listen 80;\\n  root /usr/share/nginx/html;\\n  index index.html index.htm;\\n  autoindex on;\\n}\\n' > /etc/nginx/conf.d/default.conf\n";
  }
  return null;
}

/** The settings an app's error names: "DATABASE_URL is not set", "KeyError: 'SECRET_KEY'", "missing env STRIPE_KEY". */
export function missingSettings(log: string): string[] {
  const names = new Set<string>();
  const patterns = [
    /\b([A-Z][A-Z0-9_]{2,})\b[^\n]{0,40}\b(?:is not set|not set|is required|is missing|missing|undefined|must be set|not defined|not found in (?:the )?environment)/g,
    /\b(?:missing|required|set|define|provide)\b[^\n]{0,30}?\b(?:env(?:ironment)?(?: variable)?s?|setting)\b[^\n]{0,10}?[`'"]?([A-Z][A-Z0-9_]{2,})\b/gi,
    /KeyError: ['"]([A-Z][A-Z0-9_]{2,})['"]/g,
    /\b(DATABASE_URL|REDIS_URL|MONGO(?:DB)?_URI|POSTGRES_URL)\b/g,
  ];
  for (const p of patterns) for (const m of log.matchAll(p)) if (!/^(ERROR|WARN|INFO|DEBUG|HTTP|GET|POST|NODE_ENV|PATH|HOME)$/.test(m[1]!)) names.add(m[1]!);
  // Errors that name no variable but mean one: NextAuth / Auth.js without a secret ("Please define a `secret` in
  // production", [next-auth][error][NO_SECRET], MissingSecret): every page answers 500 until it has one.
  if (/\[next-auth\]\[error\]\[NO_SECRET\]|MissingSecretError|MissingSecret\b|define a `secret` in production/.test(log)) {
    names.add('NEXTAUTH_SECRET');
    names.add('AUTH_SECRET');
  }
  return [...names].slice(0, 10);
}

/** A database the app wants, from the setting names it asked for: postgres, mysql, or null. */
export type DatabaseKind = 'postgres' | 'mysql' | 'mongo';
export const DATABASE_KINDS: readonly DatabaseKind[] = ['postgres', 'mysql', 'mongo'];

// How each database's clients say they couldn't reach it: Node (ECONNREFUSED), psycopg ("connection to server at …
// port 5432 failed"), Rails (PG::ConnectionBad, Mysql2::Error), mysqlclient, and Mongo's drivers and Mongoose.
const REFUSED = {
  mongo: /ECONNREFUSED[^\n]*:27017|MongooseServerSelectionError|MongoNetworkError|MongoServerSelectionError|uri[`'"]? parameter to [`'"]?openUri\(\)|mongodb(\+srv)?:\/\/[^\s]*:27017/i,
  mysql: /ECONNREFUSED[^\n]*:3306|Can't connect to (local )?MySQL|Mysql2::Error::ConnectionError|mysqlclient|port 3306/i,
  postgres: /ECONNREFUSED[^\n]*:5432|connection to server (at|on)[^\n]*(5432|failed)|could not connect to server|PG::ConnectionBad|psycopg2?\.OperationalError|port 5432 failed/i,
};

export function wantsDatabase(names: string[], log = ''): DatabaseKind | null {
  if (names.some((n) => /MONGO/.test(n)) || REFUSED.mongo.test(log)) return 'mongo';
  if (names.some((n) => /MYSQL/.test(n)) || REFUSED.mysql.test(log)) return 'mysql';
  if (names.some((n) => /DATABASE|DB_|POSTGRES/.test(n)) || REFUSED.postgres.test(log)) return /mysql/i.test(log) ? 'mysql' : 'postgres';
  return null;
}

/** The throwaway database's container and the settings that point an app at it. */
export function databaseFor(kind: DatabaseKind): { image: string; env: string[]; appEnv: string[] } {
  if (kind === 'mongo') {
    const url = 'mongodb://try-db:27017/app';
    return { image: 'mongo:7', env: [], appEnv: [`MONGODB_URI=${url}`, `MONGO_URI=${url}`, `MONGO_URL=${url}`, `MONGODB_URL=${url}`, `DATABASE_URL=${url}`] };
  }
  if (kind === 'mysql') {
    return {
      image: 'mysql:8.4',
      env: ['MYSQL_ROOT_PASSWORD=turnout', 'MYSQL_DATABASE=app'],
      appEnv: ['DATABASE_URL=mysql://root:turnout@try-db:3306/app', 'MYSQL_HOST=try-db', 'DB_HOST=try-db', 'DB_PORT=3306', 'DB_USER=root', 'DB_PASSWORD=turnout', 'DB_NAME=app'],
    };
  }
  return {
    image: 'postgres:16-alpine',
    env: ['POSTGRES_PASSWORD=turnout', 'POSTGRES_DB=app'],
    appEnv: ['DATABASE_URL=postgres://postgres:turnout@try-db:5432/app', 'POSTGRES_URL=postgres://postgres:turnout@try-db:5432/app', 'DB_HOST=try-db', 'DB_PORT=5432', 'DB_USER=postgres', 'DB_PASSWORD=turnout', 'DB_NAME=app'],
  };
}

// --- A tar file, read and added to without unpacking it ---

/** The files in a tar archive, with a reader for small ones (package.json, requirements.txt). */
export function tarIndex(buf: Buffer): { files: string[]; read: Read } {
  const files: string[] = [];
  const bodies = new Map<string, Buffer>();
  let at = 0;
  let longName: string | null = null;
  while (at + 512 <= buf.length) {
    const h = buf.subarray(at, at + 512);
    if (h.every((b) => b === 0)) break;
    const size = parseInt(h.subarray(124, 136).toString('ascii').replace(/\0.*$/s, '').trim() || '0', 8);
    const type = String.fromCharCode(h[156]!);
    const prefix = h.subarray(345, 500).toString('utf8').replace(/\0.*$/s, '');
    let name = longName ?? h.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    if (!longName && prefix && h.subarray(257, 262).toString('ascii') === 'ustar' && h[262] === 0) name = `${prefix}/${name}`;
    longName = null;
    const body = buf.subarray(at + 512, at + 512 + size);
    if (type === 'L') longName = body.toString('utf8').replace(/\0.*$/s, '');
    else if (type === '0' || type === '\0') {
      const clean = name.replace(/^\.\//, '');
      files.push(clean);
      if (size < 256 * 1024) bodies.set(clean, Buffer.from(body));
    }
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return { files, read: (p) => bodies.get(p)?.toString('utf8') ?? null };
}

/** Adds one file to a tar archive on disk (before its end blocks). */
export function tarAppend(file: string, name: string, content: string): void {
  const buf = readFileSync(file);
  let end = 0;
  while (end + 512 <= buf.length && !buf.subarray(end, end + 512).every((b) => b === 0)) {
    const size = parseInt(buf.subarray(end + 124, end + 136).toString('ascii').replace(/\0.*$/s, '').trim() || '0', 8);
    end += 512 + Math.ceil(size / 512) * 512;
  }
  const data = Buffer.from(content);
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write('0000644\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124);
  h.write(`${Math.floor(Date.now() / 1000).toString(8).padStart(11, '0')}\0`, 136);
  h.write('        ', 148);
  h.write('0', 156);
  h.write('ustar\0', 257);
  h.write('00', 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  writeFileSync(file, Buffer.concat([buf.subarray(0, end), h, data, Buffer.alloc((512 - (data.length % 512)) % 512), Buffer.alloc(1024)]));
}

/**
 * PHP on Apache. The served folder: the one a Procfile names (heroku-php-apache2 web/), else public/ or web/ when the
 * front controller lives there (Laravel, Slim, Symfony), else the top. Composer's packages installed, with the PHP
 * extensions composer.json asks for (ext-intl, ext-zip…: symfony/demo's install failed without them); rewrites on.
 * Laravel also gets its first-run setup: .env from .env.example, an app key, SQLite, migrations.
 */
function phpDockerfile(files: string[], read: Read, laravel: boolean): string {
  const has = (p: string) => files.includes(p);
  const named = (read('Procfile') ?? '').match(/heroku-php-(?:apache2|nginx)\s+([\w./-]+)/)?.[1]?.replace(/^\.?\/|\/$/g, '');
  const root = named ?? (['public', 'web'].find((d) => has(`${d}/index.php`) && !has('index.php')) ?? '');
  const lines = ['FROM php:8.4-apache', 'RUN a2enmod rewrite >/dev/null'];
  if (root) lines.push(`ENV APACHE_DOCUMENT_ROOT=/var/www/html/${root}`, "RUN sed -ri 's!/var/www/html!${APACHE_DOCUMENT_ROOT}!g; s!AllowOverride None!AllowOverride All!g' /etc/apache2/sites-available/*.conf /etc/apache2/apache2.conf");
  if (has('composer.json')) {
    const composer = read('composer.json') ?? '';
    // Compiled into the official image already; anything else composer.json requires is installed.
    const builtIn = new Set(['ctype', 'iconv', 'json', 'mbstring', 'tokenizer', 'xml', 'dom', 'simplexml', 'xmlwriter', 'xmlreader', 'pdo', 'pdo_sqlite', 'sqlite3', 'openssl', 'filter', 'session', 'fileinfo', 'curl', 'hash', 'pcre', 'spl', 'reflection', 'phar', 'zlib', 'libxml', 'posix', 'readline', 'sodium']);
    const exts = [...new Set([...composer.matchAll(/"ext-([a-z0-9_]+)"/gi)].map((m) => m[1]!.toLowerCase()))].filter((e) => !builtIn.has(e));
    lines.push('RUN apt-get update -qq && apt-get install -y -qq unzip git >/dev/null && rm -rf /var/lib/apt/lists/*', 'COPY --from=composer:2 /usr/bin/composer /usr/bin/composer');
    if (exts.length) lines.push('COPY --from=mlocati/php-extension-installer /usr/bin/install-php-extensions /usr/local/bin/', `RUN install-php-extensions ${exts.join(' ')}`);
  }
  lines.push('COPY . /var/www/html/');
  // Scripts after the install, and allowed to fail: a framework's post-install script may need settings the test lacks.
  if (has('composer.json')) lines.push('RUN cd /var/www/html && composer install --no-dev --no-interaction --prefer-dist --optimize-autoloader --no-scripts && (composer run-script post-autoload-dump --no-interaction >/dev/null 2>&1 || true)');
  // Symfony: production mode (a --no-dev install has no debug bundles, and dev mode answered 500: symfony/demo).
  if (!laravel && has('bin/console') && /symfony\//.test(read('composer.json') ?? '')) {
    lines.push('ENV APP_ENV=prod APP_DEBUG=0 APP_SECRET=turnout-test-secret', 'RUN cd /var/www/html && (php bin/console cache:warmup >/dev/null 2>&1 || true) && (chown -R www-data:www-data var 2>/dev/null || true)');
  }
  if (laravel) {
    lines.push(
      'RUN cd /var/www/html && ([ -f .env ] || cp .env.example .env) && php artisan key:generate --force && touch database/database.sqlite && chown -R www-data:www-data storage bootstrap/cache database',
      'ENV DB_CONNECTION=sqlite DB_DATABASE=/var/www/html/database/database.sqlite',
      'CMD ["sh", "-c", "cd /var/www/html && php artisan migrate --force >/dev/null 2>&1; exec apache2-foreground"]',
    );
  }
  return `${lines.join('\n')}\n`;
}

/** The pnpm a lockfile was written by (lockfileVersion 5.x: pnpm 7, 6.x: pnpm 8, 9.x: pnpm 9): a newer one may refuse it. */
function pnpmFor(lock: string | null): string {
  const v = Number((lock ?? '').match(/lockfileVersion:\s*'?(\d+)/)?.[1]);
  const pnpm = v === 5 ? 7 : v === 6 ? 8 : v >= 9 ? 9 : 0;
  return pnpm ? `corepack prepare pnpm@${pnpm} --activate && ` : '';
}

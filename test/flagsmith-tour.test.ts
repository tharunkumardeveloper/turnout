import assert from 'node:assert/strict';
import { test } from 'node:test';
import { injectTour, TOUR_SCRIPT } from '../src/console/flagsmith-tour.ts';

test("Flagsmith's pages get the tour's one script, once, before </head>", () => {
  const tag = `<script src="${TOUR_SCRIPT}" defer></script>`;
  assert.equal(injectTour('<html><head><title>Flagsmith</title></head><body></body></html>'), `<html><head><title>Flagsmith</title>${tag}</head><body></body></html>`);
  assert.equal(injectTour('<body class="x"><div id="app"></div>'), `<body class="x">${tag}<div id="app"></div>`);
  const once = injectTour('<head></head>');
  assert.equal(injectTour(once), once, 'never twice');
});

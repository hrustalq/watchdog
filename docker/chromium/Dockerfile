# The Chromium fallback renderer: Playwright's browser server behind a token gate (ADR 0031). The
# worker's `chromium.connect` needs the server at the same major and minor version as its
# playwright-core, so the image and the package below are pinned to the version in
# packages/core/package.json and bumped together with it.
FROM mcr.microsoft.com/playwright:v1.64.1-noble

WORKDIR /srv
RUN npm install --no-save --no-package-lock --no-audit --no-fund playwright-core@1.64.1
COPY gate.mjs ./
USER pwuser

CMD ["node", "gate.mjs"]

# The Chromium fallback renderer: Playwright's browser server (ADR 0031). The worker's `chromium.connect`
# needs the server at the same major and minor version as its playwright-core, so the image and the
# package below are pinned to the version in packages/core/package.json and bumped together with it.
FROM mcr.microsoft.com/playwright:v1.64.1-noble

WORKDIR /srv
RUN npm install --no-save --no-package-lock --no-audit --no-fund playwright-core@1.64.1
USER pwuser

# The server answers only at the token's path, so a connection without it is refused. Outside
# run-server's unsafe mode, a client can't pass launch flags such as --no-sandbox or a proxy.
CMD ["sh", "-c", "if [ ${#CHROMIUM_TOKEN} -lt 32 ]; then echo 'Set CHROMIUM_TOKEN to at least 32 characters' >&2; exit 1; fi; exec node node_modules/playwright-core/cli.js run-server --host 0.0.0.0 --port 3000 --path \"/$CHROMIUM_TOKEN\""]

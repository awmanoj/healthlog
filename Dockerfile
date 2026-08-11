# syntax=docker/dockerfile:1

# Stage 1 — gate the image on the test suites. A merge bug loses real readings,
# so a failing suite must fail the build rather than ship.
FROM node:22-alpine AS test
WORKDIR /app
COPY index.html ./
COPY test ./test
RUN node test/merge.test.mjs && node test/app.smoke.mjs

# Stage 2 — static server, running unprivileged on 8080.
FROM nginxinc/nginx-unprivileged:stable-alpine AS runtime

COPY nginx/default.conf /etc/nginx/conf.d/default.conf

# Taken from the test stage on purpose: it makes stage 2 depend on stage 1, so
# the builder cannot prune the tests as an unused branch.
COPY --from=test /app/index.html /usr/share/nginx/html/index.html
COPY manifest.webmanifest icon.svg sw.js /usr/share/nginx/html/

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null 2>&1 || exit 1

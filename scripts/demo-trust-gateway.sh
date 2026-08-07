#!/bin/sh
set -eu
npm run build >/dev/null
node tools/trust-gateway-demo.mjs

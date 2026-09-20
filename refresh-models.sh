#!/usr/bin/env bash
# Regenerates models.json — the fallback layer of the Claude model catalogue.
# Run by hand when the CLI or gateway's model set changes; never part of the
# startup flow. See bin/refresh-models.mjs.
exec node "$(dirname "$0")/bin/refresh-models.mjs"

#!/bin/sh
set -e
# Copy the bundled models into the data folder the first time (it may be an empty mounted volume).
if [ ! -d data/models ]; then cp -r seed/models data/models; fi
exec "$@"

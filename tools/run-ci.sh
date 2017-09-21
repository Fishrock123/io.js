#!/bin/bash
set -ev

# always change the working directory to the project's root directory
cd $(dirname $0)/..

if [ "${LINTER_ONLY}" = "true" ]; then
  make lint
else
  make -j2 test-ci
fi

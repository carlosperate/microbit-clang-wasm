#!/bin/sh -ex

PYTHON=${PYTHON:-python}

cd $(dirname $0)/npmjs

# The package is packed from this directory, so the licence files have to be in it. package-in.json
# points at LICENSES, and a package that refers to a file it does not ship is worse than one that
# says nothing.
cp ../LICENSE.txt ../LICENSES .

${PYTHON} prepare.py
npm install
npm run all

mkdir -p dist
npm pack --pack-destination dist

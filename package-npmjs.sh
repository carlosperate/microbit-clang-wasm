#!/bin/sh -ex

PYTHON=${PYTHON:-python}

cd $(dirname $0)/npmjs

# Packed from this directory, so the licence files package-in.json points at have to be in it.
cp ../LICENSE.txt ../LICENSES .

${PYTHON} prepare.py
npm install
npm run all

mkdir -p dist
npm pack --pack-destination dist

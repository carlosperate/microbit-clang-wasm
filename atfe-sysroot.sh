#!/bin/sh -e
# Assembles the flat sysroot build.sh expects from an unpacked ATfE release.
#
# Flat and single-variant on purpose: one variant ships, so multilib selection inside a virtual
# filesystem would be one more thing to go wrong for no benefit. The variant is the micro:bit V2's
# Cortex-M4, soft float ABI with an FPv4-SP.

ATFE=${1:?usage: atfe-sysroot.sh <ATfE install> [output dir]}
OUT=${2:-$(pwd)/atfe-sysroot}
VARIANT=${VARIANT:-armv7m_soft_fpv4_sp_d16_unaligned_size}

RUNTIME="${ATFE}/lib/clang-runtimes/newlib-nano/arm-none-eabi"
ls -d "${RUNTIME}/${VARIANT}/lib" "${RUNTIME}/include" >/dev/null

rm -rf "${OUT}"
mkdir -p "${OUT}/licenses"
cp -R "${RUNTIME}/${VARIANT}/lib" "${OUT}/lib"
cp -R "${RUNTIME}/include" "${OUT}/include"

# Redistributing Arm's libraries means redistributing their notices; COPYING.NEWLIB alone carries
# 57 of them.
cp -R "${ATFE}/third-party-licenses/." "${OUT}/licenses/"
cp "${ATFE}/LICENSE.txt" "${ATFE}/THIRD-PARTY-LICENSES.txt" "${OUT}/licenses/"

echo "sysroot at ${OUT}: $(find "${OUT}" -type f | wc -l | tr -d ' ') files, $(du -sh "${OUT}" | cut -f1)"

#!/bin/sh
set -ex

# Set by the caller when this runs outside a git checkout.
export SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH:-$(git log -1 --format=%ct 2>/dev/null || echo 0)}

# CMake here generates makefiles, which build serially unless told otherwise.
if [ -z "${MAKEFLAGS:-}" ]; then
  MAKEFLAGS=-j$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)
  export MAKEFLAGS
fi

# ccache is on by default in the CMake invocations below, so give it somewhere to live that survives
# between runs without being inside a build directory. A cold LLVM build fills a few GB.
export CCACHE_DIR=${CCACHE_DIR:-$(pwd)/.ccache}
export CCACHE_MAXSIZE=${CCACHE_MAXSIZE:-10G}

# Which ATfE release to build. One knob, as an argument or an environment variable:
#   ./build.sh 22.1.0        LLVM_VERSION=22.1.0 ./build.sh
# The default tracks the newest version actually built and tested here, not the newest that exists.
DEFAULT_LLVM_VERSION=21.1.1
LLVM_VERSION=${1:-${LLVM_VERSION:-${DEFAULT_LLVM_VERSION}}}
LLVM_TAG=release-${LLVM_VERSION}-ATfE

# Everything that version needs lives in one directory: the patches, and the commit its tag pointed
# at. So `ls patches/` is the list of versions this repository can build, and there is no separate
# mapping to fall out of step. The patches have to be per version because the WASI change differs
# between them: 21 files on the 21.x branch, 23 on 22.x.
#
# Each directory is self-contained, and a patch shared between versions is copied rather than
# referenced. That is deliberate: patch context drifts between releases, so a shared patch would
# have to be edited when one release moves those lines, which would silently change what an older
# version builds from. Copying keeps every version independently reproducible.
PATCH_DIR=patches/${LLVM_TAG}
if ! [ -d "${PATCH_DIR}" ]; then
  echo "no patches for ${LLVM_VERSION}. Add ${PATCH_DIR}, or build one of:" >&2
  ls patches | sed 's/^release-/  /; s/-ATfE$//' >&2
  exit 1
fi

# An empty directory would build an unpatched compiler, and the WASI change is not optional. Worth
# a check because that failure surfaces hours later and nowhere near its cause; a missing or
# malformed llvm-commit, by contrast, fails immediately and says so itself.
if ! ls "${PATCH_DIR}"/*.patch >/dev/null 2>&1; then
  echo "${PATCH_DIR} has no patches, so this would build an unpatched compiler" >&2
  exit 1
fi
read -r LLVM_COMMIT < "${PATCH_DIR}/llvm-commit"

# The ATfE tags are not consistently annotated — 21.1.1 is lightweight, 22.1.0 is not — so the
# commit is checked after cloning rather than resolved from the tag beforehand. It also catches a
# moved tag, and a stale llvm-src left over from building a different version.
LLVM_REPO=${LLVM_REPO:-https://github.com/arm/arm-toolchain.git}
if ! [ -e llvm-src/llvm/CMakeLists.txt ]; then
  git clone --depth 1 --single-branch --branch "${LLVM_TAG}" "${LLVM_REPO}" llvm-src
fi
llvm_head=$(git -C llvm-src rev-parse HEAD)
if [ "${llvm_head}" != "${LLVM_COMMIT}" ]; then
  echo "llvm-src is at ${llvm_head}, but ${LLVM_TAG} is ${LLVM_COMMIT}." >&2
  echo "Remove llvm-src to re-clone, or build the version it holds." >&2
  exit 1
fi
echo "building LLVM ${LLVM_VERSION} (${LLVM_TAG}, ${LLVM_COMMIT})"

# ATfE's libraries and headers for the micro:bit's CPU, arranged as a flat sysroot: lib/ from the
# armv7m_soft_fpv4_sp_d16_unaligned_size variant, include/ from the shared newlib-nano headers.
# Checked now because it is not used until the very end, so a missing one otherwise wastes the build.
# licenses/ is required, not optional: we redistribute newlib, libc++ and compiler-rt binaries, and
# their notices have to go with them. Copy ATfE's THIRD-PARTY-LICENSES.txt and third-party-licenses/
# into the sysroot when assembling it.
ATFE_SYSROOT=${ATFE_SYSROOT:-$(pwd)/atfe-sysroot}
ls -d "${ATFE_SYSROOT}/include" "${ATFE_SYSROOT}/lib" "${ATFE_SYSROOT}/licenses" >/dev/null

# The toolchain that compiles LLVM to wasm. It is a host build tool and is not shipped, but it does
# decide what our binary contains, so it is pinned by version and checked by digest.
WASI_VER=32
WASI_ARCH=$(uname -m | sed 's/aarch64/arm64/')
WASI_SDK=wasi-sdk-${WASI_VER}.0-${WASI_ARCH}-linux
WASI_SDK_URL=https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-${WASI_VER}/${WASI_SDK}.tar.gz
case ${WASI_ARCH} in
  arm64)  WASI_SDK_SHA256=b2070865e6cb0c1e97a38e6ac8d9c37a9dfcd0752764ebabc6bacd3e60cedb96 ;;
  x86_64) WASI_SDK_SHA256=55fc523ebfbc98f69d1034fcfcb83d1ff5610cd9ab7eceef6cd097a30ba4ef93 ;;
  *)      echo "no wasi-sdk digest recorded for ${WASI_ARCH}" >&2; exit 1 ;;
esac
if ! [ -d "${WASI_SDK}" ]; then
  # Downloaded to a file rather than piped into tar, so the digest is checked before anything is
  # unpacked. Removed afterwards; it is 136 MB.
  curl -L -o "${WASI_SDK}.tar.gz" "${WASI_SDK_URL}"
  echo "${WASI_SDK_SHA256}  ${WASI_SDK}.tar.gz" | sha256sum -c -
  tar xzf "${WASI_SDK}.tar.gz"
  rm -f "${WASI_SDK}.tar.gz"
fi
WASI_SDK_PATH=$(pwd)/${WASI_SDK}

# Applying the changes here rather than keeping a fork of llvm-project means every version bump is a
# `git apply --check` against the new tag.
for patch in "${PATCH_DIR}"/*.patch; do
  if git -C llvm-src apply --check --reverse "$(pwd)/${patch}" 2>/dev/null; then
    echo "already applied: ${patch}"
  else
    git -C llvm-src apply "$(pwd)/${patch}"
  fi
done

WASI_TARGET="wasm32-wasip1"
# What the compiler we are building targets, as opposed to what it runs on.
TARGET_TRIPLE="arm-none-eabi"
WASI_CFLAGS="--sysroot ${WASI_SDK_PATH}/share/wasi-sysroot -mcpu=lime1"
WASI_LDFLAGS="--sysroot ${WASI_SDK_PATH}/share/wasi-sysroot"
WASI_CFLAGS_LLVM="${WASI_CFLAGS}"
WASI_LDFLAGS_LLVM="${WASI_LDFLAGS}"
# LLVM has some (unreachable in our configuration) calls to mmap.
WASI_CFLAGS_LLVM="${WASI_CFLAGS_LLVM} -D_WASI_EMULATED_MMAN"
WASI_LDFLAGS_LLVM="${WASI_LDFLAGS_LLVM} -lwasi-emulated-mman"
# Depending on the code being compiled, both Clang and LLD can consume unbounded amounts of memory.
WASI_LDFLAGS_LLVM="${WASI_LDFLAGS_LLVM} -Wl,--max-memory=4294967296"
# Compiling C++ code requires a lot of stack space and can overflow and corrupt the heap.
# (For example, `#include <iostream>` alone does it in a build with the default stack size.)
WASI_LDFLAGS_LLVM="${WASI_LDFLAGS_LLVM} -Wl,-z,stack-size=8388608,--stack-first"
# Some of the host APIs that are statically required by LLVM (notably threading) are dynamically
# never used. An LTO build removes imports of these APIs, simplifying deployment.
WASI_CFLAGS_LLVM="${WASI_CFLAGS_LLVM} -flto"
WASI_LDFLAGS_LLVM="${WASI_LDFLAGS_LLVM} -flto -Wl,--strip-all"

# Upstream also wrote a Toolchain-WASI.cmake here for its compiler-rt, wasi-libc and libc++ builds.
# Those are gone, replaced by ATfE's libraries, so only the one below is used.
cat >Toolchain-WASI-LLVM.cmake <<END
include(${WASI_SDK_PATH}/share/cmake/wasi-sdk-p1.cmake)
set(CMAKE_C_FLAGS "${WASI_CFLAGS_LLVM}")
set(CMAKE_CXX_FLAGS "${WASI_CFLAGS_LLVM}")
set(CMAKE_EXE_LINKER_FLAGS "${WASI_LDFLAGS_LLVM}")
END

# The clang binary built as `Debug` doesn't pass Wasm validation.
# (This has cost me a hour of my life.)

LLVM_VERSION_MAJOR=$(cmake -P Get-LLVM-Version.cmake 2>&1)

# Upstream skips this whenever the two executables exist. Our build directory lives in a volume that
# outlives the LLVM checkout, so that would hand a new LLVM its predecessor's generators; the 21 to
# 22 move would hit it. Configure and build unconditionally instead and let CMake decide what is
# actually stale, which costs nothing when nothing changed.
mkdir -p llvm-tblgen-build
cmake -B llvm-tblgen-build -S llvm-src/llvm \
    -DLLVM_CCACHE_BUILD=ON \
    -DCMAKE_BUILD_TYPE=MinSizeRel \
    -DLLVM_BUILD_RUNTIME=OFF \
    -DLLVM_BUILD_TOOLS=OFF \
    -DLLVM_INCLUDE_UTILS=OFF \
    -DLLVM_INCLUDE_RUNTIMES=OFF \
    -DLLVM_INCLUDE_EXAMPLES=OFF \
    -DLLVM_INCLUDE_TESTS=OFF \
    -DLLVM_INCLUDE_BENCHMARKS=OFF \
    -DLLVM_INCLUDE_DOCS=OFF \
    -DLLVM_TARGETS_TO_BUILD=ARM \
    -DLLVM_DEFAULT_TARGET_TRIPLE=${TARGET_TRIPLE} \
    -DLLVM_ENABLE_PROJECTS="clang" \
    -DCLANG_BUILD_EXAMPLES=OFF \
    -DCLANG_BUILD_TOOLS=OFF \
    -DCLANG_INCLUDE_TESTS=OFF
cmake --build llvm-tblgen-build --target llvm-tblgen --target clang-tblgen

mkdir -p llvm-build
cmake -B llvm-build -S llvm-src/llvm \
  -DCMAKE_TOOLCHAIN_FILE=../Toolchain-WASI-LLVM.cmake \
  -DLLVM_CCACHE_BUILD=ON \
  -DLLVM_NATIVE_TOOL_DIR=$(pwd)/llvm-tblgen-build/bin \
  -DCMAKE_BUILD_TYPE=MinSizeRel \
  -DLLVM_ENABLE_ASSERTIONS=OFF \
  -DLLVM_BUILD_SHARED_LIBS=OFF \
  -DLLVM_ENABLE_PIC=OFF \
  -DLLVM_BUILD_STATIC=ON \
  -DLLVM_ENABLE_THREADS=OFF \
  -DLLVM_BUILD_RUNTIME=OFF \
  -DLLVM_BUILD_TOOLS=OFF \
  -DLLVM_INCLUDE_UTILS=OFF \
  -DLLVM_BUILD_UTILS=OFF \
  -DLLVM_INCLUDE_RUNTIMES=OFF \
  -DLLVM_INCLUDE_EXAMPLES=OFF \
  -DLLVM_INCLUDE_TESTS=OFF \
  -DLLVM_INCLUDE_BENCHMARKS=OFF \
  -DLLVM_INCLUDE_DOCS=OFF \
  -DLLVM_TARGETS_TO_BUILD=ARM \
  -DLLVM_DEFAULT_TARGET_TRIPLE=${TARGET_TRIPLE} \
  -DLLVM_TOOL_BUGPOINT_BUILD=OFF \
  -DLLVM_TOOL_BUGPOINT_PASSES_BUILD=OFF \
  -DLLVM_TOOL_DSYMUTIL_BUILD=OFF \
  -DLLVM_TOOL_DXIL_DIS_BUILD=OFF \
  -DLLVM_TOOL_GOLD_BUILD=OFF \
  -DLLVM_TOOL_LLC_BUILD=OFF \
  -DLLVM_TOOL_LLI_BUILD=OFF \
  -DLLVM_TOOL_LLVM_AR_BUILD=ON \
  -DLLVM_TOOL_LLVM_AS_BUILD=OFF \
  -DLLVM_TOOL_LLVM_AS_FUZZER_BUILD=OFF \
  -DLLVM_TOOL_LLVM_BCANALYZER_BUILD=OFF \
  -DLLVM_TOOL_LLVM_CAT_BUILD=OFF \
  -DLLVM_TOOL_LLVM_CFI_VERIFY_BUILD=OFF \
  -DLLVM_TOOL_LLVM_CONFIG_BUILD=OFF \
  -DLLVM_TOOL_LLVM_COV_BUILD=OFF \
  -DLLVM_TOOL_LLVM_CVTRES_BUILD=OFF \
  -DLLVM_TOOL_LLVM_CXXDUMP_BUILD=OFF \
  -DLLVM_TOOL_LLVM_CGDATA_BUILD=OFF \
  -DLLVM_TOOL_LLVM_CXXFILT_BUILD=ON \
  -DLLVM_TOOL_LLVM_CXXMAP_BUILD=OFF \
  -DLLVM_TOOL_LLVM_C_TEST_BUILD=OFF \
  -DLLVM_TOOL_LLVM_DEBUGINFOD_BUILD=OFF \
  -DLLVM_TOOL_LLVM_DEBUGINFOD_FIND_BUILD=OFF \
  -DLLVM_TOOL_LLVM_DEBUGINFO_ANALYZER_BUILD=OFF \
  -DLLVM_TOOL_LLVM_DIFF_BUILD=OFF \
  -DLLVM_TOOL_LLVM_DIS_BUILD=OFF \
  -DLLVM_TOOL_LLVM_DIS_FUZZER_BUILD=OFF \
  -DLLVM_TOOL_LLVM_DLANG_DEMANGLE_FUZZER_BUILD=OFF \
  -DLLVM_TOOL_LLVM_DRIVER_BUILD=ON \
  -DLLVM_TOOL_LLVM_DWARFDUMP_BUILD=ON \
  -DLLVM_TOOL_LLVM_DWARFUTIL_BUILD=OFF \
  -DLLVM_TOOL_LLVM_DWP_BUILD=OFF \
  -DLLVM_TOOL_LLVM_EXEGESIS_BUILD=OFF \
  -DLLVM_TOOL_LLVM_EXTRACT_BUILD=OFF \
  -DLLVM_TOOL_LLVM_GSYMUTIL_BUILD=OFF \
  -DLLVM_TOOL_LLVM_IFS_BUILD=OFF \
  -DLLVM_TOOL_LLVM_ISEL_FUZZER_BUILD=OFF \
  -DLLVM_TOOL_LLVM_ITANIUM_DEMANGLE_FUZZER_BUILD=OFF \
  -DLLVM_TOOL_LLVM_JITLINK_BUILD=OFF \
  -DLLVM_TOOL_LLVM_JITLISTENER_BUILD=OFF \
  -DLLVM_TOOL_LLVM_LIBTOOL_DARWIN_BUILD=OFF \
  -DLLVM_TOOL_LLVM_LINK_BUILD=OFF \
  -DLLVM_TOOL_LLVM_LIPO_BUILD=OFF \
  -DLLVM_TOOL_LLVM_LTO2_BUILD=OFF \
  -DLLVM_TOOL_LLVM_LTO_BUILD=OFF \
  -DLLVM_TOOL_LLVM_MCA_BUILD=OFF \
  -DLLVM_TOOL_LLVM_MC_ASSEMBLE_FUZZER_BUILD=OFF \
  -DLLVM_TOOL_LLVM_MC_BUILD=OFF \
  -DLLVM_TOOL_LLVM_MC_DISASSEMBLE_FUZZER_BUILD=OFF \
  -DLLVM_TOOL_LLVM_MICROSOFT_DEMANGLE_FUZZER_BUILD=OFF \
  -DLLVM_TOOL_LLVM_ML_BUILD=OFF \
  -DLLVM_TOOL_LLVM_MODEXTRACT_BUILD=OFF \
  -DLLVM_TOOL_LLVM_MT_BUILD=OFF \
  -DLLVM_TOOL_LLVM_NM_BUILD=ON \
  -DLLVM_TOOL_LLVM_OBJCOPY_BUILD=ON \
  -DLLVM_TOOL_LLVM_OBJDUMP_BUILD=ON \
  -DLLVM_TOOL_LLVM_OPT_FUZZER_BUILD=OFF \
  -DLLVM_TOOL_LLVM_OPT_REPORT_BUILD=OFF \
  -DLLVM_TOOL_LLVM_PDBUTIL_BUILD=OFF \
  -DLLVM_TOOL_LLVM_PROFDATA_BUILD=OFF \
  -DLLVM_TOOL_LLVM_PROFGEN_BUILD=OFF \
  -DLLVM_TOOL_LLVM_RC_BUILD=OFF \
  -DLLVM_TOOL_LLVM_READOBJ_BUILD=ON \
  -DLLVM_TOOL_LLVM_READTAPI_BUILD=OFF \
  -DLLVM_TOOL_LLVM_REDUCE_BUILD=OFF \
  -DLLVM_TOOL_LLVM_REMARKUTIL_BUILD=OFF \
  -DLLVM_TOOL_LLVM_RTDYLD_BUILD=OFF \
  -DLLVM_TOOL_LLVM_RUST_DEMANGLE_FUZZER_BUILD=OFF \
  -DLLVM_TOOL_LLVM_SHLIB_BUILD=OFF \
  -DLLVM_TOOL_LLVM_SIM_BUILD=OFF \
  -DLLVM_TOOL_LLVM_SIZE_BUILD=ON \
  -DLLVM_TOOL_LLVM_SPECIAL_CASE_LIST_FUZZER_BUILD=OFF \
  -DLLVM_TOOL_LLVM_SPLIT_BUILD=OFF \
  -DLLVM_TOOL_LLVM_STRESS_BUILD=OFF \
  -DLLVM_TOOL_LLVM_STRINGS_BUILD=OFF \
  -DLLVM_TOOL_LLVM_SYMBOLIZER_BUILD=ON \
  -DLLVM_TOOL_LLVM_TLI_CHECKER_BUILD=OFF \
  -DLLVM_TOOL_LLVM_UNDNAME_BUILD=OFF \
  -DLLVM_TOOL_LLVM_XRAY_BUILD=OFF \
  -DLLVM_TOOL_LLVM_YAML_NUMERIC_PARSER_FUZZER_BUILD=OFF \
  -DLLVM_TOOL_LLVM_YAML_PARSER_FUZZER_BUILD=OFF \
  -DLLVM_TOOL_LTO_BUILD=OFF \
  -DLLVM_TOOL_OBJ2YAML_BUILD=OFF \
  -DLLVM_TOOL_OPT_BUILD=OFF \
  -DLLVM_TOOL_OPT_VIEWER_BUILD=OFF \
  -DLLVM_TOOL_REDUCE_CHUNK_LIST_BUILD=OFF \
  -DLLVM_TOOL_REMARKS_SHLIB_BUILD=OFF \
  -DLLVM_TOOL_SANCOV_BUILD=OFF \
  -DLLVM_TOOL_SANSTATS_BUILD=OFF \
  -DLLVM_TOOL_SPIRV_TOOLS_BUILD=OFF \
  -DLLVM_TOOL_VERIFY_USELISTORDER_BUILD=OFF \
  -DLLVM_TOOL_VFABI_DEMANGLE_FUZZER_BUILD=OFF \
  -DLLVM_TOOL_XCODE_TOOLCHAIN_BUILD=OFF \
  -DLLVM_TOOL_YAML2OBJ_BUILD=OFF \
  -DLLVM_ENABLE_PROJECTS="clang;lld" \
  -DCLANG_ENABLE_ARCMT=OFF \
  -DCLANG_ENABLE_STATIC_ANALYZER=OFF \
  -DCLANG_INCLUDE_TESTS=OFF \
  -DCLANG_BUILD_TOOLS=OFF \
  -DCLANG_TOOL_CLANG_SCAN_DEPS_BUILD=OFF \
  -DCLANG_TOOL_CLANG_INSTALLAPI_BUILD=OFF \
  -DCLANG_BUILD_EXAMPLES=OFF \
  -DCLANG_INCLUDE_DOCS=OFF \
  -DCLANG_LINKS_TO_CREATE="clang;clang++" \
  -DLLD_BUILD_TOOLS=OFF \
  -DCMAKE_INSTALL_PREFIX=llvm-prefix \
  -DDEFAULT_SYSROOT=/usr \
  -DCLANG_RESOURCE_DIR=/usr/lib/clang/${LLVM_VERSION_MAJOR}
# The "all" target still contains far too much stuff, even given all the options above, so build
# only Clang/LLD, explicitly. For the same reason using the "install" target is infeasible.
# I spent a while trying and it leads nowhere.
cmake --build llvm-build --target llvm-driver
cmake --build llvm-build --target clang-resource-headers

# Where upstream builds compiler-rt, wasi-libc and libc++ for wasm32, we take newlib-nano, libc++,
# libc++abi and compiler-rt from the pinned ATfE release instead: they are Arm target artefacts, so
# the host build of ATfE they came from does not matter, and they are the same libraries the native
# reference build links against.
mkdir -p wasi-prefix/usr/
rm -rf wasi-prefix/usr/include wasi-prefix/usr/lib
cp -r "${ATFE_SYSROOT}/include" wasi-prefix/usr/
cp -r "${ATFE_SYSROOT}/lib" wasi-prefix/usr/
mkdir -p wasi-prefix/usr/share
rm -rf wasi-prefix/usr/share/licenses
cp -r "${ATFE_SYSROOT}/licenses" wasi-prefix/usr/share/licenses

# The Clang builtin headers go in the resource directory beside the sysroot, never merged into it:
# Clang's stdint.h and friends reach the C library's with #include_next, which needs the two include
# directories to stay distinct. This is where a normal LLVM install puts them.
mkdir -p wasi-prefix/usr/lib/clang/${LLVM_VERSION_MAJOR}
rm -rf wasi-prefix/usr/lib/clang/${LLVM_VERSION_MAJOR}/include
cp -r llvm-build/usr/lib/clang/${LLVM_VERSION_MAJOR}/include \
  wasi-prefix/usr/lib/clang/${LLVM_VERSION_MAJOR}/

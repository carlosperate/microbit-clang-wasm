import os
import re
import json
import subprocess


# The LLVM source is an ATfE release tag in arm/arm-toolchain, not an llvmorg tag, and it may be a
# shallow clone that `git describe` cannot read at all, so the version can be supplied directly.
version = os.environ.get("PACKAGE_VERSION")
if version is None:
    llvm_version_raw = subprocess.check_output([
        "git", "-C", "../llvm-src", "describe", "--tags", "HEAD"
    ], encoding="utf-8").strip()
    print(llvm_version_raw)

    git_rev_list_raw = subprocess.check_output([
        "git", "rev-list", "HEAD"
    ], encoding="utf-8").split()
    distance = len(git_rev_list_raw) - 1

    # Only ATfE release tags are buildable, so upstream's llvmorg-* parsing is gone with them.
    atfe_version = re.match(r"^release-(\d+)\.(\d+)\.(\d+)-ATfE$", llvm_version_raw)
    if atfe_version is None:
        raise SystemExit(f"cannot derive a version from {llvm_version_raw!r}; "
                         f"set PACKAGE_VERSION instead")
    version = (f"{int(atfe_version[1])}.{int(atfe_version[2])}.{int(atfe_version[3])}"
               f"-atfe.{distance}")
print(f"version {version}")

with open("package-in.json", "rt") as f:
    package_json = json.load(f)
package_json["version"] = version
package_json["scripts"]["build"] += f" --define:VERSION=\\\"{version}\\\""
with open("package.json", "wt") as f:
    json.dump(package_json, f, indent=2)

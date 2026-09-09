import json


# The version is MAJOR.(10 × llvm.minor + llvm.patch).revision, so 21.11.3 is ATfE 21.1.1 at
# packaging revision 3. The revision is one number for the whole repository, since the same
# JavaScript and scripts build every LLVM line, and it lives in config.json with everything else.
# LLVM's minor has been a constant 1 since LLVM 18 by policy, which keeps the encoding decodable.
# config.json's optional `prerelease` appends a semver prerelease part until the packaging settles,
# so those attempts can be published and superseded without spending a revision number.

with open("../config.json", "rt") as f:
    config = json.load(f)

# Written by build.sh, so the package cannot claim an LLVM it was not built from.
with open("../llvm-build/build-info.json", "rt") as f:
    llvm = json.load(f)
if llvm["version"] not in config["llvm"]["releases"]:
    raise SystemExit(f"built LLVM {llvm['version']} is not in config.json")
major, minor, patch = (int(part) for part in llvm["version"].split("."))
if minor != 1:
    raise SystemExit(f"LLVM {llvm['version']} has minor {minor}; the version scheme assumes 1")

version = f"{major}.{10 * minor + patch}.{config['revision']}"
if config.get("prerelease"):
    version += f"-{config['prerelease']}"

with open("package-in.json", "rt") as f:
    package_json = json.load(f)
package_json["version"] = version
package_json["llvm"] = llvm
package_json["scripts"]["build"] += f" --define:VERSION=\\\"{version}\\\""
with open("package.json", "wt") as f:
    json.dump(package_json, f, indent=2)

print(f"{package_json['name']} {version}: LLVM {llvm['version']} ({llvm['repository']} {llvm['release']}, {llvm['commit'][:9]})")

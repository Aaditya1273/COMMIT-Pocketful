#!/bin/sh
# Install the COMMIT factory into a result repository: the seat mandates, the verifier
# toolkit and FACTORY.md. Nothing track-specific and no service code is copied -- the
# band writes every stage folder itself, in the room.
#
# Safe to re-run: identical files are left alone; a file that differs is a conflict and
# nothing is written unless --force, which first backs the old file up.
set -eu

usage() {
  cat <<'EOF'
usage: commit/bootstrap.sh [--force] [--check] /path/to/result-repo

  Installs into the result repository:
    mandates/      planner.md, builder.md, verifier.md (edit their Harness:/Model: lines)
    commit/        the verifier toolkit (Node >= 22.18, no npm dependencies)
    FACTORY.md     how the factory works
    .commit-factory  install marker: factory version and time

  --force   overwrite files that differ, after backing them up to .commit-backup-<time>/
  --check   after installing, run the installed toolkit's self-tests
  --help    this text

  Never touches stage folders, README.md, room.json or an existing .gitignore.
  exit: 0 installed or already up to date, 1 conflicts (nothing written), 2 usage error
EOF
}

force=0
check=0
dest=''
while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --force) force=1 ;;
    --check) check=1 ;;
    -*) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
    *) [ -z "$dest" ] || { echo "only one result repository may be given" >&2; exit 2; }; dest="$1" ;;
  esac
  shift
done
[ -n "$dest" ] || { usage >&2; exit 2; }

here="$(cd "$(dirname "$0")/.." && pwd -P)"
version="$(cat "$here/commit/VERSION")"

mkdir -p "$dest"
dest="$(cd "$dest" && pwd -P)"
case "$dest" in
  /) echo "refusing to install into /" >&2; exit 2 ;;
  "$here"|"$here"/*) echo "refusing to install into the factory repository itself ($dest)" >&2; exit 2 ;;
esac

# The installable set, relative to the factory root. Tests ship too: --check runs them.
files="$(cd "$here" && { ls mandates/*.md; ls commit/*.ts commit/lib/*.ts commit/VERSION commit/bootstrap.sh; echo FACTORY.md; })"

conflicts=''
new=0
same=0
for f in $files; do
  if [ ! -e "$dest/$f" ]; then
    new=$((new + 1))
  elif cmp -s "$here/$f" "$dest/$f"; then
    same=$((same + 1))
  else
    conflicts="$conflicts $f"
  fi
done

if [ -n "$conflicts" ] && [ "$force" -eq 0 ]; then
  echo "CONFLICT: these files already exist in $dest and differ from factory $version:" >&2
  for f in $conflicts; do echo "  $f" >&2; done
  echo "Nothing was written. Re-run with --force to back them up and replace them." >&2
  exit 1
fi

if [ "$new" -eq 0 ] && [ -z "$conflicts" ]; then
  echo "COMMIT factory $version is already installed in $dest; nothing changed."
else
  if [ -n "$conflicts" ]; then
    backup="$dest/.commit-backup-$(date -u +%Y%m%dT%H%M%SZ)"
    for f in $conflicts; do
      mkdir -p "$backup/$(dirname "$f")"
      cp -p "$dest/$f" "$backup/$f"
    done
    echo "backed up $(echo $conflicts | wc -w | tr -d ' ') differing files to $backup"
  fi
  for f in $files; do
    if [ ! -e "$dest/$f" ] || ! cmp -s "$here/$f" "$dest/$f"; then
      mkdir -p "$dest/$(dirname "$f")"
      cp "$here/$f" "$dest/$f.commit-tmp"
      mv "$dest/$f.commit-tmp" "$dest/$f"
    fi
  done
  chmod +x "$dest/commit/bootstrap.sh"
  printf '{\n  "factoryVersion": "%s",\n  "installedAt": "%s"\n}\n' "$version" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$dest/.commit-factory.tmp"
  mv "$dest/.commit-factory.tmp" "$dest/.commit-factory"
  echo "COMMIT factory $version installed in $dest ($new new, $same unchanged, $(echo $conflicts | wc -w | tr -d ' ') replaced)."
fi

if grep -l '<fill in:' "$dest"/mandates/*.md >/dev/null 2>&1; then
  echo "NOTE: mandates still contain '<fill in: ...>' placeholders for Harness:/Model:; set them before the BAND run." >&2
fi
[ -f "$dest/.gitignore" ] || printf 'node_modules/\n.venv/\n__pycache__/\n*.log\n!evidence/**/*.log\n.env\n.commit-backup-*/\n' > "$dest/.gitignore"
[ -d "$dest/.git" ] || git -C "$dest" init -q -b main

if [ "$check" -eq 1 ]; then
  echo "self-test: installed toolkit"
  (cd "$dest" && node --no-warnings commit/cli.ts version >/dev/null && node --no-warnings --test 'commit/lib/*.test.ts' >/dev/null) \
    || { echo "SELF-TEST FAILED in $dest" >&2; exit 1; }
  echo "self-test: PASS"
fi

cat <<EOF

Next:
  1. Edit the Harness: and Model: lines in mandates/*.md to what each BAND seat really runs.
  2. Write README.md for the result repository (the factory does not write it for you).
  3. Create the Planner, Builder and Verifier seats in BAND Desktop and dispatch the task
     (FACTORY.md section 2, "The dispatch message").
EOF

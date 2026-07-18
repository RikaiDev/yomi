#!/bin/sh
# PreToolUse guard (see .claude/settings.json).
#
# Release notes are a pure function of the commit range via
# scripts/release-notes.mjs — never hand-written and never --generate-notes
# (RELEASING.md step 3). This blocks any `gh release create|edit` that sets the
# body another way, so a stray marketing essay can't reach a release again.
cmd=$(python3 -c "import sys,json; print(json.load(sys.stdin).get('tool_input',{}).get('command',''))" 2>/dev/null) || exit 0

case "$cmd" in
  *"gh release create"* | *"gh release edit"*) ;;
  *) exit 0 ;;
esac

if printf '%s' "$cmd" | grep -q -- '--generate-notes'; then
  echo "Release notes must come from scripts/release-notes.mjs, not --generate-notes (RELEASING.md step 3)." >&2
  exit 2
fi

if printf '%s' "$cmd" | grep -Eq -- '(--notes|--body|--notes-file)' &&
  ! printf '%s' "$cmd" | grep -q 'release-notes.mjs'; then
  echo 'Do not hand-write release notes. Use:  gh release create "$TAG" --title "$TAG" --notes "$(node scripts/release-notes.mjs "$TAG")"  (RELEASING.md step 3).' >&2
  exit 2
fi

exit 0

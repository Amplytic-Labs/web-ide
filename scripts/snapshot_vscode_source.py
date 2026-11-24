#!/usr/bin/env python3
"""Snapshot the full vscode source tree (tracked files + our mods, excluding
node_modules/.build) into web-ide-repo/vscode/ so the repo is maintainable:
the real source lives in-tree; patches/ keeps the diff vs upstream for review.

Strategy: git ls-files gives upstream+modified tracked files; `git status`
untracked (extensions/webide-dev) adds ours. We hardlink where possible
(same filesystem) to avoid doubling disk usage, copy otherwise.
Then `git add` in the web-ide-repo dedups content anyway.
"""
import os
import shutil
import subprocess
import sys

VSCODE = '/home/z/my-project/vscode'
DEST = '/home/z/my-project/web-ide-repo/vscode'

def run_git(*args):
    return subprocess.run(['git', '-C', VSCODE, *args],
                          check=True, capture_output=True, text=True).stdout

# 1. collect file list: tracked + untracked-but-not-ignored (webide-dev), minus heavy dirs
tracked = run_git('ls-files', '-z').split('\0')
untracked = []
st = run_git('status', '--porcelain', '-z', '--untracked-files=all')
entries = st.split('\0')
i = 0
while i < len(entries):
    e = entries[i]
    if not e:
        i += 1
        continue
    code, path = e[:2], e[3:]
    if code == '??':
        untracked.append(path)
    i += 1

skip_prefixes = ('node_modules/', '.build/')
files = [f for f in tracked + untracked if f and not f.startswith(skip_prefixes)]
files = sorted(set(files))
print(f'{len(files)} files to snapshot')

# 2. wipe previous snapshot dir but keep .gitattributes-ish nothing; fresh copy
if os.path.exists(DEST):
    shutil.rmtree(DEST)
os.makedirs(DEST)

# 3. hardlink (fast, no extra disk) — web-ide-repo git add will hash contents
linked, copied = 0, 0
for rel in files:
    src = os.path.join(VSCODE, rel)
    dst = os.path.join(DEST, rel)
    if not os.path.isfile(src) and not os.path.islink(src):
        print(f'  ! missing: {rel}', file=sys.stderr)
        continue
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    try:
        os.link(src, dst)
        linked += 1
    except OSError:
        shutil.copy2(src, dst, follow_symlinks=False)
        copied += 1

print(f'linked={linked} copied={copied}')

# 4. sanity: total size
total = subprocess.run(['du', '-sh', DEST], capture_output=True, text=True).stdout.strip()
print('snapshot size:', total)

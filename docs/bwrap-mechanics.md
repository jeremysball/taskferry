# bubblewrap overlay mechanics

How `--overlay-src` actually behaves, and what that means for a sandboxed
ferry. This covers the mount semantics only. For the sandbox's security
posture (what is masked, what is writable, why), see
[security.md](security.md).

Everything below was verified against bubblewrap 0.11.2 with the commands
shown. Re-run them if a claim here looks wrong.

## `--overlay-src` mounts, it does not copy

A sandboxed dispatch does not snapshot the target directory. `src/sandbox.js:302`
emits:

```
--overlay-src <directory> --overlay <upperDir> <workDir> <directory>
```

That is a kernel overlayfs mount: `<directory>` becomes the read-only lower
layer, `upperDir` takes every write, and the merged result is mounted back over
`<directory>` inside the namespace. No bytes are duplicated at setup, which is
why dispatching against a large worktree is instant.

Three consequences follow from it being a live mount rather than a copy.

### 1. Edits to the lower layer are visible immediately

Change a file on the host while a sandbox has it as a lower layer, and the
sandbox sees the new content on its next read. There is no snapshot boundary.

```sh
echo ORIGINAL > "$W/lower/f.txt"
bwrap --ro-bind / / --proc /proc --dev /dev --tmpfs /tmp \
  --overlay-src "$W/lower" --overlay "$W/upper" "$W/work" "$W/lower" \
  --unshare-all --share-net -- cat "$W/lower/f.txt"
# ORIGINAL

echo EDITED-IN-PLACE > "$W/lower/f.txt"
# same command again
# EDITED-IN-PLACE
```

This is the mechanism behind the `accept` precondition documented in
`using-taskferry`: editing a file while a ferry is running on it is not
isolated from that ferry.

### 2. A running mount pins the inode, not the path

Move the lower directory away mid-run and put a different directory at the same
path, and the running sandbox keeps serving the original content for its entire
lifetime. The mount holds a reference to the original dentry, so the path string
stops mattering the moment the mount is established.

```sh
# sandbox started at t=0 reading $W/lower/f.txt in a loop
mv "$W/lower" "$W/lower-gone"
mkdir "$W/lower"; echo REPLACEMENT > "$W/lower/f.txt"   # at t=2s
```

```
[host] host now reads: REPLACEMENT
t1: ORIGINAL
t2: ORIGINAL
t3: ORIGINAL     <- swap happened here
t4: ORIGINAL
t5: ORIGINAL
t6: ORIGINAL
```

The host and the sandbox disagree permanently, and nothing reports it. A ferry
in this state reads stale files, writes a diff against a tree that no longer
exists, and reports success. Deleting or recreating a worktree while a ferry is
running against it produces exactly this.

### 3. A new invocation resolves the path fresh

The pinning in (2) lasts only as long as the mount. Start a new `bwrap`, and it
resolves `<directory>` again and picks up whatever is there now:

```
new invocation sees: REPLACEMENT
```

So the failure in (2) is invisible to any check run after the fact. Re-running
the command shows the correct content, which makes a stale-mount incident look
like it never happened.

## How this interacts with ferries

**Mount order matters, and `/tmp` comes first.** `buildBwrapBaseArgs()`
(`src/sandbox.js:201`) emits `--ro-bind / /`, then `--proc /proc --dev /dev
--tmpfs /tmp`, then the deny-list tmpfs mounts, and only then the read-write
binds and overlays. bwrap applies mounts in argument order, and a later mount on
a parent shadows an earlier mount nested inside it, so `--tmpfs /tmp` has to
precede anything living under `/tmp`.

**A controller cannot see another ferry's `/tmp`.** Because `--tmpfs /tmp` runs
before the overlay, host `/tmp/<other-leaf>` is hidden behind an empty tmpfs, and
only the controller's own `--directory` gets mounted back. `git worktree add
/tmp/<new> HEAD` inside a sandboxed ferry fails with `Read-only file system`,
since `/workspace` is bound read-only. Pre-create the leaf worktrees on the host
before dispatching, or run the controller with `--no-sandbox`, or pass
`--rw-bind /tmp`. See the controller section in the repo's `CLAUDE.md`.

**Overlays live on a small tmpfs.** Upper and work dirs go under
`<runtimeDir>/overlay/taskferry-cow-<task-id>/{upper,work}/main`
(`src/paths.js:95`, overridable with `TASKFERRY_OVERLAY_TMP_DIR`). On a typical
box that is `/run/user/<uid>`, often 1-2G. Every unsettled task holds its overlay
indefinitely, because the daemon's startup sweep deliberately skips a `pending`
changeset (`sweepOverlayEntry`, `src/tasks.js:3495`). Enough of them fill the
tmpfs and the daemon dies with `ENOSPC`, taking every in-flight ferry with it.
Settle each task with `accept` or `reject`.

**Only `--directory` produces a diff.** There is one overlay, over
`--directory`. Other read-write paths (the git common dir, `runtimeDir`,
`--rw-bind` entries) are ordinary binds: writes there land on the host
immediately and never appear in `taskferry result --diff`, which extracts
relative to `--directory` alone.

## Rules of thumb

- Do not touch a directory a ferry is dispatched against while it runs.
- Never move or recreate a worktree with a live ferry in it. Behavior (2)
  makes that silent.
- Give each ferry its own `--directory`. Sharing one is what turns (1) into a
  corrupted changeset.

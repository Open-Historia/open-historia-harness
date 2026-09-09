// Sandbox safety guards — the layer everything else in the harness sits behind.
//
// A test server pointed at the real data directory destroyed a player's rollback
// snapshots on this machine once. Nothing here is theoretical.
//
// Two layers, in order of how much they are trusted:
//
//   1. assertSandboxed()  — the guarantee. Every path the harness writes to must
//      resolve INSIDE the sandbox root and OUTSIDE every protected tree (the game
//      repo, its server/data, and the main checkout's server/data). Callers ask
//      for permission explicitly; there is no ambient "probably fine".
//
//   2. installFsGuard()   — defence in depth. Wraps the write half of `fs` and
//      `fs.promises` so a store inside the game's own server code cannot write
//      outside the sandbox even if the harness forgot to ask. This is NOT a
//      guarantee: a module that does `import { writeFileSync } from "fs"` binds
//      the function at link time and never sees the wrapper. Layer 1 is the
//      guarantee; this catches mistakes, not adversaries.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let sandboxRoot = null;
let protectedRoots = [];
// Places that are legitimately writable but are not the sandbox: the harness's
// own runs/ directory, which holds journals and reports. Kept separate from the
// sandbox rather than folded into it, because run output must SURVIVE the
// sandbox being deleted — that is the whole point of journalling.
let allowedRoots = [];

// Windows paths are case-insensitive: C:\Users and c:\users are the SAME
// directory. Comparing raw strings would let a case variant read as "outside the
// sandbox", which is precisely backwards — the dangerous direction.
const norm = (p) =>
  process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p);

/**
 * True when `child` IS `parent` or lives beneath it.
 *
 * Uses path.relative rather than startsWith because startsWith("<root>") also
 * matches "<root>-evil" — a sibling directory that is emphatically not inside
 * the root. That prefix collision is the classic way a containment check leaks.
 */
export const isInside = (child, parent) => {
  const rel = path.relative(norm(parent), norm(child));
  if (rel === "") return true; // child IS parent
  if (rel === "..") return false;
  if (rel.startsWith(`..${path.sep}`)) return false;
  // A different Windows drive makes path.relative return an absolute path.
  return !path.isAbsolute(rel);
};

/**
 * Declare the sandbox and the trees that must never be written to. Must run
 * before any guarded write; assertSandboxed refuses to guess.
 */
export const configureSafety = ({ sandbox, protect = [], allow = [] } = {}) => {
  if (!sandbox) throw new Error("[harness safety] configureSafety needs a sandbox path");

  const resolvedSandbox = path.resolve(sandbox);
  const resolvedProtected = protect.filter(Boolean).map((p) => path.resolve(p));
  const resolvedAllowed = allow.filter(Boolean).map((p) => path.resolve(p));

  // An "allowed" path inside a protected tree would be a hole straight through
  // the guard, so it is refused rather than silently honoured.
  for (const writable of resolvedAllowed) {
    for (const guarded of resolvedProtected) {
      if (isInside(writable, guarded)) {
        throw new Error(
          `[harness safety] allowed path is inside a protected tree (${guarded}): ${writable}`,
        );
      }
    }
  }

  // A sandbox nested inside a protected tree would make every later assertion
  // self-contradictory. Catch that configuration error here rather than at the
  // first write, where it would surface as a baffling permission error.
  for (const guarded of resolvedProtected) {
    if (isInside(resolvedSandbox, guarded)) {
      throw new Error(
        `[harness safety] sandbox root is inside a protected tree (${guarded}): ${resolvedSandbox}`,
      );
    }
  }

  sandboxRoot = resolvedSandbox;
  protectedRoots = resolvedProtected;
  allowedRoots = resolvedAllowed;
  fs.mkdirSync(sandboxRoot, { recursive: true });
  return sandboxRoot;
};

export const getSandboxRoot = () => sandboxRoot;
export const getProtectedRoots = () => [...protectedRoots];

/** Test seam. Drops all configuration so a test can start from nothing. */
export const resetSafety = () => {
  sandboxRoot = null;
  protectedRoots = [];
  allowedRoots = [];
};

export const getAllowedRoots = () => [...allowedRoots];

/**
 * Throw unless `target` is a path the harness is allowed to write to.
 * Returns the resolved path so callers can use it directly.
 */
export const assertSandboxed = (target, what = "path") => {
  if (!sandboxRoot) {
    throw new Error("[harness safety] configureSafety() must run before any guarded write");
  }

  const resolved = path.resolve(target);

  // Protected first: when a path somehow satisfies both, the alarming message is
  // the useful one.
  for (const guarded of protectedRoots) {
    if (isInside(resolved, guarded)) {
      throw new Error(
        `[harness safety] ${what} is inside a protected tree (${guarded}): ${resolved}`,
      );
    }
  }

  if (isInside(resolved, sandboxRoot)) return resolved;
  if (allowedRoots.some((root) => isInside(resolved, root))) return resolved;

  throw new Error(
    `[harness safety] ${what} is outside the sandbox (${sandboxRoot}): ${resolved}`,
  );
};

/** True when the path is writable, without throwing. For reporting, not gating. */
export const isSandboxed = (target) => {
  try {
    assertSandboxed(target);
    return true;
  } catch {
    return false;
  }
};

/**
 * Copy a file OUT of a real tree and INTO the sandbox.
 *
 * Only the destination is asserted. The source is opened read-only and is
 * expected to be a protected path — that is the whole point of seeding. There is
 * no function in this harness that writes to a path derived from the game tree,
 * which makes "seeding cannot damage the source" true by construction rather
 * than by care.
 */
export const copyIn = (realSource, sandboxDest) => {
  const dest = assertSandboxed(sandboxDest, "seed destination");
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(path.resolve(realSource), dest);
  return dest;
};

/** Recursive copy into the sandbox, same one-way rule as copyIn. */
export const copyDirIn = (realSource, sandboxDest) => {
  const dest = assertSandboxed(sandboxDest, "seed destination");
  fs.cpSync(path.resolve(realSource), dest, { recursive: true });
  return dest;
};

// ---------------------------------------------------------------------------
// Layer 2: the fs write interceptor
// ---------------------------------------------------------------------------

// Which argument positions name a path that the call will CREATE, MODIFY or
// DESTROY. Read-only arguments are deliberately left unguarded so seeding can
// read from protected trees.
//
//   rename           both — the source is destroyed, not just read
//   link / symlink   both — creating an alias INTO protected data is how a later
//                    innocent-looking write truncates the real file through the
//                    link. This is the regions.geojson hazard, refused at source.
//   copyFile / cp    destination only — the source is genuinely read-only, and
//                    this is the call copyIn() depends on
const GUARDED = {
  appendFile: [0],
  appendFileSync: [0],
  chmod: [0],
  chmodSync: [0],
  copyFile: [1],
  copyFileSync: [1],
  cp: [1],
  cpSync: [1],
  createWriteStream: [0],
  link: [0, 1],
  linkSync: [0, 1],
  mkdir: [0],
  mkdirSync: [0],
  mkdtemp: [0],
  mkdtempSync: [0],
  rename: [0, 1],
  renameSync: [0, 1],
  rm: [0],
  rmSync: [0],
  rmdir: [0],
  rmdirSync: [0],
  symlink: [0, 1],
  symlinkSync: [0, 1],
  truncate: [0],
  truncateSync: [0],
  unlink: [0],
  unlinkSync: [0],
  utimes: [0],
  utimesSync: [0],
  writeFile: [0],
  writeFileSync: [0],
};

// open() only matters when the flags ask to write; guarding read opens would
// break every legitimate read of the game tree.
const WRITE_FLAG_NAMES = ["open", "openSync"];

const toPath = (value) => {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString();
  if (value instanceof URL) return fileURLToPath(value);
  // A file descriptor or an options object: not a path we can check here. The
  // open() that produced the descriptor was itself guarded.
  return null;
};

const flagsRequestWrite = (flags) => {
  if (flags === undefined || flags === null) return false; // defaults to "r"
  if (typeof flags === "number") {
    const { O_WRONLY, O_RDWR, O_APPEND, O_CREAT, O_TRUNC } = fs.constants;
    return Boolean(flags & (O_WRONLY | O_RDWR | O_APPEND | O_CREAT | O_TRUNC));
  }
  return /[wa+]/.test(String(flags));
};

let installed = null;

/**
 * Wrap the write half of fs and fs.promises. Install BEFORE importing the game's
 * server so namespace-property lookups (`fs.writeFileSync(...)`) resolve to the
 * wrapper.
 */
export const installFsGuard = () => {
  if (installed) return installed.uninstall;
  if (!sandboxRoot) {
    throw new Error("[harness safety] configureSafety() must run before installFsGuard()");
  }

  const originals = new Map();

  // The promise-returning half of fs must REJECT rather than throw synchronously.
  // A caller writing `fs.promises.writeFile(...).catch(handle)` would otherwise
  // get an exception from a line it never expected to throw, which turns a clear
  // safety refusal into a confusing crash somewhere else. Sync and callback forms
  // keep throwing: loud is the point, and a callback error is too easy to swallow.
  const wrap = (host, label, name, positions, isAsync) => {
    const original = host[name];
    if (typeof original !== "function") return;
    originals.set(`${label}.${name}`, { host, name, original });

    host[name] = function guarded(...args) {
      try {
        for (const position of positions) {
          const candidate = toPath(args[position]);
          if (candidate !== null) assertSandboxed(candidate, `fs.${name} argument ${position}`);
        }
      } catch (error) {
        if (isAsync) return Promise.reject(error);
        throw error;
      }
      return original.apply(this, args);
    };
  };

  const wrapOpen = (host, label, name, isAsync) => {
    const original = host[name];
    if (typeof original !== "function") return;
    originals.set(`${label}.${name}`, { host, name, original });

    host[name] = function guardedOpen(...args) {
      const candidate = toPath(args[0]);
      // fs.promises.open(path, flags) and fs.open(path, flags, mode, cb) both
      // carry the flags in argument 1.
      if (candidate !== null && flagsRequestWrite(args[1])) {
        try {
          assertSandboxed(candidate, `fs.${name} (write flags)`);
        } catch (error) {
          if (isAsync) return Promise.reject(error);
          throw error;
        }
      }
      return original.apply(this, args);
    };
  };

  for (const [name, positions] of Object.entries(GUARDED)) {
    wrap(fs, "fs", name, positions, false);
    if (fs.promises && name in fs.promises) wrap(fs.promises, "promises", name, positions, true);
  }
  for (const name of WRITE_FLAG_NAMES) {
    wrapOpen(fs, "fs", name, false);
  }
  if (fs.promises) wrapOpen(fs.promises, "promises", "open", true);

  const uninstall = () => {
    for (const { host, name, original } of originals.values()) host[name] = original;
    originals.clear();
    installed = null;
  };

  installed = { uninstall };
  return uninstall;
};

export const uninstallFsGuard = () => {
  installed?.uninstall();
};

export const isFsGuardInstalled = () => Boolean(installed);

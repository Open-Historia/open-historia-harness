// Keeping the user's home folder out of text a report may be pasted from.

import assert from "node:assert/strict";
import test from "node:test";

import { hideHomeDir } from "./redact.js";

const HOME = "C:\\Users\\Some Name";

test("a path under the home folder is shown from %USERPROFILE%", () => {
  assert.equal(
    hideHomeDir(`node cli.js --hunt --save-zip "C:\\Users\\Some Name\\Downloads\\x-game.zip"`, { home: HOME, platform: "win32" }),
    `node cli.js --hunt --save-zip "%USERPROFILE%\\Downloads\\x-game.zip"`,
  );
});

test("on Windows a different case of the same folder is still the home folder", () => {
  assert.equal(
    hideHomeDir("c:\\users\\some name\\Downloads\\x.zip", { home: HOME, platform: "win32" }),
    "%USERPROFILE%\\Downloads\\x.zip",
  );
});

test("forward slashes are the same folder too", () => {
  assert.equal(hideHomeDir("C:/Users/Some Name/Downloads/x.zip", { home: HOME, platform: "win32" }), "%USERPROFILE%/Downloads/x.zip");
});

test("a sibling folder that only starts with the same name is left alone", () => {
  const text = "C:\\Users\\Some Name-evil\\x.zip";
  assert.equal(hideHomeDir(text, { home: HOME, platform: "win32" }), text);
});

test("elsewhere, the home folder is ~ and matched exactly", () => {
  assert.equal(hideHomeDir("/home/someone/Downloads/x.zip", { home: "/home/someone", platform: "linux" }), "~/Downloads/x.zip");
  assert.equal(hideHomeDir("/home/Someone/x.zip", { home: "/home/someone", platform: "linux" }), "/home/Someone/x.zip");
});

test("with no home folder known, nothing changes", () => {
  assert.equal(hideHomeDir("C:\\Users\\Some Name\\x.zip", { home: "", platform: "win32" }), "C:\\Users\\Some Name\\x.zip");
});

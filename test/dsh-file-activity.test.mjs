import test from "node:test";
import assert from "node:assert/strict";
import { activityItem, summarizeActivity } from "../runtime/core/index.mjs";

const timestamp = "2026-10-01T12:00:00.000Z";
const call = (name, args, id = name, time = timestamp) => activityItem({ type: "response_item", payload: {
  type: "function_call", name, call_id: id, arguments: JSON.stringify(args),
} }, id, time);
const patch = (input, id = "patch") => activityItem({ type: "response_item", payload: {
  type: "custom_tool_call", name: "functions.apply_patch", call_id: id, input,
} }, id, timestamp);
const reportOf = items => summarizeActivity(items, false, null, null);

test("file activity classifies explicit path aliases while keeping arguments private", () => {
  const items = [
    call("mcp__filesystem__read_file", { path: "src/main.ts", note: "private read note" }, "read"),
    call("write_file", { file_path: "src/main.ts", content: "private source" }, "write"),
    call("search_files", { filename: "src/main.ts", query: "private query" }, "search"),
    call("functions.view_image", { path: "design.png" }, "image"),
    call("unknown_tool", { path: "unknown.bin" }, "other"),
  ];
  const report = reportOf(items);
  const file = report.files.find(f => f.path === "src/main.ts");
  assert.equal(file.calls, 3);
  assert.equal(file.readCalls, 1);
  assert.equal(file.writeCalls, 1);
  assert.equal(file.searchCalls, 1);
  assert.equal(file.imageCalls, 0);
  assert.equal(file.addedLines, null);
  assert.equal(file.removedLines, null);
  assert.equal(file.characters, items.slice(0, 3).reduce((sum, item) => sum + item.characters, 0));
  assert.deepEqual(file.itemIds, ["read", "write", "search"]);
  assert.equal(report.files.find(f => f.path === "design.png").imageCalls, 1);
  assert.equal(items[4].fileOperations[0].kind, "other");
  assert.equal(report.files.find(f => f.path === "unknown.bin").addedLines, null);
  const serialized = JSON.stringify(report);
  for (const secret of ["private read note", "private source", "private query"]) assert.ok(!serialized.includes(secret));
});

test("file activity never evaluates code or guesses targets from messages and shell strings", () => {
  const items = [
    call("exec_command", { cmd: "Get-Content -LiteralPath 'secrets.txt'" }),
    call("functions.exec", { code: "await tools.read_file({ path: 'secrets.txt' }); throw new Error('do not execute')" }),
    call("read_file", { description: "read secrets.txt", content: '{"path":"secrets.txt"}' }),
    activityItem({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ text: '{"path":"secrets.txt"}' }] } }, "message", timestamp),
    activityItem({ type: "response_item", payload: { type: "function_call", name: "read_file", arguments: "not valid JSON, path: secrets.txt" } }, "invalid", timestamp),
  ];
  assert.deepEqual(reportOf(items).files, []);
  assert.ok(items.every(item => item.file === null && item.fileOperations === undefined));
  const unsupported = call("bread_file", { path: "explicit.txt" });
  assert.equal(unsupported.fileOperations[0].kind, "other");
});

test("structured object inputs accept filename metadata and reject malformed path values", () => {
  const item = activityItem({ type: "response_item", payload: {
    type: "custom_tool_call", name: "read_file", input: { filename: "D:\\project files\\中文.txt" },
  } }, "object-input", timestamp);
  assert.equal(item.file, "D:\\project files\\中文.txt");
  assert.equal(item.fileOperations[0].kind, "read");
  for (const value of [null, 123, ["array.txt"], {}, "", "  ", "nul\0.txt", "line\nbreak.txt"]) {
    assert.equal(call("read_file", { path: value }).file, null);
  }
  const fallback = call("read_file", { path: 123, file_path: "explicit-fallback.txt" });
  assert.equal(fallback.file, "explicit-fallback.txt");
});

test("standard multi-file apply_patch records exact hunk counts and unknown deleted contents", () => {
  const input = [
    "*** Begin Patch",
    "*** Update File: src/main.ts",
    "@@",
    "-private old code",
    "+private new code",
    "+another new line",
    " unchanged context",
    "*** Add File: notes/新文件.md",
    "+first line",
    "+",
    "*** Delete File: old.txt",
    "*** End Patch",
  ].join("\r\n");
  const item = patch(input);
  assert.equal(item.file, "src/main.ts");
  assert.deepEqual(item.fileOperations, [
    { path: "src/main.ts", kind: "write", addedLines: 2, removedLines: 1 },
    { path: "notes/新文件.md", kind: "write", addedLines: 2, removedLines: 0 },
    { path: "old.txt", kind: "write", addedLines: 0, removedLines: null },
  ]);
  const report = reportOf([item]);
  assert.equal(report.files.length, 3);
  for (const file of report.files) {
    assert.equal(file.calls, 1);
    assert.equal(file.writeCalls, 1);
    assert.equal(file.lastAt, timestamp);
    assert.deepEqual(file.itemIds, ["patch"]);
  }
  assert.equal(report.files.find(f => f.path === "old.txt").removedLines, null);
  assert.ok(!JSON.stringify(report).includes("private old code"));
  assert.ok(!JSON.stringify(report).includes("private new code"));
});

test("tool results including repeated patch output do not count another file operation", () => {
  const item = patch("*** Begin Patch\n*** Add File: new.txt\n+hello\n*** End Patch");
  const result = id => activityItem({ type: "response_item", payload: {
    type: "custom_tool_call_output", call_id: "patch", output: '{"path":"new.txt","addedLines":900}',
  } }, id, timestamp);
  const report = reportOf([item, result("result-1"), result("result-2")]);
  assert.equal(report.tools[0].calls, 1);
  assert.equal(report.tools[0].results, 2);
  assert.equal(report.files[0].calls, 1);
  assert.equal(report.files[0].writeCalls, 1);
  assert.equal(report.files[0].addedLines, 1);
  assert.deepEqual(report.files[0].itemIds, ["patch"]);
  assert.ok(report.items.slice(1).every(record => record.file === null && record.fileOperations === undefined));
});

test("malformed or unrelated free-form patch text is not treated as structured file metadata", () => {
  for (const input of [
    "*** Begin Patch\n*** Add File: fake.txt\n+content",
    "*** Begin Patch\n*** Add File: fake.txt\nnot an added line\n*** End Patch",
    "prefix\n*** Begin Patch\n*** Add File: fake.txt\n+content\n*** End Patch",
    "*** Begin Patch\n*** Delete File: fake.txt\n-content\n*** End Patch",
  ]) assert.equal(patch(input).file, null);
  const item = activityItem({ type: "response_item", payload: {
    type: "custom_tool_call", name: "unrelated_tool", input: "*** Begin Patch\n*** Add File: fake.txt\n+content\n*** End Patch",
  } }, "unrelated", timestamp);
  assert.equal(item.file, null);
});

test("renaming a patched file records both explicit targets without inventing full-file line counts", () => {
  const item = patch("*** Begin Patch\n*** Update File: before.ts\n*** Move to: after.ts\n@@\n-old\n+new\n*** End Patch");
  const report = reportOf([item]);
  assert.deepEqual(report.files.map(file => file.path), ["before.ts", "after.ts"]);
  for (const file of report.files) {
    assert.equal(file.writeCalls, 1);
    assert.equal(file.addedLines, null);
    assert.equal(file.removedLines, null);
  }
});

test("multiple hunks for one target count one call and aggregate the requested line changes", () => {
  const item = patch("*** Begin Patch\n*** Update File: same.ts\n@@\n-a\n+b\n*** Update File: same.ts\n@@\n-c\n+d\n+e\n*** End Patch");
  const file = reportOf([item]).files[0];
  assert.equal(file.calls, 1);
  assert.equal(file.writeCalls, 1);
  assert.equal(file.characters, item.characters);
  assert.equal(file.addedLines, 3);
  assert.equal(file.removedLines, 2);
  assert.deepEqual(file.itemIds, ["patch"]);
});

test("uncertain writes remain unknown and last activity follows timestamps rather than array order", () => {
  const known = patch("*** Begin Patch\n*** Add File: target.txt\n+one\n*** End Patch", "known");
  const unknown = call("write_file", { path: "target.txt", content: "one\ntwo\n" }, "unknown", "2026-10-01T12:02:00.000Z");
  const olderRead = call("read_file", { path: "target.txt" }, "read", "2026-10-01T11:00:00.000Z");
  const file = reportOf([known, unknown, olderRead]).files[0];
  assert.equal(file.calls, 3);
  assert.equal(file.readCalls, 1);
  assert.equal(file.writeCalls, 2);
  assert.equal(file.addedLines, null);
  assert.equal(file.removedLines, null);
  assert.equal(file.lastAt, unknown.timestamp);
  assert.deepEqual(file.itemIds, ["known", "unknown", "read"]);
  assert.equal(known.fileOperations[0].addedLines, 1);
});

test("legacy file-only calls stay compatible and result metadata cannot inflate file totals", () => {
  const original = call("read_file", { path: "legacy.txt" }, "legacy");
  const legacy = { ...original };
  delete legacy.fileOperations;
  const result = { ...original, id: "result", category: "tool_result", characters: 9999 };
  const file = reportOf([legacy, result]).files[0];
  assert.equal(file.path, "legacy.txt");
  assert.equal(file.calls, 1);
  assert.equal(file.characters, original.characters);
  assert.equal(file.readCalls, 1);
  assert.equal(file.addedLines, 0);
  assert.equal(file.removedLines, 0);
  assert.deepEqual(file.itemIds, ["legacy"]);
});

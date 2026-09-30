// src/project-registry.ts
import { promises as fs } from "node:fs";
import path from "node:path";
async function discoverProjects(codexHome) {
  const files = await fs.readdir(codexHome).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const databases = files.filter((file) => /^state_\d+\.sqlite$/u.test(file)).sort((a, b) => Number(b.match(/\d+/u)[0]) - Number(a.match(/\d+/u)[0]));
  if (databases.length) {
    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(path.join(codexHome, databases[0]), { readOnly: true });
    try {
      const hasProjects = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='projects'").get();
      if (hasProjects) {
        const rows = database.prepare("SELECT p.id, p.name, r.path FROM projects p JOIN project_roots r ON r.project_id=p.id WHERE r.position=0 ORDER BY p.position").all();
        const projects2 = rows.map((row) => {
          if (typeof row.id !== "string" || typeof row.name !== "string" || typeof row.path !== "string" || !path.isAbsolute(row.path)) throw new Error("Invalid project registry entry");
          return { id: row.id, name: row.name, root: path.resolve(row.path) };
        });
        return { projects: projects2, source: databases[0], complete: true };
      }
    } finally {
      database.close();
    }
  }
  const stateFile = path.join(codexHome, ".codex-global-state.json");
  let raw;
  try {
    raw = await fs.readFile(stateFile, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { projects: [], source: "unavailable", complete: false };
    throw error;
  }
  const state = JSON.parse(raw);
  if (!state["local-projects"] || typeof state["local-projects"] !== "object" || Array.isArray(state["local-projects"])) throw new Error("Unrecognized project registry");
  const projects = [];
  for (const [id, value] of Object.entries(state["local-projects"])) {
    const project = value;
    if (!Array.isArray(project.rootPaths) || typeof project.rootPaths[0] !== "string" || !path.isAbsolute(project.rootPaths[0])) throw new Error("Invalid legacy project entry");
    projects.push({ id, name: typeof project.name === "string" ? project.name : id, root: path.resolve(project.rootPaths[0]) });
  }
  return { projects, source: ".codex-global-state.json", complete: true };
}

// src/project-actions.ts
import { createHash, randomUUID } from "node:crypto";
import { promises as fs2 } from "node:fs";
import { homedir } from "node:os";
import path2 from "node:path";

// node_modules/smol-toml/dist/error.js
function getLineColFromPtr(string, ptr) {
  let lines = string.slice(0, ptr).split(/\r?\n/);
  return [lines.length, lines.pop().length + 1];
}
function makeCodeBlock(string, line, column) {
  let lines = string.split(/\r?\n/);
  let codeblock = "";
  let numberLen = (Math.log10(line + 1) | 0) + 1;
  for (let i = line - 1; i <= line + 1; i++) {
    let l = lines[i - 1];
    if (!l)
      continue;
    codeblock += i.toString().padEnd(numberLen, " ");
    codeblock += ":  ";
    codeblock += l;
    codeblock += "\n";
    if (i === line) {
      codeblock += " ".repeat(numberLen + column + 2);
      codeblock += "^\n";
    }
  }
  return codeblock;
}
var TomlError = class _TomlError extends Error {
  line;
  column;
  codeblock;
  constructor(message, options) {
    const [line, column] = getLineColFromPtr(options.toml, options.ptr);
    const codeblock = makeCodeBlock(options.toml, line, column);
    super(`Invalid TOML document: ${message}

${codeblock}`, options);
    this.line = line;
    this.column = column;
    this.codeblock = codeblock;
  }
  /** @internal */
  static x(message, ctx, ptr) {
    throw new _TomlError(message, { toml: ctx.s, ptr: ptr ?? ctx.p });
  }
};

// node_modules/smol-toml/dist/primitive.js
function parseString(ctx) {
  let startPtr = ctx.p;
  let c = ctx.s.charCodeAt(ctx.p++);
  let first = c;
  let isLiteral = c === 39;
  let isMultiline = c === ctx.s.charCodeAt(ctx.p) && c === ctx.s.charCodeAt(ctx.p + 1);
  if (isMultiline) {
    if ((c = ctx.s.charCodeAt(ctx.p += 2)) === 10)
      ctx.p++;
    else if (c === 13 && ctx.s.charCodeAt(ctx.p + 1) === 10)
      ctx.p += 2;
  }
  let parsed = "";
  let sliceStart = ctx.p;
  let state = 0;
  for (; ctx.p < ctx.s.length; ctx.p++) {
    c = ctx.s.charCodeAt(ctx.p);
    if (isMultiline && (c === 10 || c === 13 && ctx.s.charCodeAt(ctx.p + 1) === 10)) {
      state = state && 3;
    } else if (c < 32 && c !== 9 || c === 127) {
      TomlError.x("control characters are not allowed in strings", ctx);
    } else if ((!state || state === 3) && c === first && (!isMultiline || ctx.s.charCodeAt(ctx.p + 1) === first && ctx.s.charCodeAt(ctx.p + 2) === first)) {
      if (isMultiline) {
        if (ctx.s.charCodeAt(ctx.p + 3) === first)
          ctx.p++;
        if (ctx.s.charCodeAt(ctx.p + 3) === first)
          ctx.p++;
      }
      if (!state) {
        let s = ctx.s.slice(sliceStart, ctx.p);
        parsed = parsed ? parsed + s : s;
      }
      ctx.p += isMultiline ? 3 : 1;
      return parsed;
    } else if (!state) {
      if (!isLiteral && c === 92) {
        parsed += ctx.s.slice(sliceStart, sliceStart = ctx.p);
        state = 1;
      }
    } else if (state === 1) {
      if (c === 120 || c === 117 || c === 85) {
        let errPtr = ctx.p++ - 1;
        let value = 0;
        let len = c === 120 ? 2 : c === 117 ? 4 : 8;
        for (let j = 0; j < len; j++, ctx.p++) {
          let hex = ctx.s.charCodeAt(ctx.p);
          let digit = (
            /* 0-9 */
            hex >= 48 && hex <= 57 ? hex - 48 : (
              /* A-F */
              hex >= 65 && hex <= 70 ? hex - 65 + 10 : (
                /* a-f */
                hex >= 97 && hex <= 102 ? hex - 97 + 10 : -1
              )
            )
          );
          if (digit < 0)
            TomlError.x("invalid non-hex character in unicode escape", ctx);
          value = value << 4 | digit;
        }
        if (value < 0 || value > 1114111 || value >= 55296 && value <= 57343) {
          TomlError.x("invalid unicode escape", ctx, errPtr);
        }
        parsed += String.fromCodePoint(value);
        sliceStart = ctx.p--;
        state = 0;
      } else if (isMultiline && (c === 32 || c === 9)) {
        state = 2;
      } else {
        if (c === 98)
          parsed += "\b";
        else if (c === 116)
          parsed += "	";
        else if (c === 110)
          parsed += "\n";
        else if (c === 102)
          parsed += "\f";
        else if (c === 114)
          parsed += "\r";
        else if (c === 101)
          parsed += "\x1B";
        else if (c === 34)
          parsed += '"';
        else if (c === 92)
          parsed += "\\";
        else
          TomlError.x("unrecognised escape sequence", ctx);
        sliceStart = ctx.p + 1;
        state = 0;
      }
    } else if (c !== 32 && c !== 9) {
      if (state === 2)
        TomlError.x("invalid escape: only line-ending whitespace may be escaped", ctx, sliceStart);
      state = !isLiteral && c === 92 ? 1 : 0;
      sliceStart = ctx.p;
    }
  }
  TomlError.x("unfinished string", ctx, startPtr);
}

// node_modules/smol-toml/dist/date.js
var DATE_TIME_RE = /^(\d{4}-\d{2}-\d{2})?[Tt ]?(?:(\d{2}):\d{2}(?::\d{2}(?:\.\d+)?)?)?(Z|z|[-+]\d{2}:\d{2})?$/i;
var TomlDate = class _TomlDate extends Date {
  #hasDate = false;
  #hasTime = false;
  #offset = null;
  constructor(date, fasttype, unsafeDelim) {
    let hasDate = true;
    let hasTime = true;
    let offset = "Z";
    let c;
    if (typeof date === "string") {
      if (fasttype)
        prep: {
          if (fasttype < 3) {
            if (+date.slice(11, 13) > 23) {
              date = "";
              break prep;
            }
            if (fasttype === 2) {
              offset = null;
              date += "Z";
            } else if ((c = date.charCodeAt(date.length - 1)) !== 90 && c !== 122) {
              offset = date.slice(date.length - 6);
            }
            if (unsafeDelim)
              date = date.slice(0, 10) + "T" + date.slice(11);
          } else if (fasttype === 4) {
            date = +date.slice(0, 2) > 23 ? "" : `0000-01-01T${date}Z`;
          }
          hasDate = fasttype !== 4;
          hasTime = fasttype !== 3;
        }
      else {
        let match = date.match(DATE_TIME_RE);
        if (match) {
          if (!match[1]) {
            hasDate = false;
            date = `0000-01-01T${date}`;
          }
          hasTime = !!match[2];
          hasTime && date[10] === " " && (date = date.replace(" ", "T"));
          if (match[2] && +match[2] > 23) {
            date = "";
          } else {
            offset = match[3] || null;
            if (!offset && hasTime)
              date += "Z";
          }
        } else {
          date = "";
        }
      }
    }
    super(date);
    if (!isNaN(this.getTime())) {
      this.#hasDate = hasDate;
      this.#hasTime = hasTime;
      this.#offset = offset;
    }
  }
  isDateTime() {
    return this.#hasDate && this.#hasTime;
  }
  isLocal() {
    return !this.#hasDate || !this.#hasTime || !this.#offset;
  }
  isDate() {
    return this.#hasDate && !this.#hasTime;
  }
  isTime() {
    return this.#hasTime && !this.#hasDate;
  }
  isValid() {
    return this.#hasDate || this.#hasTime;
  }
  toISOString() {
    let iso = super.toISOString();
    if (this.isDate())
      return iso.slice(0, 10);
    if (this.isTime())
      return iso.slice(11, 23);
    if (this.#offset === null)
      return iso.slice(0, -1);
    if (this.#offset === "Z" || this.#offset === "z")
      return iso;
    let offset = +this.#offset.slice(1, 3) * 60 + +this.#offset.slice(4, 6);
    offset = this.#offset[0] === "-" ? offset : -offset;
    let offsetDate = new Date(this.getTime() - offset * 6e4);
    return offsetDate.toISOString().slice(0, -1) + this.#offset;
  }
  static wrapAsOffsetDateTime(jsDate, offset = "Z") {
    let date = new _TomlDate(jsDate);
    date.#offset = offset;
    return date;
  }
  static wrapAsLocalDateTime(jsDate) {
    let date = new _TomlDate(jsDate);
    date.#offset = null;
    return date;
  }
  static wrapAsLocalDate(jsDate) {
    let date = new _TomlDate(jsDate);
    date.#hasTime = false;
    date.#offset = null;
    return date;
  }
  static wrapAsLocalTime(jsDate) {
    let date = new _TomlDate(jsDate);
    date.#hasDate = false;
    date.#offset = null;
    return date;
  }
};

// node_modules/smol-toml/dist/extract.js
function isDigit(char, base = 10) {
  return base === 16 ? char > 47 && char < 58 || char > 64 && char < 71 || char > 96 && char < 103 : char > 47 && char < 48 + base;
}
function isEndOfValue(char, delim) {
  return char === 32 || char === 9 || char === 10 || char === 13 || // Structure end or next value delimiter
  delim && (char === delim || char === 44) || // Comment
  char === 35;
}
function extractValue(ctx, end) {
  let errPtr = ctx.p;
  let c = ctx.s.charCodeAt(ctx.p);
  if (c === 91 || c === 123) {
    ctx.d-- || TomlError.x("document contains excessively nested structures. aborting.", ctx);
    let value = c === 91 ? parseArray(ctx) : parseInlineTable(ctx);
    ctx.d++;
    return value;
  }
  if (c === 34 || c === 39) {
    return parseString(ctx);
  }
  if (c === 116) {
    if (ctx.s.charCodeAt(++ctx.p) !== 114 || ctx.s.charCodeAt(++ctx.p) !== 117 || ctx.s.charCodeAt(++ctx.p) !== 101)
      TomlError.x("invalid value", ctx, errPtr);
    return ctx.p++, true;
  }
  if (c === 102) {
    if (ctx.s.charCodeAt(++ctx.p) !== 97 || ctx.s.charCodeAt(++ctx.p) !== 108 || ctx.s.charCodeAt(++ctx.p) !== 115 || ctx.s.charCodeAt(++ctx.p) !== 101)
      TomlError.x("invalid value", ctx, errPtr);
    return ctx.p++, false;
  }
  if (c === 43 || c === 45) {
    return parseNumber(ctx, ctx.p, ctx.s.charCodeAt(++ctx.p), 44 - c, end);
  }
  if (ctx.s.charCodeAt(ctx.p + 4) === 45 && ctx.s.charCodeAt(ctx.p + 7) === 45) {
    return parseDate(ctx, c, end);
  }
  if (ctx.s.charCodeAt(ctx.p + 2) === 58) {
    return parseTime(ctx, c, end);
  }
  return parseNumber(ctx, ctx.p, c, 0, end);
}
function parseNumber(ctx, startPtr, startChr, sign, endChr) {
  let c = startChr;
  let state = 0;
  let hasUnderscores = false;
  if (c === 105) {
    if (ctx.s.charCodeAt(++ctx.p) !== 110 || ctx.s.charCodeAt(++ctx.p) !== 102)
      TomlError.x("invalid value", ctx, startPtr);
    return ctx.p++, (sign || 1) / 0;
  }
  if (c === 110) {
    if (ctx.s.charCodeAt(++ctx.p) !== 97 || ctx.s.charCodeAt(++ctx.p) !== 110)
      TomlError.x("invalid value", ctx, startPtr);
    return ctx.p++, NaN;
  }
  if (c === 48) {
    if (++ctx.p >= ctx.s.length || isEndOfValue(c = ctx.s.charCodeAt(ctx.p), endChr))
      return ctx.bi === true ? 0n : 0;
    if (!sign) {
      if (c === 120)
        return parseIntegerBaseN(ctx, startPtr, 16, endChr);
      else if (c === 98)
        return parseIntegerBaseN(ctx, startPtr, 2, endChr);
      else if (c === 111)
        return parseIntegerBaseN(ctx, startPtr, 8, endChr);
    }
    if (c === 46)
      state = 2;
    else if (c === 101 || c === 69)
      state = 4;
    else
      TomlError.x("illegal leading zero", ctx, startPtr);
  } else if (!isDigit(c))
    TomlError.x("invalid value", ctx, startPtr);
  while (++ctx.p < ctx.s.length && (c = ctx.s.charCodeAt(ctx.p), !isEndOfValue(c, endChr))) {
    if (!state)
      state = 1;
    if (c === 95) {
      if (!(state & 1))
        TomlError.x("illegal underscore", ctx);
      state += 11;
      hasUnderscores = true;
    } else if (state === 1 && c === 46)
      state = 2;
    else if ((state === 1 || state === 3) && (c === 101 || c === 69))
      state = 4;
    else if (state === 4 && (c === 43 || c === 45)) {
    } else if (!isDigit(c))
      TomlError.x(`illegal character in numeric literal`, ctx);
    else if (state > 9)
      state -= 11;
    else if (!(state & 1))
      state++;
  }
  if (!state) {
    let val = (startChr - 48) * (sign || 1);
    return ctx.bi === true ? BigInt(val) : val;
  }
  if (!(state & 1))
    TomlError.x("unfinished numeric value", ctx, startPtr);
  let str = ctx.s.slice(startPtr, ctx.p);
  if (hasUnderscores)
    str = str.replaceAll("_", "");
  return state > 1 ? parseFloat(str) : parseInteger(ctx, str, 10, startPtr);
}
function parseIntegerBaseN(ctx, startPtr, base, endChr) {
  let c, underscore = 1;
  while (++ctx.p < ctx.s.length && (c = ctx.s.charCodeAt(ctx.p), !isEndOfValue(c, endChr))) {
    if (c === 95) {
      if (underscore & 1)
        TomlError.x("illegal underscore", ctx);
      underscore = 3;
    } else if (!isDigit(c, base))
      TomlError.x(`illegal character in numeric literal`, ctx);
    else if (underscore & 1)
      underscore--;
  }
  if (underscore & 1)
    TomlError.x("unfinished numeric value", ctx);
  let str = ctx.s.slice(startPtr + 2, ctx.p);
  if (underscore)
    str = str.replaceAll("_", "");
  return parseInteger(ctx, str, base, startPtr);
}
function parseInteger(ctx, str, base, startPtr) {
  if (ctx.bi !== true)
    int: {
      let val = parseInt(str, base);
      if (!Number.isSafeInteger(val)) {
        if (ctx.bi)
          break int;
        TomlError.x("integer value cannot be represented losslessly", ctx, startPtr);
      }
      return val;
    }
  return base === 10 ? BigInt(str) : BigInt((base === 2 ? "0b" : base === 8 ? "0o" : "0x") + str);
}
function parseDate(ctx, c, endChr) {
  let startPtr = ctx.p++, unsafeSeparator;
  if (!isDigit(c) || !isDigit(ctx.s.charCodeAt(ctx.p++)) || !isDigit(ctx.s.charCodeAt(ctx.p++)) || !isDigit(ctx.s.charCodeAt(ctx.p++))) {
    return parseNumber(ctx, ctx.p = startPtr, c, 0, endChr);
  }
  ctx.p += 5;
  if (!isDigit(ctx.s.charCodeAt(ctx.p++)))
    TomlError.x("invalid date-time: date part is malformed", ctx, startPtr);
  if (ctx.p >= ctx.s.length || ((c = ctx.s.charCodeAt(ctx.p)) !== 32 || (unsafeSeparator = true, !isDigit(ctx.s.charCodeAt(ctx.p + 1)))) && c !== 84 && c !== 116) {
    let t2 = ctx.s.slice(startPtr, ctx.p);
    return readDate(ctx, t2, 3, false, startPtr);
  }
  if (ctx.s.charCodeAt(ctx.p += 3) !== 58)
    TomlError.x("invalid date-time: time part is malformed", ctx, startPtr);
  if (ctx.s.charCodeAt(ctx.p += 3) === 58)
    ctx.p += 3;
  if (ctx.s.charCodeAt(ctx.p) === 46)
    while (isDigit(ctx.s.charCodeAt(++ctx.p)))
      ;
  if (c = ctx.s.charCodeAt(ctx.p)) {
    if (c === 90 || c === 122) {
      let t2 = ctx.s.slice(startPtr, ++ctx.p);
      return readDate(ctx, t2, 1, unsafeSeparator, startPtr, "[+00:00]");
    }
    if (c === 43 || c === 45) {
      let t2 = ctx.s.slice(startPtr, ctx.p += 6);
      return readDate(ctx, t2, 1, unsafeSeparator, startPtr, !ctx.ld && "[" + ctx.s.slice(ctx.p - 6, ctx.p) + "]");
    }
  }
  let t = ctx.s.slice(startPtr, ctx.p);
  return readDate(ctx, t, 2, unsafeSeparator, startPtr);
}
function parseTime(ctx, c, endChr) {
  let start = ctx.p;
  if (!isDigit(c) || !isDigit(ctx.s.charCodeAt(++ctx.p))) {
    return parseNumber(ctx, --ctx.p, c, 0, endChr);
  }
  if (ctx.s.charCodeAt(ctx.p += 4) === 58)
    ctx.p += 3;
  if (ctx.s.charCodeAt(ctx.p) === 46)
    while (isDigit(ctx.s.charCodeAt(++ctx.p)))
      ;
  let t = ctx.s.slice(start, ctx.p);
  return readDate(ctx, t, 4, false, start);
}
function readDate(ctx, str, type, unsafeDelim, errPtr, temporalSuffix) {
  if (ctx.ld) {
    let date = new TomlDate(str, type, unsafeDelim);
    if (!date.isValid())
      TomlError.x("invalid date", ctx, errPtr);
    return date;
  }
  try {
    if (temporalSuffix)
      str += temporalSuffix;
    switch (type) {
      case 1:
        return Temporal.ZonedDateTime.from(str);
      case 2:
        return Temporal.PlainDateTime.from(str);
      case 3:
        return Temporal.PlainDate.from(str);
      case 4:
        return Temporal.PlainTime.from(str);
    }
  } catch (e) {
    TomlError.x(e instanceof Error ? e.message : "" + e, ctx, errPtr);
  }
}

// node_modules/smol-toml/dist/util.js
function skipComment(ctx) {
  for (; ctx.p < ctx.s.length; ctx.p++) {
    let c = ctx.s.charCodeAt(ctx.p);
    if (c === 10)
      break;
    if (c === 13 && ctx.s.charCodeAt(ctx.p + 1) === 10) {
      ctx.p++;
      break;
    }
    if (c < 32 && c !== 9 || c === 127) {
      TomlError.x("control characters are not allowed in comments", ctx);
    }
  }
}
function skipVoid(ctx, banNewLines, banComments) {
  let c;
  while (ctx.p < ctx.s.length) {
    while (ctx.p < ctx.s.length && ((c = ctx.s.charCodeAt(ctx.p)) === 32 || c === 9 || !banNewLines && (c === 10 || c === 13 && ctx.s.charCodeAt(ctx.p + 1) === 10)))
      ctx.p++;
    if (banComments || c !== 35)
      break;
    skipComment(ctx);
  }
}

// node_modules/smol-toml/dist/struct.js
function parseKey(ctx, end = 61) {
  let startPtr;
  let state = 0;
  let parsed = [];
  let sliceStart;
  let c = ctx.s.charCodeAt(startPtr = ctx.p);
  do {
    if (c === end) {
      if (!state)
        TomlError.x("unexpected end of key", ctx);
      if (state === 1)
        parsed.push(ctx.s.slice(sliceStart, ctx.p));
      return ctx.p++, parsed;
    } else if (c === 46) {
      if (!state)
        TomlError.x("illegal empty bare key", ctx);
      if (state === 1)
        parsed.push(ctx.s.slice(sliceStart, ctx.p));
      state = 0;
    } else if (!state && (c === 34 || c === 39)) {
      if (c === ctx.s.charCodeAt(ctx.p + 1) && c === ctx.s.charCodeAt(ctx.p + 2))
        TomlError.x("illegal quoted key: multiline strings are not allowed", ctx);
      parsed.push(parseString(ctx));
      state = 2;
      ctx.p--;
    } else if (c === 32 || c === 9) {
      if (state === 1) {
        parsed.push(ctx.s.slice(sliceStart, ctx.p));
        state = 2;
      }
    } else if (state === 2 || c < 48 && c !== 45 || c > 57 && c < 65 || c > 90 && c < 97 && c !== 95 || c > 122) {
      TomlError.x("illegal character in key", ctx);
    } else if (!state) {
      state = 1;
      sliceStart = ctx.p;
    }
  } while (c = ctx.s.charCodeAt(++ctx.p));
  TomlError.x("incomplete key-value: cannot find end of key", ctx, startPtr);
}
function parseInlineTable(ctx) {
  let startPtr = ctx.p++;
  let res = /* @__PURE__ */ Object.create(null);
  let seen = /* @__PURE__ */ new Set();
  let c;
  while (ctx.p < ctx.s.length) {
    skipVoid(ctx);
    if ((c = ctx.s.charCodeAt(ctx.p)) === 125) {
      ctx.p++;
      return res;
    }
    let k;
    let t = res;
    let hasOwn = false;
    let errPtr = ctx.p;
    let key = parseKey(ctx);
    for (let i = 0; i < key.length; i++) {
      if (i)
        t = hasOwn ? t[k] : t[k] = /* @__PURE__ */ Object.create(null);
      k = key[i];
      if ((hasOwn = Object.hasOwn(t, k)) && (typeof t[k] !== "object" || seen.has(t[k]))) {
        TomlError.x("trying to redefine an already defined value", ctx, errPtr);
      }
      let unsafe = k === "__proto__";
      if (ctx.uk && (unsafe || k === "constructor")) {
        t = ctx.uk !== 1 && TomlError.x("document contains an unsafe property", ctx, errPtr);
        break;
      }
      if (!hasOwn && unsafe) {
        Object.defineProperty(t, k, { enumerable: true, configurable: true, writable: true });
      }
    }
    if (hasOwn) {
      TomlError.x("trying to redefine an already defined value", ctx, errPtr);
    }
    skipVoid(ctx, true, true);
    let value = extractValue(
      ctx,
      125
      /* } */
    );
    if (t && typeof (t[k] = value) === "object")
      seen.add(value);
    skipVoid(ctx);
    if ((c = ctx.s.charCodeAt(ctx.p++)) === 125) {
      return res;
    }
    if (c !== 44)
      TomlError.x("expected comma or end of structure", ctx, ctx.p - 1);
  }
  TomlError.x("unfinished table", ctx, startPtr);
}
function parseArray(ctx) {
  let startPtr = ctx.p++;
  let res = [];
  let c;
  while (ctx.p < ctx.s.length) {
    skipVoid(ctx);
    if ((c = ctx.s.charCodeAt(ctx.p)) === 93) {
      ctx.p++;
      return res;
    }
    res.push(extractValue(
      ctx,
      93
      /* ] */
    ));
    skipVoid(ctx);
    if ((c = ctx.s.charCodeAt(ctx.p++)) === 93) {
      return res;
    }
    if (c !== 44)
      TomlError.x("expected comma or end of structure", ctx, ctx.p - 1);
  }
  TomlError.x("unfinished array", ctx, startPtr);
}

// node_modules/smol-toml/dist/parse.js
function peekTable(ctx, key, table, meta, type) {
  let t = table;
  let m = meta;
  let k;
  let hasOwn = false;
  let state;
  for (let i = 0; i < key.length; i++) {
    if (i) {
      t = hasOwn ? t[k] : t[k] = /* @__PURE__ */ Object.create(null);
      m = (state = m[k]).c;
      if (type === 0 && (state.t === 1 || state.t === 2)) {
        return null;
      }
      if (state.t === 2) {
        let l = t.length - 1;
        t = t[l];
        m = m[l].c;
      }
    }
    k = key[i];
    if ((hasOwn = Object.hasOwn(t, k)) && m[k]?.t === 0 && m[k]?.d) {
      return null;
    }
    if (!hasOwn) {
      let unsafe = k === "__proto__";
      if (ctx.uk && (unsafe || k === "constructor"))
        return false;
      if (unsafe) {
        Object.defineProperty(t, k, { enumerable: true, configurable: true, writable: true });
        Object.defineProperty(m, k, { enumerable: true, configurable: true, writable: true });
      }
      m[k] = {
        t: i < key.length - 1 && type === 2 ? 3 : type,
        d: false,
        i: 0,
        c: /* @__PURE__ */ Object.create(null)
      };
    }
  }
  state = m[k];
  if (state.t !== type && !(type === 1 && state.t === 3)) {
    return null;
  }
  if (type === 2) {
    if (!state.d) {
      state.d = true;
      t[k] = [];
    }
    t[k].push(t = /* @__PURE__ */ Object.create(null));
    state.c[state.i++] = state = { t: 1, d: false, i: 0, c: /* @__PURE__ */ Object.create(null) };
  }
  if (state.d) {
    return null;
  }
  state.d = true;
  if (type === 1) {
    t = hasOwn ? t[k] : t[k] = /* @__PURE__ */ Object.create(null);
  } else if (type === 0 && hasOwn) {
    return null;
  }
  return [k, t, state.c];
}
function validateTablePeek(ctx, peek, ptr) {
  if (peek === null || ctx.uk === 2)
    TomlError.x(peek === null ? "trying to redefine an already defined table or value" : "document contains an unsafe property", ctx, ptr);
}
function parse(toml, options = {}) {
  let ctx = {
    s: toml,
    p: 0,
    d: options.maxDepth ?? 1e3,
    bi: options.integersAsBigInt ?? false,
    ld: options.useLegacyDate ?? true,
    uk: options.unsafeKeyBehaviour === "throw" ? 2 : options.unsafeKeyBehaviour === "drop" ? 1 : 0
  };
  let res = /* @__PURE__ */ Object.create(null);
  let meta = /* @__PURE__ */ Object.create(null);
  let tmp;
  let skipping = false;
  let tbl = res;
  let m = meta;
  if (toml.charCodeAt(0) === 65279)
    ctx.p++;
  skipVoid(ctx);
  while (ctx.p < toml.length) {
    if (toml.charCodeAt(ctx.p) === 91) {
      let isTableArray = toml.charCodeAt(++ctx.p) === 91;
      tmp = ctx.p += +isTableArray;
      skipping = false;
      let k = parseKey(
        ctx,
        93
        /* ] */
      );
      if (isTableArray) {
        if (toml.charCodeAt(ctx.p) !== 93) {
          TomlError.x("expected end of table array declaration", ctx);
        }
        ctx.p++;
      }
      let p = peekTable(
        ctx,
        k,
        res,
        meta,
        isTableArray ? 2 : 1
        /* Type.EXPLICIT */
      );
      if (!p) {
        validateTablePeek(ctx, p, tmp);
        skipping = true;
      } else {
        m = p[2];
        tbl = p[1];
      }
    } else {
      tmp = ctx.p;
      let k = parseKey(ctx);
      let p = peekTable(
        ctx,
        k,
        tbl,
        m,
        0
        /* Type.DOTTED */
      );
      if (!p && !skipping)
        validateTablePeek(ctx, p, tmp);
      skipVoid(ctx, true, true);
      let v = extractValue(ctx, void 0);
      if (p && !skipping)
        p[1][p[0]] = v;
    }
    skipVoid(ctx, true);
    if (ctx.p < toml.length && (tmp = toml.charCodeAt(ctx.p)) !== 10 && (tmp !== 13 || toml.charCodeAt(ctx.p + 1) !== 10)) {
      TomlError.x("each key-value declaration must be followed by an end-of-line", ctx);
    }
    skipVoid(ctx);
  }
  return res;
}

// node_modules/smol-toml/dist/stringify.js
var HAS_WELLFORMED = !!"".isWellFormed;

// src/project-actions.ts
var BEGIN = "# BEGIN context-window-monitor managed action";
var END = "# END context-window-monitor managed action";
var samePath = (a, b) => path2.relative(a, b) === "";
var exists = async (file) => fs2.lstat(file).then(() => true).catch((error) => {
  if (error.code === "ENOENT") return false;
  throw error;
});
async function atomicWrite(file, text2) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await fs2.writeFile(temporary, text2, { mode: 384 });
  try {
    await fs2.rename(temporary, file);
  } finally {
    await fs2.unlink(temporary).catch(() => void 0);
  }
}
function managedSpan(text2) {
  const start = text2.lastIndexOf(`${BEGIN}
`);
  if (start < 0) return null;
  const ending = text2.indexOf(`${END}
`, start);
  if (ending < 0 || start !== 0 && text2[start - 1] !== "\n") throw new Error("Invalid managed action boundary");
  const end = ending + END.length + 1;
  return { start, end, block: text2.slice(start, end) };
}
var ProjectActions = class {
  constructor(options) {
    this.options = options;
    this.codexHome = options.codexHome || process.env.CODEX_HOME || path2.join(homedir(), ".codex");
    this.dataDirectory = options.dataDirectory || path2.join(this.codexHome, "context-window-monitor");
  }
  options;
  status = { enabled: true, source: "pending", projects: 0, configured: 0, errors: [], updatedAt: null };
  codexHome;
  dataDirectory;
  timer = null;
  busy = false;
  start() {
    void this.sync();
    this.timer = setInterval(() => {
      void this.sync();
    }, 3e3);
    this.timer.unref();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
  actionBlock() {
    const platform = this.options.platform || process.platform;
    const quoted = (value) => `'${value.replaceAll("'", "'\\''")}'`;
    const command = platform === "win32" ? `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${path2.join(this.options.pluginRoot, "scripts", "open-dashboard.ps1")}"` : `${quoted(this.options.nodePath || process.execPath)} ${quoted(path2.join(this.options.pluginRoot, "runtime", "open-dashboard.mjs"))}`;
    return `${BEGIN}
[[actions]]
name = "\u4E0A\u4E0B\u6587\u76D1\u63A7"
icon = "tool"
command = ${JSON.stringify(command)}
platform = ${JSON.stringify(platform)}
${END}
`;
  }
  async safeConfig(root, file) {
    const canonical = await fs2.realpath(root);
    for (const candidate of [path2.join(root, ".codex"), path2.dirname(file), file]) {
      if (!await exists(candidate)) continue;
      const relative = path2.relative(canonical, await fs2.realpath(candidate));
      if (relative === ".." || relative.startsWith(`..${path2.sep}`) || path2.isAbsolute(relative)) throw new Error("Configuration path escapes project root");
    }
  }
  async saveChanged(file, before, after, existed) {
    if (before === after) return;
    if (existed) {
      const backupDirectory = path2.join(this.dataDirectory, "project-action-backups");
      await fs2.mkdir(backupDirectory, { recursive: true });
      const hash = createHash("sha256").update(file).update(before).digest("hex");
      await fs2.writeFile(path2.join(backupDirectory, `${hash}.toml`), before, { flag: "wx", mode: 384 }).catch((error) => {
        if (error.code !== "EEXIST") throw error;
      });
      if (await fs2.readFile(file, "utf8") !== before) throw new Error("Configuration changed concurrently");
      await atomicWrite(file, after);
    } else {
      await fs2.writeFile(file, after, { flag: "wx", mode: 384 });
    }
  }
  async removeManaged(entry) {
    if (!await exists(entry.root) || !await exists(entry.file)) return;
    const expected = path2.join(entry.root, ".codex", "environments");
    if (!samePath(path2.dirname(entry.file), expected)) throw new Error("Invalid managed path");
    await this.safeConfig(entry.root, entry.file);
    const before = await fs2.readFile(entry.file, "utf8");
    parse(before);
    const span = managedSpan(before);
    if (!span || span.block !== entry.block) return;
    const after = before.slice(0, span.start) + before.slice(span.end);
    parse(after);
    if (entry.created && after === entry.base) {
      if (await fs2.readFile(entry.file, "utf8") !== before) throw new Error("Configuration changed concurrently");
      await fs2.unlink(entry.file);
    } else await this.saveChanged(entry.file, before, after, true);
  }
  async sync() {
    if (this.busy) return this.status;
    this.busy = true;
    let lock;
    const lockFile = path2.join(this.dataDirectory, "project-actions.lock");
    try {
      await fs2.mkdir(this.dataDirectory, { recursive: true });
      try {
        lock = await fs2.open(lockFile, "wx");
        await lock.writeFile(String(process.pid));
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        const age = Date.now() - (await fs2.stat(lockFile)).mtimeMs;
        if (age > 3e4) {
          const pid = Number(await fs2.readFile(lockFile, "utf8"));
          if (Number.isSafeInteger(pid) && pid > 0) {
            try {
              process.kill(pid, 0);
            } catch (e) {
              if (e.code === "ESRCH") await fs2.unlink(lockFile);
            }
          }
        }
        return this.status;
      }
      const snapshot = await discoverProjects(this.codexHome);
      this.status.source = snapshot.source;
      if (!snapshot.complete) throw new Error("Project registry unavailable; existing actions retained");
      const ownerFile = path2.join(this.dataDirectory, "project-actions-owner.json");
      const owner = await fs2.readFile(ownerFile, "utf8").then((value) => JSON.parse(value)).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (owner && owner.pid !== process.pid && Number.isSafeInteger(owner.pid) && owner.pid > 0) {
        let alive = true;
        try {
          process.kill(owner.pid, 0);
        } catch (error) {
          if (error.code === "ESRCH") alive = false;
        }
        if (alive && typeof owner.version === "string" && owner.version.localeCompare("0.4.0", void 0, { numeric: true }) >= 0) {
          this.status.enabled = false;
          this.status.source = "managed-by-running-service";
          this.stop();
          return this.status;
        }
      }
      if (!owner || owner.pid !== process.pid) await atomicWrite(ownerFile, JSON.stringify({ pid: process.pid, version: "0.4.0" }));
      const ledgerPath = path2.join(this.dataDirectory, "project-actions.json");
      const ledger = await fs2.readFile(ledgerPath, "utf8").then((text2) => JSON.parse(text2)).catch((error) => {
        if (error.code === "ENOENT") return { files: [] };
        throw error;
      });
      if (!Array.isArray(ledger.files)) throw new Error("Invalid action ledger");
      const files = [];
      const errors = [];
      const roots = [...new Set(snapshot.projects.map((project) => project.root))];
      let configured = 0;
      for (const root of roots) {
        if (!await exists(root)) {
          files.push(...ledger.files.filter((entry) => samePath(entry.root, root)));
          errors.push(`${path2.basename(root)}: \u9879\u76EE\u76EE\u5F55\u6682\u65F6\u4E0D\u53EF\u7528`);
          continue;
        }
        try {
          const folder = path2.join(root, ".codex", "environments");
          const candidates = await fs2.readdir(folder).catch((error) => {
            if (error.code === "ENOENT") return [];
            throw error;
          });
          const names = candidates.filter((name) => name.endsWith(".toml"));
          if (!names.length) names.push("environment.toml");
          for (const name of names) {
            const file = path2.join(folder, name);
            await this.safeConfig(root, file);
            const existed = await exists(file);
            const before = existed ? await fs2.readFile(file, "utf8") : "";
            const document = parse(before);
            const previous = ledger.files.find((entry) => samePath(entry.file, file));
            const span = managedSpan(before);
            if (span && (!previous || span.block !== previous.block)) throw new Error("Managed action edited externally");
            const actions = document.actions;
            if (actions !== void 0 && !Array.isArray(actions)) throw new Error("Unsupported actions format");
            if (!span && Array.isArray(actions) && actions.some((action) => typeof action === "object" && action !== null && String(action.command).includes("context-window-monitor") && /open-dashboard\.(ps1|mjs)/u.test(String(action.command)))) {
              configured++;
              continue;
            }
            const base = span ? before.slice(0, span.start) + before.slice(span.end) : before || `version = 1
name = ${JSON.stringify(path2.basename(root))}

[setup]
script = ""
`;
            const prefix = base.endsWith("\n") ? base : `${base}
`;
            const block = this.actionBlock();
            const after = `${prefix}${block}`;
            const updated = parse(after);
            if (!Array.isArray(updated.actions)) throw new Error("Action insertion failed");
            await fs2.mkdir(folder, { recursive: true });
            await this.safeConfig(root, file);
            await this.saveChanged(file, before, after, existed);
            files.push({ root, file, block, created: previous?.created ?? !existed, base: previous?.base ?? prefix });
            configured++;
          }
        } catch {
          errors.push(`${path2.basename(root)}: \u65E0\u6CD5\u5B89\u5168\u66F4\u65B0\u9879\u76EE\u64CD\u4F5C\uFF0C\u5DF2\u4FDD\u7559\u73B0\u6709\u914D\u7F6E`);
          files.push(...ledger.files.filter((entry) => samePath(entry.root, root) && !files.some((known) => samePath(known.file, entry.file))));
        }
      }
      for (const entry of ledger.files) {
        if (roots.some((root) => samePath(root, entry.root))) continue;
        try {
          await this.removeManaged(entry);
        } catch {
          errors.push(`${path2.basename(entry.root)}: \u6682\u65F6\u65E0\u6CD5\u6E05\u7406\u65E7\u5165\u53E3`);
          files.push(entry);
        }
      }
      const next = JSON.stringify({ files });
      if (JSON.stringify(ledger) !== next) await atomicWrite(ledgerPath, next);
      Object.assign(this.status, { projects: roots.length, configured, errors, updatedAt: (/* @__PURE__ */ new Date()).toISOString() });
    } catch (error) {
      this.status.errors = [error instanceof Error && error.message.startsWith("Project registry unavailable") ? error.message : "\u9879\u76EE\u6CE8\u518C\u8868\u8BFB\u53D6\u5931\u8D25\uFF1B\u4FDD\u7559\u73B0\u6709\u914D\u7F6E\u5E76\u7A0D\u540E\u91CD\u8BD5"];
    } finally {
      if (lock) {
        await lock.close();
        await fs2.unlink(lockFile).catch(() => void 0);
      }
      this.busy = false;
    }
    return this.status;
  }
};

// src/context-history-tracker.ts
var CORRELATION_WINDOW_MS = 45e3;
function toMillis(timestamp) {
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : 0;
}
function markerBetween(markers, before, after) {
  const start = toMillis(before);
  const end = toMillis(after);
  return markers.find((marker) => {
    const value = toMillis(marker.timestamp);
    return value > start && value <= end;
  }) ?? null;
}
function nearestHook(hooks, timestamp) {
  const target = toMillis(timestamp);
  let best = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const hook of hooks) {
    const distance = target - toMillis(hook.timestamp);
    if (distance >= 0 && distance <= CORRELATION_WINDOW_MS && distance < bestDistance) {
      best = hook;
      bestDistance = distance;
    }
  }
  return best;
}
function observedLabel(hook) {
  if (!hook) {
    return {
      label: "Context snapshot updated",
      detail: "No exact per-category attribution is exposed by Codex."
    };
  }
  switch (hook.eventName) {
    case "UserPromptSubmit":
      return {
        label: "Observed after user message",
        detail: "The delta is exact; attribution is a time correlation, not a token category split."
      };
    case "PostToolUse":
      return {
        label: hook.toolName ? `Observed after tool call: ${hook.toolName}` : "Observed after tool call",
        detail: "The delta is exact; attribution is a time correlation, not a token category split."
      };
    case "Stop":
      return {
        label: "Observed near assistant completion",
        detail: "The delta is exact; attribution is a time correlation, not a token category split."
      };
    default:
      return {
        label: `Observed after ${hook.eventName}`,
        detail: "The delta is exact; attribution is a time correlation, not a token category split."
      };
  }
}
var ContextHistoryTracker = class {
  changes(snapshots, markers, hooks, limit = 12) {
    const changes = [];
    const ordered = [...snapshots].sort(
      (left, right) => toMillis(left.timestamp) - toMillis(right.timestamp)
    );
    for (let index = 0; index < ordered.length; index += 1) {
      const current = ordered[index];
      if (!current) continue;
      const before = ordered[index - 1] ?? null;
      if (!before) {
        changes.push({
          id: `snapshot-${current.timestamp}`,
          timestamp: current.timestamp,
          kind: "snapshot",
          deltaTokens: null,
          beforeTokens: null,
          afterTokens: current.last.inputTokens,
          label: "Initial context snapshot",
          detail: "Exact server-reported model input tokens.",
          attribution: "snapshot-only"
        });
        continue;
      }
      const delta = current.last.inputTokens - before.last.inputTokens;
      const marker = markerBetween(markers, before.timestamp, current.timestamp);
      if (marker) {
        changes.push({
          id: `compaction-${marker.timestamp}`,
          timestamp: marker.timestamp,
          kind: "compaction",
          deltaTokens: delta,
          beforeTokens: before.last.inputTokens,
          afterTokens: current.last.inputTokens,
          label: "Context compacted",
          detail: `Compaction event reported by Codex (${marker.trigger} trigger).`,
          attribution: "exact-event"
        });
        continue;
      }
      const observed = observedLabel(nearestHook(hooks, current.timestamp));
      changes.push({
        id: `change-${current.timestamp}`,
        timestamp: current.timestamp,
        kind: delta >= 0 ? "increase" : "decrease",
        deltaTokens: delta,
        beforeTokens: before.last.inputTokens,
        afterTokens: current.last.inputTokens,
        label: observed.label,
        detail: observed.detail,
        attribution: "observed-correlation"
      });
    }
    return changes.slice(-limit).reverse();
  }
  compactions(snapshots, markers, limit = 6) {
    const ordered = [...snapshots].sort(
      (left, right) => toMillis(left.timestamp) - toMillis(right.timestamp)
    );
    return [...markers].sort((left, right) => toMillis(right.timestamp) - toMillis(left.timestamp)).slice(0, limit).map((marker) => {
      const markerTime = toMillis(marker.timestamp);
      const before = [...ordered].reverse().find((snapshot) => toMillis(snapshot.timestamp) < markerTime);
      const after = ordered.find((snapshot) => toMillis(snapshot.timestamp) > markerTime);
      const beforeTokens = before?.last.inputTokens ?? null;
      const afterTokens = after?.last.inputTokens ?? null;
      const reducedTokens = beforeTokens !== null && afterTokens !== null && beforeTokens >= afterTokens ? beforeTokens - afterTokens : null;
      return {
        timestamp: marker.timestamp,
        trigger: marker.trigger,
        beforeTokens,
        afterTokens,
        reducedTokens,
        precision: reducedTokens === null ? "unavailable" : "exact",
        detail: reducedTokens === null ? "Compaction is exact; before/after snapshots were not both available." : "Compaction and both surrounding token snapshots were reported by Codex."
      };
    });
  }
};

// src/context-status-bar.ts
var HEALTH_LABELS = {
  normal: "Normal",
  medium: "Medium",
  high: "High",
  danger: "Danger",
  unavailable: "Unavailable"
};
function compactNumber(value) {
  if (value < 1e3) return String(value);
  const divisor = value >= 1e6 ? 1e6 : 1e3;
  const suffix = value >= 1e6 ? "M" : "K";
  return `${(value / divisor).toFixed(value >= divisor * 100 ? 0 : 1)}${suffix}`;
}
var ContextStatusBar = class {
  format(usage) {
    if (usage.usedTokens === null || usage.totalTokens === null || usage.percentage === null) {
      return "Context: unavailable";
    }
    return `Context: ${compactNumber(usage.usedTokens)} / ${compactNumber(
      usage.totalTokens
    )} \xB7 ${usage.percentage.toFixed(1)}% \xB7 ${HEALTH_LABELS[usage.health]}`;
  }
};

// src/context-types.ts
var UNAVAILABLE_BREAKDOWN = [
  "System Instructions",
  "Conversation History",
  "Files / Attachments",
  "Tool Results",
  "Other Context"
].map((name) => ({
  name,
  value: null,
  precision: "unavailable"
}));

// src/context-usage-service.ts
var USED_DEFINITION = "Last server-reported model input tokens. No text-to-token estimation is used.";
function healthFor(percentage) {
  if (percentage === null) return "unavailable";
  if (percentage >= 90) return "danger";
  if (percentage >= 75) return "high";
  if (percentage >= 50) return "medium";
  return "normal";
}
function latestSnapshot(result) {
  return result.snapshots.at(-1) ?? null;
}
var ContextUsageService = class {
  calculate(result) {
    const snapshot = latestSnapshot(result);
    if (!snapshot) {
      return {
        precision: "unavailable",
        precisionDetail: "Codex has not reported a token-usage snapshot for this session.",
        usedTokens: null,
        totalTokens: null,
        remainingTokens: null,
        percentage: null,
        health: "unavailable",
        model: result.session?.model ?? null,
        sessionId: result.session?.sessionId ?? null,
        updatedAt: null,
        source: null,
        usedDefinition: USED_DEFINITION
      };
    }
    const usedTokens = snapshot.last.inputTokens;
    const totalTokens = snapshot.modelContextWindow;
    const remainingTokens = totalTokens === null ? null : Math.max(totalTokens - usedTokens, 0);
    const percentage = totalTokens === null || totalTokens <= 0 ? null : usedTokens / totalTokens * 100;
    const exactSession = snapshot.selection === "active-hook" || snapshot.selection === "explicit";
    return {
      precision: exactSession ? "exact" : "estimated",
      precisionDetail: exactSession ? "Exact Codex values matched to the active session by a lifecycle hook or explicit session ID." : "Token values are exact, but the current session was selected by latest-rollout fallback.",
      usedTokens,
      totalTokens,
      remainingTokens,
      percentage,
      health: healthFor(percentage),
      model: snapshot.model ?? result.session?.model ?? null,
      sessionId: snapshot.sessionId,
      updatedAt: snapshot.timestamp,
      source: snapshot.source,
      usedDefinition: USED_DEFINITION
    };
  }
  breakdown(result) {
    const snapshot = latestSnapshot(result);
    if (!snapshot) {
      return {
        currentModelInputTokens: null,
        cachedInputTokens: null,
        cacheWriteInputTokens: null,
        uncachedInputTokens: null,
        lastOutputTokens: null,
        reasoningOutputTokens: null,
        cumulativeThreadTokens: null
      };
    }
    return {
      currentModelInputTokens: snapshot.last.inputTokens,
      cachedInputTokens: snapshot.last.cachedInputTokens,
      cacheWriteInputTokens: snapshot.last.cacheWriteInputTokens,
      uncachedInputTokens: Math.max(
        snapshot.last.inputTokens - snapshot.last.cachedInputTokens - snapshot.last.cacheWriteInputTokens,
        0
      ),
      lastOutputTokens: snapshot.last.outputTokens,
      reasoningOutputTokens: snapshot.last.reasoningOutputTokens,
      cumulativeThreadTokens: snapshot.cumulative.totalTokens
    };
  }
};

// src/context-monitor-service.ts
var ContextMonitorService = class {
  constructor(provider, usageService = new ContextUsageService(), historyTracker = new ContextHistoryTracker(), statusBar = new ContextStatusBar()) {
    this.provider = provider;
    this.usageService = usageService;
    this.historyTracker = historyTracker;
    this.statusBar = statusBar;
  }
  provider;
  usageService;
  historyTracker;
  statusBar;
  async dashboard(sessionId) {
    const providerResult = await this.provider.getContext(
      sessionId ? { sessionId } : void 0
    );
    const usage = this.usageService.calculate(providerResult);
    const exactBreakdown = this.usageService.breakdown(providerResult);
    const warnings = [...providerResult.warnings];
    if (usage.totalTokens === null) {
      warnings.push("Codex did not report the model context-window capacity.");
    }
    warnings.push(
      "System/history/files/tool-result token categories are not exposed and are shown as unavailable."
    );
    return {
      schemaVersion: 1,
      usage,
      statusText: this.statusBar.format(usage),
      exactBreakdown,
      unavailableBreakdown: UNAVAILABLE_BREAKDOWN.map((category) => ({ ...category })),
      recentChanges: this.historyTracker.changes(
        providerResult.snapshots,
        providerResult.compactions,
        providerResult.hookEvents
      ),
      compactions: this.historyTracker.compactions(
        providerResult.snapshots,
        providerResult.compactions,
        20
      ),
      cumulativeTokens: exactBreakdown.cumulativeThreadTokens,
      warnings,
      refreshIntervalMs: 5e3,
      snapshots: providerResult.snapshots,
      ...providerResult.activity ? { activity: providerResult.activity } : {}
    };
  }
};

// src/providers/activity-tracker.ts
import { createHash as createHash2 } from "node:crypto";
var object = (v) => v !== null && typeof v === "object" && !Array.isArray(v) ? v : null;
var text = (v) => typeof v === "string" ? v : null;
var digest = (v) => createHash2("sha256").update(v).digest("hex");
function visibleText(payload) {
  if (typeof payload.arguments === "string") return payload.arguments;
  if (typeof payload.input === "string") return payload.input;
  if (typeof payload.output === "string") return payload.output;
  if (Array.isArray(payload.output)) return payload.output.map((v) => visibleText(object(v) ?? {})).join("\n");
  if (typeof payload.text === "string") return payload.text;
  if (typeof payload.message === "string") return payload.message;
  const blocks = Array.isArray(payload.content) ? payload.content : Array.isArray(payload.summary) ? payload.summary : [];
  return blocks.map((v) => text(object(v)?.text) ?? "").filter(Boolean).join("\n");
}
function activityItem(root, id, timestamp) {
  const payload = object(root.payload);
  if (!payload) return null;
  const type = text(payload.type) ?? String(root.type);
  if (root.type !== "response_item" && root.type !== "compacted") return null;
  let category = "other";
  const role = text(payload.role);
  if (type === "message" && ["system", "developer", "user", "assistant"].includes(role ?? "")) category = role;
  else if (type === "reasoning") category = "reasoning";
  else if (["function_call", "custom_tool_call", "web_search_call"].includes(type)) category = "tool_call";
  else if (["function_call_output", "custom_tool_call_output"].includes(type)) category = "tool_result";
  else if (root.type === "compacted" || ["compaction", "context_compaction"].includes(type)) category = "compaction";
  const body = visibleText(payload);
  let file = null;
  if (category === "tool_call") try {
    const args = object(JSON.parse(text(payload.arguments) ?? text(payload.input) ?? "null"));
    file = text(args?.path) ?? text(args?.file_path) ?? null;
  } catch {
  }
  return { id, timestamp, category, type, role, name: text(payload.name) ?? role ?? type, callId: text(payload.call_id), messageId: text(payload.id), characters: body.length, hash: digest(body), file, tokens: null };
}
function summarizeActivity(items, truncated, parentSessionId, agentName) {
  const calls = new Map(items.filter((i) => i.category === "tool_call" && i.callId).map((i) => [i.callId, i.name]));
  const normalized = items.map((i) => i.category === "tool_result" ? { ...i, name: calls.get(i.callId) ?? "\u672A\u5173\u8054\u5DE5\u5177\u7ED3\u679C" } : i);
  const tools = /* @__PURE__ */ new Map();
  const files = /* @__PURE__ */ new Map();
  const hashes = /* @__PURE__ */ new Map();
  for (const i of normalized) {
    if (i.category === "tool_call" || i.category === "tool_result") {
      const t = tools.get(i.name) ?? { name: i.name, calls: 0, results: 0, argumentCharacters: 0, resultCharacters: 0, tokens: null };
      if (i.category === "tool_call") {
        t.calls++;
        t.argumentCharacters += i.characters;
      } else {
        t.results++;
        t.resultCharacters += i.characters;
      }
      tools.set(i.name, t);
    }
    if (i.file) {
      const f = files.get(i.file) ?? { path: i.file, calls: 0, characters: 0 };
      f.calls++;
      f.characters += i.characters;
      files.set(i.file, f);
    }
    if (i.characters >= 256) hashes.set(i.hash, [...hashes.get(i.hash) ?? [], i]);
  }
  return { items: normalized, truncated, scope: "\u6700\u8FD1\u4FDD\u7559\u7684\u65E5\u5FD7\u8BB0\u5F55\uFF1B\u4E0D\u4EE3\u8868\u5F53\u524D\u6A21\u578B\u5B8C\u6574\u4E0A\u4E0B\u6587", parentSessionId, agentName, tools: [...tools.values()].sort((a, b) => b.resultCharacters - a.resultCharacters), files: [...files.values()].sort((a, b) => b.calls - a.calls), duplicates: [...hashes.values()].filter((a) => a.length > 1).map((a) => ({ hash: a[0].hash, ids: a.map((i) => i.id), characters: a.slice(1).reduce((n, i) => n + i.characters, 0) })) };
}

// src/providers/rollout-event-parser.ts
function objectValue(value) {
  return typeof value === "object" && value !== null ? value : null;
}
function stringValue(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}
function nonNegativeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
function numberFrom(object2, camel, snake) {
  return nonNegativeNumber(object2[camel] ?? object2[snake]);
}
function tokenBreakdown(value) {
  const object2 = objectValue(value);
  if (!object2) return null;
  const totalTokens = numberFrom(object2, "totalTokens", "total_tokens");
  const inputTokens = numberFrom(object2, "inputTokens", "input_tokens");
  const cachedInputTokens = numberFrom(
    object2,
    "cachedInputTokens",
    "cached_input_tokens"
  );
  const cacheWriteInputTokens = numberFrom(
    object2,
    "cacheWriteInputTokens",
    "cache_write_input_tokens"
  );
  const outputTokens = numberFrom(object2, "outputTokens", "output_tokens");
  const reasoningOutputTokens = numberFrom(
    object2,
    "reasoningOutputTokens",
    "reasoning_output_tokens"
  );
  if (totalTokens === null || inputTokens === null || cachedInputTokens === null || cacheWriteInputTokens === null || outputTokens === null || reasoningOutputTokens === null) {
    return null;
  }
  return {
    totalTokens,
    inputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    outputTokens,
    reasoningOutputTokens
  };
}
function normalizeTimestamp(value) {
  const stringTimestamp = stringValue(value);
  if (stringTimestamp && Number.isFinite(Date.parse(stringTimestamp))) {
    return new Date(stringTimestamp).toISOString();
  }
  return (/* @__PURE__ */ new Date()).toISOString();
}
function addCompaction(state, marker) {
  const duplicate = state.compactions.some(
    (current) => current.timestamp === marker.timestamp && current.trigger === marker.trigger
  );
  if (!duplicate) state.compactions.push(marker);
}
function parseAppServerEvent(root, timestamp, selection, state) {
  const method = stringValue(root.method);
  const params = objectValue(root.params);
  if (method === "thread/tokenUsage/updated" && params) {
    const usage = objectValue(params.tokenUsage);
    if (!usage) return true;
    const last = tokenBreakdown(usage.last);
    const cumulative = tokenBreakdown(usage.total);
    const sessionId = stringValue(params.threadId) ?? state.sessionId;
    if (!last || !cumulative || !sessionId) return true;
    state.sessionId = sessionId;
    state.turnId = stringValue(params.turnId) ?? state.turnId;
    state.snapshots.push({
      sessionId,
      timestamp,
      source: "app-server-event",
      selection,
      last,
      cumulative,
      modelContextWindow: nonNegativeNumber(usage.modelContextWindow),
      model: state.model,
      turnId: state.turnId
    });
    return true;
  }
  if (method === "item/completed" && params) {
    const item = objectValue(params.item);
    if (item?.type === "contextCompaction") {
      addCompaction(state, {
        timestamp,
        trigger: "unknown",
        source: "app-server-event"
      });
    }
    return true;
  }
  return false;
}
function parseRolloutLine(line, selection, state, location) {
  let root;
  try {
    const parsed = objectValue(JSON.parse(line));
    if (!parsed) return;
    root = parsed;
  } catch {
    return;
  }
  const timestamp = normalizeTimestamp(root.timestamp);
  const item = activityItem(root, location ? String(location.offset) : `record-${state.activity.length}`, timestamp);
  if (item) {
    state.activity.push(item);
    if (location) state.locations.set(item.id, location);
  }
  if (parseAppServerEvent(root, timestamp, selection, state)) return;
  const envelopeType = stringValue(root.type);
  const payload = objectValue(root.payload);
  if (!payload) return;
  if (envelopeType === "session_meta") {
    state.sessionId = stringValue(payload.id) ?? state.sessionId;
    const spawn = object(object(object(payload.source)?.subagent)?.thread_spawn);
    state.parentSessionId = stringValue(spawn?.parent_thread_id);
    state.agentName = stringValue(spawn?.agent_nickname) ?? stringValue(spawn?.agent_path);
    return;
  }
  if (envelopeType === "turn_context") {
    state.model = stringValue(payload.model) ?? state.model;
    state.turnId = stringValue(payload.turn_id) ?? state.turnId;
    return;
  }
  const payloadType = stringValue(payload.type);
  if (envelopeType === "event_msg" && payloadType === "task_started") state.contextWindow = nonNegativeNumber(payload.model_context_window);
  if (envelopeType === "token_usage_record") {
    const last = tokenBreakdown(payload.usage);
    const cumulative = tokenBreakdown(payload.thread_token_usage);
    if (last && cumulative && state.sessionId) {
      state.snapshots.push({ sessionId: state.sessionId, timestamp, source: "rollout-log", selection, last, cumulative, modelContextWindow: state.contextWindow, model: state.model, turnId: stringValue(payload.turn_id) ?? state.turnId });
    }
    return;
  }
  if (envelopeType === "event_msg" && payloadType === "token_count") {
    const info = objectValue(payload.info);
    const last = tokenBreakdown(info?.last_token_usage);
    const cumulative = tokenBreakdown(info?.total_token_usage);
    const sessionId = state.sessionId;
    if (!info || !last || !cumulative || !sessionId) return;
    state.contextWindow = nonNegativeNumber(info.model_context_window);
    const previous = state.snapshots.at(-1);
    if (previous && JSON.stringify(previous.last) === JSON.stringify(last) && JSON.stringify(previous.cumulative) === JSON.stringify(cumulative)) {
      previous.modelContextWindow = state.contextWindow;
      return;
    }
    state.snapshots.push({
      sessionId,
      timestamp,
      source: "rollout-log",
      selection,
      last,
      cumulative,
      modelContextWindow: nonNegativeNumber(info.model_context_window),
      model: state.model,
      turnId: state.turnId
    });
    return;
  }
  const isCompaction = envelopeType === "compacted" || envelopeType === "response_item" && ["compaction", "compaction_trigger", "context_compaction"].includes(
    payloadType ?? ""
  ) || envelopeType === "event_msg" && ["context_compacted", "thread_compacted"].includes(payloadType ?? "");
  if (isCompaction) {
    const rawTrigger = stringValue(payload.trigger) ?? stringValue(payload.compaction_trigger);
    addCompaction(state, {
      timestamp,
      trigger: rawTrigger === "auto" || rawTrigger === "manual" ? rawTrigger : "unknown",
      source: "rollout-log"
    });
  }
}
function createParsedRolloutState(sessionId, model) {
  return {
    snapshots: [],
    compactions: [],
    model,
    sessionId,
    turnId: null,
    contextWindow: null,
    activity: [],
    locations: /* @__PURE__ */ new Map(),
    truncated: false,
    parentSessionId: null,
    agentName: null
  };
}

// src/providers/app-server-context-provider.ts
var AppServerContextProvider = class {
  state;
  registration;
  constructor(sessionId, model = null) {
    this.state = createParsedRolloutState(sessionId, model);
    this.registration = {
      sessionId,
      transcriptPath: null,
      cwd: null,
      model,
      lastSeenAt: (/* @__PURE__ */ new Date()).toISOString(),
      lastHookEvent: "AppServerInitialize",
      endedAt: null
    };
  }
  ingest(message) {
    const envelope = typeof message === "object" && message !== null ? { timestamp: (/* @__PURE__ */ new Date()).toISOString(), ...message } : message;
    parseRolloutLine(JSON.stringify(envelope), "explicit", this.state);
    this.registration.lastSeenAt = (/* @__PURE__ */ new Date()).toISOString();
  }
  async getContext(options = {}) {
    if (options.sessionId && options.sessionId !== this.registration.sessionId) {
      return {
        session: null,
        selection: "unavailable",
        snapshots: [],
        compactions: [],
        hookEvents: [],
        warnings: ["The requested session is not attached to this App Server adapter."]
      };
    }
    return {
      session: { ...this.registration },
      selection: "explicit",
      snapshots: [...this.state.snapshots],
      compactions: [...this.state.compactions],
      hookEvents: [],
      warnings: []
    };
  }
};

// src/providers/rollout-context-provider.ts
import { promises as fs4 } from "node:fs";
import { homedir as homedir3 } from "node:os";
import path4 from "node:path";

// src/providers/session-registry.ts
import { createHash as createHash3 } from "node:crypto";
import { promises as fs3 } from "node:fs";
import { homedir as homedir2 } from "node:os";
import path3 from "node:path";
var EVENT_ROTATE_BYTES = 256 * 1024;
var EVENT_KEEP_BYTES = 128 * 1024;
function usableEnvironmentPath(value) {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.includes("${")) return null;
  return path3.resolve(trimmed);
}
function resolveDataDirectory() {
  return usableEnvironmentPath(process.env.CONTEXT_MONITOR_DATA) ?? usableEnvironmentPath(process.env.PLUGIN_DATA) ?? path3.join(homedir2(), ".codex", "context-window-monitor");
}
function sessionKey(sessionId) {
  return createHash3("sha256").update(sessionId).digest("hex").slice(0, 32);
}
async function readJson(filePath) {
  try {
    return JSON.parse(await fs3.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}
var SessionRegistry = class {
  dataDirectory;
  sessionsDirectory;
  eventsDirectory;
  constructor(dataDirectory = resolveDataDirectory()) {
    this.dataDirectory = dataDirectory;
    this.sessionsDirectory = path3.join(dataDirectory, "sessions");
    this.eventsDirectory = path3.join(dataDirectory, "events");
  }
  registrationPath(sessionId) {
    return path3.join(this.sessionsDirectory, `${sessionKey(sessionId)}.json`);
  }
  eventsPath(sessionId) {
    return path3.join(this.eventsDirectory, `${sessionKey(sessionId)}.jsonl`);
  }
  async record(input) {
    await fs3.mkdir(this.sessionsDirectory, { recursive: true });
    await fs3.mkdir(this.eventsDirectory, { recursive: true });
    const previous = await this.get(input.sessionId);
    const registration = {
      sessionId: input.sessionId,
      transcriptPath: input.transcriptPath ?? previous?.transcriptPath ?? null,
      cwd: input.cwd ?? previous?.cwd ?? null,
      model: input.model ?? previous?.model ?? null,
      lastSeenAt: input.timestamp,
      lastHookEvent: input.eventName,
      endedAt: input.eventName === "SessionEnd" ? input.timestamp : previous?.endedAt ?? null
    };
    await fs3.writeFile(
      this.registrationPath(input.sessionId),
      `${JSON.stringify(registration, null, 2)}
`,
      "utf8"
    );
    await this.rotateEventsIfNeeded(input.sessionId);
    const event = {
      timestamp: input.timestamp,
      sessionId: input.sessionId,
      eventName: input.eventName,
      turnId: input.turnId,
      toolName: input.toolName,
      trigger: input.trigger
    };
    await fs3.appendFile(this.eventsPath(input.sessionId), `${JSON.stringify(event)}
`, "utf8");
  }
  async get(sessionId) {
    return readJson(this.registrationPath(sessionId));
  }
  async list(limit = 50) {
    let names;
    try {
      names = await fs3.readdir(this.sessionsDirectory);
    } catch {
      return [];
    }
    const registrations = await Promise.all(
      names.filter((name) => name.endsWith(".json")).map((name) => readJson(path3.join(this.sessionsDirectory, name)))
    );
    return registrations.filter((value) => value !== null).sort((left, right) => Date.parse(right.lastSeenAt) - Date.parse(left.lastSeenAt)).slice(0, limit);
  }
  async hookEvents(sessionId, limit = 200) {
    let text2;
    try {
      text2 = await fs3.readFile(this.eventsPath(sessionId), "utf8");
    } catch {
      return [];
    }
    return text2.split(/\r?\n/u).filter(Boolean).slice(-limit).flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
  }
  async rotateEventsIfNeeded(sessionId) {
    const eventPath = this.eventsPath(sessionId);
    let stats;
    try {
      stats = await fs3.stat(eventPath);
    } catch {
      return;
    }
    if (stats.size <= EVENT_ROTATE_BYTES) return;
    const handle = await fs3.open(eventPath, "r");
    try {
      const start = Math.max(stats.size - EVENT_KEEP_BYTES, 0);
      const buffer = Buffer.alloc(stats.size - start);
      await handle.read(buffer, 0, buffer.length, start);
      let tail = buffer.toString("utf8");
      if (start > 0) {
        const firstNewline = tail.indexOf("\n");
        tail = firstNewline >= 0 ? tail.slice(firstNewline + 1) : "";
      }
      await fs3.writeFile(eventPath, tail, "utf8");
    } finally {
      await handle.close();
    }
  }
};

// src/providers/rollout-context-provider.ts
var INITIAL_TAIL_BYTES = 2 * 1024 * 1024;
var MAX_SNAPSHOTS = 80;
var MAX_COMPACTIONS = 20;
function selectSnapshotsForModel(snapshots, activeModel) {
  if (!activeModel) return snapshots;
  return snapshots.filter(
    (snapshot) => snapshot.model === null || snapshot.model === activeModel
  );
}
function usableEnvironmentPath2(value) {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.includes("${")) return null;
  return path4.resolve(trimmed);
}
function codexSessionsRoot() {
  const codexDirectory = usableEnvironmentPath2(process.env.CODEX_HOME) ?? path4.join(homedir3(), ".codex");
  return path4.join(codexDirectory, "sessions");
}
function sessionIdFromFilename(filePath) {
  const match = path4.basename(filePath).match(
    /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/iu
  );
  return match?.[1] ?? path4.basename(filePath, ".jsonl");
}
async function existingFile(filePath) {
  if (!filePath) return null;
  try {
    const stats = await fs4.stat(filePath);
    return stats.isFile() ? path4.resolve(filePath) : null;
  } catch {
    return null;
  }
}
async function recentRolloutFiles() {
  const root = codexSessionsRoot();
  const files = [];
  let years;
  try {
    years = (await fs4.readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().reverse().slice(0, 2);
  } catch {
    return [];
  }
  for (const year of years) {
    const yearPath = path4.join(root, year);
    const months = (await fs4.readdir(yearPath, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().reverse().slice(0, 3);
    for (const month of months) {
      const monthPath = path4.join(yearPath, month);
      const days = (await fs4.readdir(monthPath, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().reverse().slice(0, 14);
      for (const day of days) {
        const dayPath = path4.join(monthPath, day);
        const dayFiles = await fs4.readdir(dayPath, { withFileTypes: true });
        files.push(
          ...dayFiles.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl")).map((entry) => path4.join(dayPath, entry.name))
        );
      }
    }
  }
  return files;
}
async function locateRollout(sessionId) {
  const files = await recentRolloutFiles();
  if (sessionId) {
    return files.find((filePath) => sessionIdFromFilename(filePath) === sessionId) ?? null;
  }
  const withStats = await Promise.all(
    files.map(async (filePath) => ({ filePath, stats: await fs4.stat(filePath) }))
  );
  return withStats.sort((left, right) => right.stats.mtimeMs - left.stats.mtimeMs)[0]?.filePath ?? null;
}
var RolloutContextProvider = class {
  constructor(registry = new SessionRegistry()) {
    this.registry = registry;
  }
  registry;
  caches = /* @__PURE__ */ new Map();
  reading = /* @__PURE__ */ new Map();
  /** Project actions do not expose the selected chat ID. Pick a recent project log explicitly. */
  async latestSessionForDirectory(directory) {
    const root = path4.resolve(directory);
    const files = await recentRolloutFiles();
    const recent = (await Promise.all(files.map(async (file) => ({ file, modified: await fs4.stat(file).then((s) => s.mtimeMs).catch(() => 0) })))).sort((a, b) => b.modified - a.modified).slice(0, 200);
    for (const { file } of recent) {
      try {
        const header = await this.readHeader(file);
        const record = header ? JSON.parse(header) : null;
        if (record?.type !== "session_meta" || typeof record.payload?.cwd !== "string") continue;
        const relative = path4.relative(root, path4.resolve(record.payload.cwd));
        if (relative === "" || !relative.startsWith(`..${path4.sep}`) && relative !== ".." && !path4.isAbsolute(relative)) return sessionIdFromFilename(file);
      } catch {
      }
    }
    return null;
  }
  async listSessions(limit = 20) {
    const registered = await this.registry.list(limit);
    const files = await recentRolloutFiles();
    const recent = (await Promise.all(files.map(async (file) => ({ file, stats: await fs4.stat(file) })))).sort((a, b) => b.stats.mtimeMs - a.stats.mtimeMs).slice(0, limit);
    const result = new Map(registered.map((s) => [s.sessionId, { sessionId: s.sessionId, model: s.model, lastSeenAt: s.lastSeenAt, active: s.endedAt === null, parentSessionId: null, agentName: null }]));
    for (const { file, stats } of recent) {
      const id = sessionIdFromFilename(file);
      const meta = await this.readHeader(file);
      const state = createParsedRolloutState(id, null);
      if (meta) parseRolloutLine(meta, "explicit", state);
      const previous = result.get(id);
      result.set(id, { sessionId: id, model: previous?.model ?? null, lastSeenAt: stats.mtime.toISOString(), active: previous?.active ?? false, parentSessionId: state.parentSessionId, agentName: state.agentName });
    }
    return [...result.values()].sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt)).slice(0, limit);
  }
  async readItem(sessionId, itemId) {
    await this.getContext({ sessionId });
    const entry = [...this.caches.entries()].find(([, c]) => c.state.sessionId === sessionId && c.state.locations.has(itemId));
    if (!entry) throw new Error("\u8BE5\u8BB0\u5F55\u4E0D\u5728\u4FDD\u7559\u8303\u56F4\u5185\uFF1B\u8BF7\u5237\u65B0\u540E\u91CD\u8BD5\u3002");
    const [file, cache] = entry;
    const location = cache.state.locations.get(itemId);
    const handle = await fs4.open(file, "r");
    let raw;
    try {
      raw = Buffer.alloc(location.length);
      await handle.read(raw, 0, raw.length, location.offset);
    } finally {
      await handle.close();
    }
    const payload = object(object(JSON.parse(raw.toString("utf8")))?.payload);
    if (!payload) throw new Error("\u8BB0\u5F55\u65E0\u6CD5\u89E3\u6790\u3002");
    const body = visibleText(payload);
    const expected = cache.state.activity.find((i) => i.id === itemId);
    if (!expected || digest(body) !== expected.hash) throw new Error("\u65E5\u5FD7\u5185\u5BB9\u5DF2\u53D8\u5316\uFF0C\u8BF7\u91CD\u65B0\u8BFB\u53D6\u3002");
    return { id: itemId, text: body.slice(0, 32768), truncated: body.length > 32768, scope: "Codex \u65E5\u5FD7\u516C\u5F00\u8BB0\u5F55\uFF1B\u4E0D\u662F\u5B8C\u6574\u6A21\u578B\u8BF7\u6C42\uFF1B\u4E0D\u89E3\u5BC6 reasoning" };
  }
  async readHeader(file) {
    const h = await fs4.open(file, "r");
    try {
      const buffer = Buffer.alloc(256 * 1024);
      const { bytesRead } = await h.read(buffer, 0, buffer.length, 0);
      const end = buffer.subarray(0, bytesRead).indexOf(10);
      return end < 0 ? null : buffer.subarray(0, end).toString("utf8");
    } finally {
      await h.close();
    }
  }
  async getContext(options = {}) {
    if (options.sessionId && !/^[a-zA-Z0-9_-]{1,128}$/u.test(options.sessionId)) throw new Error("Invalid session ID");
    const warnings = [];
    const located = await this.locateSession(options.sessionId);
    if (!located) {
      return {
        session: null,
        selection: "unavailable",
        snapshots: [],
        compactions: [],
        hookEvents: [],
        warnings: [
          "No active Codex session was registered and no recent rollout file was found."
        ]
      };
    }
    const transcriptPath = await existingFile(located.registration.transcriptPath);
    const fallbackPath = transcriptPath ? null : await locateRollout(located.registration.sessionId);
    const effectivePath = transcriptPath ?? fallbackPath;
    if (!effectivePath) {
      return {
        session: located.registration,
        selection: located.selection,
        snapshots: [],
        compactions: [],
        hookEvents: await this.registry.hookEvents(located.registration.sessionId),
        warnings: ["The registered Codex transcript is unavailable."]
      };
    }
    if (!transcriptPath) {
      warnings.push("The registered transcript path was unavailable; matched by session ID.");
    }
    const parsed = await this.readIncremental(
      effectivePath,
      located.selection,
      located.registration
    );
    const hookEvents = await this.registry.hookEvents(located.registration.sessionId);
    const hookCompactions = hookEvents.filter((event) => event.eventName === "PostCompact").map((event) => ({
      timestamp: event.timestamp,
      trigger: event.trigger === "manual" || event.trigger === "auto" ? event.trigger : "unknown",
      source: "hook"
    }));
    const compactions = [...parsed.compactions];
    for (const marker of hookCompactions) {
      const markerTime = Date.parse(marker.timestamp);
      const duplicate = compactions.some(
        (current) => Math.abs(Date.parse(current.timestamp) - markerTime) < 2e3
      );
      if (!duplicate) compactions.push(marker);
    }
    const modelSnapshots = selectSnapshotsForModel(
      parsed.snapshots,
      located.registration.model
    );
    if (parsed.snapshots.length > 0 && modelSnapshots.length === 0) {
      warnings.push(
        `Codex token snapshots were found, but none matched active model ${located.registration.model ?? "unknown"}; auxiliary-model values were not substituted.`
      );
    }
    return {
      session: located.registration,
      selection: located.selection,
      snapshots: modelSnapshots.map((snapshot) => ({
        ...snapshot,
        model: snapshot.model ?? located.registration.model
      })),
      compactions: compactions.slice(-MAX_COMPACTIONS),
      hookEvents,
      warnings,
      activity: summarizeActivity(parsed.activity, parsed.truncated, parsed.parentSessionId, parsed.agentName)
    };
  }
  async locateSession(sessionId) {
    if (sessionId) {
      const registered = await this.registry.get(sessionId);
      if (registered) return { registration: registered, selection: "explicit" };
      const filePath = [...this.caches.entries()].find(([, cache]) => cache.state.sessionId === sessionId)?.[0] ?? await locateRollout(sessionId);
      if (!filePath) return null;
      const stats2 = await fs4.stat(filePath);
      return {
        selection: "explicit",
        registration: {
          sessionId,
          transcriptPath: filePath,
          cwd: null,
          model: null,
          lastSeenAt: stats2.mtime.toISOString(),
          lastHookEvent: "ExplicitSessionLookup",
          endedAt: null
        }
      };
    }
    const active = (await this.registry.list()).find((session) => session.endedAt === null);
    if (active) return { registration: active, selection: "active-hook" };
    const latestPath = await locateRollout();
    if (!latestPath) return null;
    const stats = await fs4.stat(latestPath);
    return {
      selection: "latest-rollout",
      registration: {
        sessionId: sessionIdFromFilename(latestPath),
        transcriptPath: latestPath,
        cwd: null,
        model: null,
        lastSeenAt: stats.mtime.toISOString(),
        lastHookEvent: "LatestRolloutFallback",
        endedAt: null
      }
    };
  }
  async readIncremental(filePath, selection, registration) {
    const previous = this.reading.get(filePath);
    const job = (previous ?? Promise.resolve()).catch(() => void 0).then(() => this.readTail(filePath, selection, registration));
    this.reading.set(filePath, job);
    try {
      return await job;
    } finally {
      if (this.reading.get(filePath) === job) this.reading.delete(filePath);
    }
  }
  async readTail(filePath, selection, registration) {
    const stats = await fs4.stat(filePath);
    let cache = this.caches.get(filePath);
    if (!cache || stats.size < cache.offset || stats.size - cache.offset > INITIAL_TAIL_BYTES) {
      const offset = Math.max(stats.size - INITIAL_TAIL_BYTES, 0);
      cache = {
        offset,
        carry: Buffer.alloc(0),
        skipFirst: offset > 0,
        state: createParsedRolloutState(registration.sessionId, registration.model)
      };
      cache.state.truncated = offset > 0;
      if (offset > 0) {
        const header = await this.readHeader(filePath);
        if (header) parseRolloutLine(header, selection, cache.state);
      }
      this.caches.set(filePath, cache);
      while (this.caches.size > 12) this.caches.delete(this.caches.keys().next().value);
    }
    if (!cache) {
      throw new Error("Failed to initialize the rollout tail cache.");
    }
    if (stats.size === cache.offset) return cache.state;
    const length = stats.size - cache.offset;
    const handle = await fs4.open(filePath, "r");
    let bytes;
    let startOffset = cache.offset - cache.carry.length;
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, cache.offset);
      bytes = Buffer.concat([cache.carry, buffer.subarray(0, bytesRead)]);
      cache.offset += bytesRead;
    } finally {
      await handle.close();
    }
    if (cache.skipFirst) {
      const firstNewline = bytes.indexOf(10);
      if (firstNewline < 0) {
        cache.carry = Buffer.alloc(0);
        return cache.state;
      }
      startOffset += firstNewline + 1;
      bytes = bytes.subarray(firstNewline + 1);
      cache.skipFirst = false;
    }
    let start = 0;
    for (let end = bytes.indexOf(10, start); end >= 0; end = bytes.indexOf(10, start)) {
      const line = bytes.subarray(start, end).toString("utf8");
      if (line) parseRolloutLine(line, selection, cache.state, { offset: startOffset + start, length: end - start });
      start = end + 1;
    }
    cache.carry = Buffer.from(bytes.subarray(start));
    if (cache.carry.length > INITIAL_TAIL_BYTES) {
      cache.carry = Buffer.alloc(0);
      cache.skipFirst = true;
      cache.state.truncated = true;
    }
    cache.state.snapshots = cache.state.snapshots.slice(-MAX_SNAPSHOTS);
    cache.state.compactions = cache.state.compactions.slice(-MAX_COMPACTIONS);
    if (cache.state.activity.length > 500) {
      cache.state.activity = cache.state.activity.slice(-500);
      cache.state.truncated = true;
    }
    const ids = new Set(cache.state.activity.map((i) => i.id));
    for (const id of cache.state.locations.keys()) if (!ids.has(id)) cache.state.locations.delete(id);
    return cache.state;
  }
};
export {
  AppServerContextProvider,
  ContextHistoryTracker,
  ContextMonitorService,
  ContextStatusBar,
  ContextUsageService,
  ProjectActions,
  RolloutContextProvider,
  SessionRegistry,
  UNAVAILABLE_BREAKDOWN,
  activityItem,
  createParsedRolloutState,
  discoverProjects,
  parseRolloutLine,
  resolveDataDirectory,
  selectSnapshotsForModel,
  summarizeActivity,
  visibleText
};

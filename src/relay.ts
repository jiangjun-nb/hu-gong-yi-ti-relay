// Relay implementations extracted verbatim (logic unchanged) from
// hu-gong-yi-ti-app/server/src/actions.ts (教务 / 至评卓学 / 智慧树签到)
// and hu-gong-yi-ti-app-gong-kai-ban-fu-wu-qi/server/src/actions.ts
// (拓强查电费). Only the zod schemas were converted to plain TS types
// and the Muse action wrappers were removed; every upstream call,
// parse rule and error message is exactly as the app server runs it.
//
// Privacy: passwords / password ciphertexts are used for ONE upstream
// call and then dropped. Nothing is stored, nothing is logged. The
// 智慧树 Polymas session lives only in this process's memory
// (60 minutes or until a 401), like the app server.
type periodTime = { start: string, end: string };

type gradeCourseShape = {
  courseName: string,
  credit: number,
  fraction: string,
  kkxq: string,

};

type gradesPerInfoShape = {
  name: string,
  studentID: string,
  inGrade: string,
  pjxfjd: string,

};

type gradesDataShape = {
  perInfo: gradesPerInfoShape | null,
  achievement: gradeCourseShape[],
  fetchedAt: string,

};

// 至评卓学作业同步：每班的作业列表 + 每条作业的提交状态/得分。
// status: todo 未完成 / submitted 已提交等待批改 / graded 已批改 /
// review 待复核 / rejected 已打回 / autoFailed 自动批阅失败。
type lazynutAssignmentShape = {
  id: string,
  classId: string,
  className: string,
  courseName: string,
  title: string,
  dueTime: string,
  startTime: string,
  status: "todo" | "submitted" | "graded" | "review" | "rejected" | "autoFailed",
  score: string,
  submittedAt: string,

};

type lazynutClassShape = {
  classId: string,
  className: string,
  courseName: string,
  teacher: string,
  assignments: lazynutAssignmentShape[],

};

const DEFAULT_SEMESTER = {
  label: "大一上",
  termName: "2026-2027-1",
  startDate: "2026-08-31",
  totalWeeks: 20,
};
const JW_CONFIG_URL = "https://jw.hnit.edu.cn/dist/serverconfig.json";
const JW_FALLBACK_BASE = "https://jw.hnit.edu.cn/njwhd";
const JW_TIMEOUT_MS = 45000;
const JW_CONFIG_TIMEOUT_MS = 10000;

type relayCourseShape = {
  name: string,
  teacher: string,
  room: string,
  weekday: number | null,
  period: number | null,
  weeks: number[] | null,
  weeksLabel: string,

};

type relayResponse = {
  ok: boolean,
  message: string,
  courses: relayCourseShape[],
  periodTimes: periodTime[] | null,
  termName: string,
  nowWeek: number | null,

};

type RelayResult = relayResponse;
type RelayCourse = relayCourseShape;

type JwJson = Record<string, unknown>;

function jwIsObj(v: unknown): v is JwJson {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function jwPick(obj: JwJson, keys: string[]): string {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
    if (typeof v === "number") return String(v);
  }
  return "";
}

function jwFirstObj(data: unknown): JwJson | null {
  if (jwIsObj(data)) return data;
  if (Array.isArray(data)) {
    for (const item of data) if (jwIsObj(item)) return item;
  }
  return null;
}

function jwListOf(data: unknown): JwJson[] {
  if (Array.isArray(data)) return data.filter(jwIsObj);
  if (jwIsObj(data)) return [data];
  return [];
}

async function jwFetchParsed(url: string, init: RequestInit, timeoutMs: number = JW_TIMEOUT_MS): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    if (!res.ok) throw new Error(`教务系统接口返回了 HTTP ${res.status}，课表没有更新`);
    const text = await res.text();
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error("教务系统返回的内容不是预期的数据格式，课表没有更新");
    }
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      throw new Error("教务系统响应超时，请稍后再同步");
    }
    if (e instanceof Error && (e.message.includes("HTTP") || e.message.includes("格式"))) throw e;
    throw new Error("服务器连不上教务系统接口：学校服务器暂时不可用或网络不通，请稍后再试");
  } finally {
    clearTimeout(timer);
  }
}

async function jwFetchJson(url: string, init: RequestInit, timeoutMs: number = JW_TIMEOUT_MS): Promise<JwJson> {
  const parsed = await jwFetchParsed(url, init, timeoutMs);
  if (!jwIsObj(parsed)) throw new Error("教务系统返回的内容不是预期的数据格式，课表没有更新");
  return parsed;
}

async function jwApiPost(base: string, path: string, params: Record<string, string>, token?: string): Promise<JwJson> {
  const qs = new URLSearchParams(params).toString();
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
  };
  if (token) headers["token"] = token;
  return jwFetchJson(qs ? `${base}${path}?${qs}` : `${base}${path}`, { method: "POST", headers });
}

/**
 * POST variant for endpoints whose response is a bare JSON array
 * rather than an envelope object (getXnxqList answers with the term
 * list itself). Returns the parsed body in whatever shape it arrived.
 */
async function jwApiPostAny(base: string, path: string, params: Record<string, string>, token?: string): Promise<unknown> {
  const qs = new URLSearchParams(params).toString();
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
  };
  if (token) headers["token"] = token;
  return jwFetchParsed(qs ? `${base}${path}?${qs}` : `${base}${path}`, { method: "POST", headers });
}

/** A response body → its row list: a bare array, or an envelope's data. */
function jwRowsOf(raw: unknown): JwJson[] {
  if (Array.isArray(raw)) return raw.filter(jwIsObj);
  if (jwIsObj(raw)) return jwListOf(raw["data"]);
  return [];
}

function jwEnvelopeOk(json: JwJson): boolean {
  return String(json["code"]) === "1";
}

function jwEnvelopeError(json: JwJson, fallback: string): string {
  return jwPick(json, ["Msg", "msg", "message"]) || fallback;
}

/** "1-16" / "1,3,5-7" / "第1-16周" → sorted unique week numbers. */
function jwParseWeeks(raw: string): number[] {
  const weeks = new Set<number>();
  const cleaned = raw.replace(/[第周单双()（）\s]/g, "");
  for (const part of cleaned.split(/[,，、]/)) {
    if (!part) continue;
    const range = part.match(/^(\d+)-(\d+)$/);
    if (range) {
      const a = Number(range[1]);
      const b = Number(range[2]);
      if (a >= 1 && b >= a && b <= 60) for (let w = a; w <= b; w++) weeks.add(w);
      continue;
    }
    const single = part.match(/^(\d+)$/);
    if (single) {
      const n = Number(single[1]);
      if (n >= 1 && n <= 60) weeks.add(n);
    }
  }
  return [...weeks].sort((a, b) => a - b);
}

function jwWeeksLabelOf(weeks: number[] | null, fallback: string): string {
  if (fallback.trim()) return fallback.trim();
  if (!weeks || weeks.length === 0) return "无固定时间";
  const ranges: string[] = [];
  let start = weeks[0] ?? 0;
  let prev = start;
  for (let i = 1; i <= weeks.length; i++) {
    const cur = weeks[i];
    if (cur === undefined || cur !== prev + 1) {
      ranges.push(start === prev ? `${start}` : `${start}-${prev}`);
      if (cur !== undefined) start = cur;
    }
    if (cur !== undefined) prev = cur;
  }
  return `${ranges.join("、")}周`;
}

/**
 * classTime: first char is the weekday (1-7), the rest are 2-digit
 * section numbers ("0102" = sections 1-2). The app's grid uses big
 * blocks of two sections, so the period is ceil(firstSection / 2),
 * clamped to the five blocks the school timetable uses.
 */
function jwParseSlot(classTime: string): { weekday: number | null; period: number | null } {
  const ct = classTime.trim();
  if (!/^[1-7]/.test(ct)) return { weekday: null, period: null };
  const weekday = Number(ct[0]);
  const rest = ct.slice(1);
  const sections: number[] = [];
  for (let i = 0; i + 2 <= rest.length; i += 2) {
    const n = Number(rest.slice(i, i + 2));
    if (Number.isFinite(n) && n >= 1) sections.push(n);
  }
  if (sections.length === 0) return { weekday, period: null };
  const period = Math.min(5, Math.max(1, Math.ceil((sections[0] ?? 1) / 2)));
  return { weekday, period };
}

function jwToCourse(item: JwJson): RelayCourse | null {
  const name = jwPick(item, ["courseName", "kcmc", "name"]);
  if (!name) return null;
  const teacher = jwPick(item, ["teacherName", "teacher", "jsmc"]);
  const room = jwPick(item, ["classroomName", "location", "jsmc_dd", "room"]);
  const weeksRaw = jwPick(item, ["classWeek", "kkzc", "week"]);
  const weeks = weeksRaw ? jwParseWeeks(weeksRaw) : [];
  const note = jwPick(item, ["weekNoteDetail", "weekNote", "bz"]);
  const { weekday, period } = jwParseSlot(jwPick(item, ["classTime", "sksj"]));
  return {
    name,
    teacher,
    room,
    weekday,
    period: weekday === null ? null : period,
    weeks: weeks.length > 0 ? weeks : null,
    weeksLabel: jwWeeksLabelOf(weeks.length > 0 ? weeks : null, weekday === null ? note || "无固定时间" : note),
  };
}

/** jcdatalist → the five big-block start/end times, when recognizable. */
function jwParsePeriodTimes(jc: unknown): { start: string; end: string }[] | null {
  const list = jwListOf(jc);
  const entries: { idx: number; start: string; end: string }[] = [];
  list.forEach((e, i) => {
    const start = jwPick(e, ["startTime", "kssj", "beginTime", "start"]);
    const end = jwPick(e, ["endTime", "endTIme", "jssj", "finishTime", "end"]);
    if (!/^\d{1,2}:\d{2}$/.test(start) || !/^\d{1,2}:\d{2}$/.test(end)) return;
    const idxRaw = jwPick(e, ["jc", "jch", "section", "xh", "sort"]);
    const idx = idxRaw ? Number(idxRaw) : i + 1;
    entries.push({ idx: Number.isFinite(idx) ? idx : i + 1, start, end });
  });
  entries.sort((a, b) => a.idx - b.idx);
  const norm = (t: string) => {
    const [h = "0", m = "0"] = t.split(":");
    return `${h.padStart(2, "0")}:${m.padStart(2, "0")}`;
  };
  if (entries.length >= 10) {
    const blocks: { start: string; end: string }[] = [];
    for (let b = 0; b < 5; b++) {
      const first = entries[b * 2];
      const second = entries[b * 2 + 1];
      if (!first || !second) return null;
      blocks.push({ start: norm(first.start), end: norm(second.end) });
    }
    return blocks;
  }
  if (entries.length === 5) return entries.map((e) => ({ start: norm(e.start), end: norm(e.end) }));
  return null;
}

/** API base from the school's own server config, with the known base as fallback. */
async function jwResolveBase(): Promise<string> {
  let base = JW_FALLBACK_BASE;
  try {
    const cfg = await jwFetchJson(JW_CONFIG_URL, { method: "GET" }, JW_CONFIG_TIMEOUT_MS);
    const apiUrl = jwPick(cfg, ["ApiUrl", "apiUrl"]);
    if (apiUrl.startsWith("http")) base = apiUrl.replace(/\/+$/, "");
  } catch {
    // Config unreachable: try the known base; login will surface errors.
  }
  return base;
}

/**
 * Logs in to the 强智 API. `pwd` is the on-device ciphertext; it is
 * forwarded as-is and goes out of scope when the caller returns.
 * `what` names the payload being fetched (课表 / 成绩) so failure
 * messages say which update did not happen.
 */
async function jwLogin(
  base: string,
  userNo: string,
  pwd: string,
  what: string,
): Promise<{ token: string } | { error: string }> {
  let login: JwJson;
  try {
    login = await jwApiPost(base, "/login", { userNo, pwd });
  } catch (e) {
    return { error: e instanceof Error ? e.message : `登录教务系统失败，${what}没有更新` };
  }
  if (!jwEnvelopeOk(login)) {
    return { error: `登录失败：${jwEnvelopeError(login, "学号或密码不正确")}` };
  }
  const loginData = jwFirstObj(login["data"]);
  const token = loginData
    ? jwPick(loginData, ["token", "Token", "accessToken"])
    : typeof login["data"] === "string"
      ? login["data"]
      : "";
  if (!token) return { error: `登录成功了，但教务系统没有返回登录凭证（token），${what}没有更新` };
  return { token };
}

/** Current time in Asia/Shanghai as "yyyy-mm-dd HH:mm". */
function shanghaiStampNow(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

async function relayJiaowuSync(userNo: string, pwd: string): Promise<RelayResult> {
  const fail = (message: string): RelayResult => ({
    ok: false,
    message,
    courses: [],
    periodTimes: null,
    termName: "",
    nowWeek: null,
  });

  // 1) API base + 2) login (shared with the grades relay below).
  const base = await jwResolveBase();
  const loginRes = await jwLogin(base, userNo, pwd, "课表");
  if ("error" in loginRes) return fail(loginRes.error);
  const token = loginRes.token;

  // 3) Term id + section-mode id, resolved the way the school's own
  // frontend does it for a student account: /currentTerm is not the
  // student path, so the term comes from the 学年学期 list
  // (POST /getXnxqList, no params) — the entry whose xqmc is the
  // current term name, else the first entry — and the section mode
  // is the /Get_sjkbms entry flagged mrms == "1", else the first.
  let termId = "";
  let termName = "";
  try {
    const list = await jwApiPostAny(base, "/getXnxqList", {}, token);
    const items = jwRowsOf(list);
    const wanted = items.find(
      (it) => jwPick(it, ["xqmc", "xnxqmc", "termName", "name", "mc"]) === DEFAULT_SEMESTER.termName,
    );
    const chosen = wanted ?? items[0];
    if (chosen) {
      termId = jwPick(chosen, ["xnxq01id", "xnxqid", "id", "dm", "value"]);
      termName = jwPick(chosen, ["xqmc", "xnxqmc", "termName", "name", "mc"]);
    }
  } catch {
    // handled by the check below
  }
  if (!termId) {
    return fail("登录成功，但没拿到当前学期的编号，教务系统返回的格式可能变了，课表没有更新");
  }

  let modeId = "";
  try {
    const modes = await jwApiPostAny(base, "/Get_sjkbms", {}, token);
    const items = jwRowsOf(modes);
    const def = items.find((m) => jwPick(m, ["mrms"]) === "1");
    const chosen = def ?? items[0];
    if (chosen) modeId = jwPick(chosen, ["kbjcmsid", "id", "dm", "value", "sjkbmsid"]);
  } catch {
    // Section mode is optional on some deployments; curriculum may
    // still answer without it.
  }

  // 4) The full-semester timetable.
  let curr: JwJson;
  try {
    curr = await jwApiPost(base, "/student/curriculum", { xnxq01id: termId, kbjcmsid: modeId, week: "all" }, token);
  } catch (e) {
    return fail(e instanceof Error ? e.message : "拉取课表失败，课表没有更新");
  }
  if (!jwEnvelopeOk(curr)) {
    return fail(`拉取课表失败：${jwEnvelopeError(curr, "教务系统拒绝了这次请求")}`);
  }

  const dataList = Array.isArray(curr["data"]) ? curr["data"] : curr["data"] !== undefined ? [curr["data"]] : [];
  const firstData = jwFirstObj(curr["data"]);
  let nowWeek: number | null = null;
  if (firstData) {
    const nw = firstData["nowWeeked"] ?? firstData["nowWeek"] ?? firstData["week"];
    const n = typeof nw === "number" ? nw : typeof nw === "string" ? Number(nw) : NaN;
    if (Number.isFinite(n) && n >= 1 && n <= 60) nowWeek = n;
  }

  const byKey = new Map<string, RelayCourse>();
  const addItem = (item: JwJson) => {
    const c = jwToCourse(item);
    if (!c) return;
    const key = `${c.name}|${c.teacher}|${c.room}|${c.weekday ?? ""}|${c.period ?? ""}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, c);
      return;
    }
    // Same slot seen again (week="all" repeats/merges rows): union weeks.
    if (existing.weeks && c.weeks) {
      existing.weeks = [...new Set([...existing.weeks, ...c.weeks])].sort((a, b) => a - b);
      existing.weeksLabel = jwWeeksLabelOf(existing.weeks, "");
    } else if (!existing.weeks && c.weeks) {
      existing.weeks = c.weeks;
      existing.weeksLabel = c.weeksLabel;
    }
  };
  for (const entry of dataList) {
    if (!jwIsObj(entry)) continue;
    const items = entry["item"];
    if (Array.isArray(items)) for (const it of items) if (jwIsObj(it)) addItem(it);
  }
  // 无课表课程: top-level nkbList, or inside the first data entry.
  const nkbRaw = curr["nkbList"] ?? (firstData ? firstData["nkbList"] : undefined);
  if (Array.isArray(nkbRaw)) {
    for (const it of nkbRaw) {
      if (!jwIsObj(it)) continue;
      const c = jwToCourse(it);
      if (c) byKey.set(`${c.name}|${c.teacher}|${c.room}|nkb`, { ...c, weekday: null, period: null });
    }
  }

  const courses = [...byKey.values()];
  if (courses.length === 0) {
    return fail("教务系统这次没有返回任何课程，课表没有更新（原来的课表还在）");
  }

  const periodTimes = jwParsePeriodTimes(curr["jcdatalist"] ?? (firstData ? firstData["jcdatalist"] : undefined));

  return { ok: true, message: "", courses, periodTimes, termName, nowWeek };
}



// ---------- 成绩/绩点 relay (server-side) ----------
//
// Same relay pattern as the timetable sync: the device sends only the
// 学号 and the locally encrypted password ciphertext; this server logs
// in to the 强智 API and calls POST /student/termGPA with
// { semester: "", type: "1" } (all terms, the grade page's default
// query). The ciphertext is forwarded for that one call and dropped —
// never stored, never logged — and the plaintext never leaves the
// device. The response's data[0] carries perInfo (with pjxfjd, the
// official 平均学分绩点) and the achievement list; anything the school
// returns is passed through verbatim, and any failure comes back as
// the school's own message — no grade is ever invented here.

type gradesResponse = {
  ok: boolean,
  message: string,
  perInfo: gradesPerInfoShape | null,
  achievement: gradeCourseShape[],
  fetchedAt: string,

};

type GradesResult = gradesResponse;

async function relayGrades(userNo: string, pwd: string): Promise<GradesResult> {
  const fail = (message: string): GradesResult => ({
    ok: false,
    message,
    perInfo: null,
    achievement: [],
    fetchedAt: "",
  });

  const base = await jwResolveBase();
  const loginRes = await jwLogin(base, userNo, pwd, "成绩");
  if ("error" in loginRes) return fail(loginRes.error.replace("课表没有更新", "成绩没有更新"));

  let res: JwJson;
  try {
    res = await jwApiPost(base, "/student/termGPA", { semester: "", type: "1" }, loginRes.token);
  } catch (e) {
    return fail(
      e instanceof Error
        ? e.message.replace("课表没有更新", "成绩没有更新")
        : "查询成绩失败，成绩没有更新",
    );
  }
  if (!jwEnvelopeOk(res)) {
    return fail(`查询成绩失败：${jwEnvelopeError(res, "教务系统拒绝了这次请求")}`);
  }

  const first = jwFirstObj(res["data"]);
  if (!first) {
    // A successful envelope with no payload row: no grades recorded yet.
    return { ok: true, message: "", perInfo: null, achievement: [], fetchedAt: shanghaiStampNow() };
  }
  const perRaw = jwIsObj(first["perInfo"]) ? first["perInfo"] : null;
  const perInfo = perRaw
    ? {
        name: jwPick(perRaw, ["name"]),
        studentID: jwPick(perRaw, ["studentID", "studentId"]),
        inGrade: jwPick(perRaw, ["inGrade"]),
        pjxfjd: jwPick(perRaw, ["pjxfjd"]),
      }
    : null;
  const achRaw = Array.isArray(first["achievement"]) ? first["achievement"] : [];
  const achievement = achRaw
    .filter(jwIsObj)
    .map((a) => {
      const creditNum = Number(a["credit"]);
      return {
        courseName: jwPick(a, ["courseName", "kcmc", "name"]),
        credit: Number.isFinite(creditNum) ? creditNum : 0,
        fraction: jwPick(a, ["fraction", "cj"]),
        kkxq: jwPick(a, ["kkxq"]),
      };
    })
    .filter((a) => a.courseName !== "");
  return { ok: true, message: "", perInfo, achievement, fetchedAt: shanghaiStampNow() };
}

// ---------- 空闲教室 relay (server-side) ----------
//
// Same relay pattern as the timetable/grades syncs: the device sends
// only the 学号 and the locally encrypted password ciphertext; this
// server logs in to the 强智 API and calls POST
// /student/getIdleClassroom (mode A: classroom list) with
// { date, nodeId, ...optional filters } plus the term id resolved the
// same way as the timetable sync (/getXnxqList, current term name
// first). The response's data list carries classroomname / lc /
// seatnumber / zyjc per room and the top-level xingqiId; anything the
// school returns is passed through verbatim, and any failure comes
// back as the school's own message — no classroom is ever invented
// here. The ciphertext is forwarded for that one call and dropped —
// never stored, never logged. The /campusList, /tchBuildingList and
// /nodeLIst helpers feed the filter dropdowns; each is allowed to
// come back empty without failing the others, because the filters are
// optional. (Mode B, the building-utilization list, is not wired:
// the classroom list is what the app shows.)

type idleClassroomShape = {
  name: string,
  building: string,
  floor: string,
  seats: string,
  zyjc: string,

};

type idleClassroomsResponse = {
  ok: boolean,
  message: string,
  rooms: idleClassroomShape[],
  xingqiId: string,
  fetchedAt: string,

};

type IdleClassroomsResult = idleClassroomsResponse;

type idleOptionShape = {
  id: string,
  name: string,
  campusId: string,

};

type idleOptionsResponse = {
  ok: boolean,
  message: string,
  campuses: idleOptionShape[],
  buildings: idleOptionShape[],
  nodes: idleOptionShape[],

};

type IdleOptionsResult = idleOptionsResponse;

async function relayIdleClassrooms(
  userNo: string,
  pwd: string,
  q: {
    date: string;
    nodeId: string;
    buildingId?: string;
    campusId?: string;
    jsmc?: string;
    xnxq?: string;
    jiaoxueloumc?: string;
    jslx?: string;
  },
): Promise<IdleClassroomsResult> {
  const fail = (message: string): IdleClassroomsResult => ({
    ok: false,
    message,
    rooms: [],
    xingqiId: "",
    fetchedAt: "",
  });

  const base = await jwResolveBase();
  const loginRes = await jwLogin(base, userNo, pwd, "空教室");
  if ("error" in loginRes) {
    return fail(loginRes.error.replace(/课表没有更新/g, "空教室没有查到"));
  }
  const token = loginRes.token;

  // Term id, resolved exactly like the timetable sync does.
  let termId = q.xnxq ?? "";
  if (!termId) {
    try {
      const list = await jwApiPostAny(base, "/getXnxqList", {}, token);
      const items = jwRowsOf(list);
      const wanted = items.find(
        (it) => jwPick(it, ["xqmc", "xnxqmc", "termName", "name", "mc"]) === DEFAULT_SEMESTER.termName,
      );
      const chosen = wanted ?? items[0];
      if (chosen) termId = jwPick(chosen, ["xnxq01id", "xnxqid", "id", "dm", "value"]);
    } catch {
      // xnxq is optional for getIdleClassroom; query without it.
    }
  }

  const params: Record<string, string> = { date: q.date, nodeId: q.nodeId };
  if (termId) params["xnxq"] = termId;
  if (q.buildingId) params["buildingId"] = q.buildingId;
  if (q.campusId) params["campusId"] = q.campusId;
  if (q.jsmc) params["jsmc"] = q.jsmc;
  if (q.jiaoxueloumc) params["jiaoxueloumc"] = q.jiaoxueloumc;
  if (q.jslx) params["jslx"] = q.jslx;

  let res: JwJson;
  try {
    res = await jwApiPost(base, "/student/getIdleClassroom", params, token);
  } catch (e) {
    return fail(
      e instanceof Error
        ? e.message.replace(/课表没有更新/g, "空教室没有查到")
        : "查询空教室失败，空教室没有查到",
    );
  }
  if (!jwEnvelopeOk(res)) {
    return fail(`查询空教室失败：${jwEnvelopeError(res, "教务系统拒绝了这次请求")}`);
  }

  const rooms = jwListOf(res["data"])
    .map((r) => ({
      name: jwPick(r, ["classroomname", "classroomName", "jsmc", "name"]),
      building: jwPick(r, ["buildingName", "jxldmc", "jxlmc", "jiaoxueloumc", "building", "jxl"]),
      floor: jwPick(r, ["lc", "floor"]),
      seats: jwPick(r, ["seatnumber", "seatNumber", "zw", "seats"]),
      zyjc: jwPick(r, ["zyjc"]),
    }))
    .filter((r) => r.name !== "");
  const xingqiId = jwPick(res, ["xingqiId", "xqid", "weekId"]);
  return { ok: true, message: "", rooms, xingqiId, fetchedAt: shanghaiStampNow() };
}

/** One option list; any failure degrades to an empty list. */
async function jwOptionsOrEmpty(
  base: string,
  path: string,
  params: Record<string, string>,
  token: string,
  idKeys: string[],
  nameKeys: string[],
): Promise<idleOptionShape[]> {
  try {
    const raw = await jwApiPostAny(base, path, params, token);
    return jwRowsOf(raw)
      .map((r) => ({
        id: jwPick(r, idKeys),
        name: jwPick(r, nameKeys),
        campusId: jwPick(r, ["campusId", "xqid"]),
      }))
      .filter((o) => o.id !== "" || o.name !== "");
  } catch {
    return [];
  }
}

async function relayIdleClassroomOptions(
  userNo: string,
  pwd: string,
  campusId?: string,
): Promise<IdleOptionsResult> {
  const fail = (message: string): IdleOptionsResult => ({
    ok: false,
    message,
    campuses: [],
    buildings: [],
    nodes: [],
  });

  const base = await jwResolveBase();
  const loginRes = await jwLogin(base, userNo, pwd, "空教室");
  if ("error" in loginRes) {
    return fail(loginRes.error.replace(/课表没有更新/g, "空教室选项没有查到"));
  }
  const token = loginRes.token;

  const [campuses, buildings, nodes] = await Promise.all([
    jwOptionsOrEmpty(base, "/campusList", {}, token, ["campusId", "id", "xqid", "dm", "value"], ["campusName", "name", "xqmc", "mc"]),
    jwOptionsOrEmpty(
      base,
      "/tchBuildingList",
      campusId ? { campusId } : {},
      token,
      ["buildingId", "id", "jxldm", "dm", "value"],
      ["buildingName", "jxldmc", "jxlmc", "name", "mc"],
    ),
    jwOptionsOrEmpty(base, "/nodeLIst", {}, token, ["nodeId", "id", "jc", "dm", "value"], ["nodeName", "name", "jcMc", "mc"]),
  ]);
  return { ok: true, message: "", campuses, buildings, nodes };
}

// ---------- 至评卓学作业 relay (server-side) ----------
//
// Same relay pattern as the timetable/grades syncs, because lazynut
// answers CORS preflights with 403: the browser cannot call it
// directly. The client sends the 至评卓学 username + password it
// saved on the device (service "zhiping"); this server logs in once,
// pulls the student's classes and, per class, the assignment list +
// my submissions + my graded submissions, merges them per the note in
// ~/workspace/hu-gong-yi-ti/lazynut-api.md, and returns the merged
// lists. The credentials are used for that one call and dropped —
// never stored, never logged — and nothing is ever submitted or
// graded here: this only reads the assignment lists. A single class
// (or a single list inside it) failing degrades to an empty list for
// that road, so one bad class cannot sink the whole sync. Login
// failure surfaces lazynut's own message verbatim (e.g. "用户不存在");
// if the server ever demands a captcha, the message is passed through
// with a prompt to log in once on the official site — no slider is
// ever faked or forced through here. Whole call: 45 s timeout.
//
// School login: 至评卓学 has two login modes. 学号/工号登录
// (school) requires the school NAME string in the login body
// ({username, password, school}); student numbers are per-school, so
// logging in without it answers "用户不存在". 账号登录 (username /
// email / phone) sends no school. The client passes `school` only in
// school mode; when it is absent this relay sends no school field,
// exactly like the site's own account-mode login.

const LZ_BASE = "https://www.lazynut.net/api";
const LZ_TIMEOUT_MS = 45000;
const LZ_HEADERS: Record<string, string> = {
  "Content-Type": "application/json",
  "X-Grading-Contract-Version": "2",
};

type lazynutResponse = {
  ok: boolean,
  message: string,
  classes: lazynutClassShape[],
  fetchedAt: string,

};

type LazynutResult = lazynutResponse;
type LazynutAssignment = lazynutAssignmentShape;
type LazynutStatus = LazynutAssignment["status"];

type LzJson = Record<string, unknown>;

function lzIsObj(v: unknown): v is LzJson {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function lzStr(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  return "";
}

function lzPick(obj: LzJson, keys: string[]): string {
  for (const k of keys) {
    const s = lzStr(obj[k]);
    if (s !== "") return s;
  }
  return "";
}

/** lazynut envelope {code, message, data} — null when the body is not one. */
function lzEnvelope(v: unknown): { code: number; message: string; data: unknown } | null {
  if (!lzIsObj(v)) return null;
  const code = typeof v["code"] === "number" ? v["code"] : Number(v["code"]);
  if (!Number.isFinite(code)) return null;
  return { code, message: lzStr(v["message"]), data: v["data"] };
}

async function lzFetchJson(url: string, init: RequestInit, signal: AbortSignal): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      throw new Error("至评卓学响应超时（45 秒），请稍后再同步");
    }
    throw new Error("服务器连不上至评卓学：网络不通或对方暂时不可用，请稍后再试");
  }
  const text = await res.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`至评卓学返回的内容不是预期的数据格式（HTTP ${res.status}），作业没有同步`);
  }
}

async function lzGetAuthed(path: string, token: string, signal: AbortSignal): Promise<unknown> {
  return lzFetchJson(`${LZ_BASE}${path}`, {
    method: "GET",
    headers: { ...LZ_HEADERS, Authorization: `Bearer ${token}` },
  }, signal);
}

/** One list endpoint; any failure degrades to an empty list. */
async function lzListOrEmpty(path: string, token: string, signal: AbortSignal): Promise<LzJson[]> {
  try {
    const env = lzEnvelope(await lzGetAuthed(path, token, signal));
    if (!env || env.code !== 200) return [];
    return Array.isArray(env.data) ? env.data.filter(lzIsObj) : [];
  } catch {
    return [];
  }
}

/** Latest timestamp among a submission's time fields, 0 when unparseable. */
function lzSubTime(s: LzJson): number {
  let best = 0;
  for (const k of ["submittedAt", "gradedAt", "createdAt", "updatedAt"]) {
    const t = Date.parse(lzStr(s[k]));
    if (Number.isFinite(t) && t > best) best = t;
  }
  return best;
}

/** Latest submission per assignmentId (ties: later row wins). */
function lzLatestByAssignment(rows: LzJson[]): Map<string, LzJson> {
  const map = new Map<string, LzJson>();
  const times = new Map<string, number>();
  for (const row of rows) {
    const id = lzStr(row["assignmentId"]);
    if (!id) continue;
    const t = lzSubTime(row);
    if (!map.has(id) || t >= (times.get(id) ?? -1)) {
      map.set(id, row);
      times.set(id, t);
    }
  }
  return map;
}

function lzDisplayStatus(sub: LzJson | undefined, graded: boolean): LazynutStatus {
  if (graded) return "graded";
  if (!sub) return "todo";
  const status = lzPick(sub, ["status"]).toUpperCase();
  const auto = lzPick(sub, ["autoGradingState"]).toUpperCase();
  const review = lzPick(sub, ["reviewStatus"]).toUpperCase();
  if (status === "NEED_REVIEW" || review === "NEED_REVIEW") return "review";
  if (status === "REJECTED") return "rejected";
  if (status === "FAILED" || auto === "FAILED") return "autoFailed";
  if (status === "GRADED" || status === "COMPLETED") return "graded";
  if (status === "DRAFT") return "todo";
  if (
    status === "SUBMITTED" ||
    status === "PENDING" ||
    status === "GRADING" ||
    auto === "QUEUED" ||
    auto === "PROCESSING"
  ) {
    return "submitted";
  }
  return "todo";
}

async function relayLazynutAssignments(username: string, password: string, school?: string): Promise<LazynutResult> {
  const fail = (message: string): LazynutResult => ({
    ok: false,
    message,
    classes: [],
    fetchedAt: "",
  });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), LZ_TIMEOUT_MS);
  try {
    // 1) Login — lazynut's own message is surfaced verbatim on failure.
    // School mode only: the school NAME goes in the body; account mode
    // sends no school field at all (see the note above the relay).
    let loginRaw: unknown;
    try {
      loginRaw = await lzFetchJson(
        `${LZ_BASE}/auth/login`,
        {
          method: "POST",
          headers: LZ_HEADERS,
          body: JSON.stringify({
            username,
            password,
            ...(school ? { school } : {}),
          }),
        },
        ctrl.signal,
      );
    } catch (e) {
      return fail(e instanceof Error ? e.message : "登录至评卓学失败，作业没有同步");
    }
    const loginEnv = lzEnvelope(loginRaw);
    if (!loginEnv) return fail("至评卓学返回的内容不是预期的数据格式，作业没有同步");
    if (loginEnv.code !== 200) {
      const msg = loginEnv.message || "登录至评卓学失败";
      if (/验证|验证码|滑块/.test(msg)) {
        return fail(`${msg}：请先去至评卓学官网（https://www.lazynut.net/）登录一次，完成验证后再回来同步。`);
      }
      return fail(msg);
    }
    const loginData = lzIsObj(loginEnv.data) ? loginEnv.data : null;
    const token = loginData ? lzPick(loginData, ["token", "accessToken"]) : "";
    if (!token) return fail("登录成功了，但至评卓学没有返回登录凭证（token），作业没有同步");

    // 2) Student's classes.
    let classesRaw: unknown;
    try {
      classesRaw = await lzGetAuthed("/classes/student/my", token, ctrl.signal);
    } catch (e) {
      return fail(e instanceof Error ? e.message : "拉取班级列表失败，作业没有同步");
    }
    const classesEnv = lzEnvelope(classesRaw);
    if (!classesEnv) return fail("至评卓学返回的内容不是预期的数据格式，作业没有同步");
    if (classesEnv.code !== 200) {
      return fail(classesEnv.message || "拉取班级列表失败，作业没有同步");
    }
    const classRows = Array.isArray(classesEnv.data) ? classesEnv.data.filter(lzIsObj) : [];

    // 3) Per class, in parallel: assignments + my submissions + graded.
    // A single road failing degrades to an empty list for that class.
    const classes: lazynutClassShape[] = await Promise.all(
      classRows.map(async (c) => {
        const classId = lzStr(c["id"]);
        const className = lzPick(c, ["name"]);
        const courseName = lzPick(c, ["courseName", "course"]);
        const teacher = lzPick(c, ["teacherNames", "teacherName", "teacher"]);
        const enc = encodeURIComponent(classId);
        const [asgRows, subRows, gradedRows] = await Promise.all([
          lzListOrEmpty(`/assignments?classId=${enc}`, token, ctrl.signal),
          lzListOrEmpty(`/submissions/my?classId=${enc}`, token, ctrl.signal),
          lzListOrEmpty(`/submissions/my/graded?classId=${enc}`, token, ctrl.signal),
        ]);
        const latestSubs = lzLatestByAssignment(subRows);
        const latestGraded = lzLatestByAssignment(gradedRows);
        const assignments: LazynutAssignment[] = asgRows
          .map((a) => {
            const id = lzStr(a["id"]);
            if (!id) return null;
            const gradedSub = latestGraded.get(id);
            const sub = gradedSub ?? latestSubs.get(id);
            const status = lzDisplayStatus(sub, Boolean(gradedSub));
            const scoreRaw = sub ? sub["score"] : undefined;
            return {
              id,
              classId,
              className,
              courseName,
              title: lzPick(a, ["title"]) || "未命名作业",
              dueTime: lzStr(a["dueTime"]),
              startTime: lzStr(a["startTime"]),
              status,
              score: scoreRaw === null || scoreRaw === undefined ? "" : String(scoreRaw),
              submittedAt: sub ? lzStr(sub["submittedAt"]) : "",
            };
          })
          .filter((a): a is LazynutAssignment => a !== null)
          .sort((x, y) => {
            const dx = Date.parse(x.dueTime);
            const dy = Date.parse(y.dueTime);
            if (Number.isFinite(dx) && Number.isFinite(dy)) return dx - dy;
            if (Number.isFinite(dx)) return -1;
            if (Number.isFinite(dy)) return 1;
            return x.title.localeCompare(y.title, "zh-CN");
          });
        return { classId, className, courseName, teacher, assignments };
      }),
    );

    return { ok: true, message: "", classes, fetchedAt: shanghaiStampNow() };
  } finally {
    clearTimeout(timer);
  }
}

// ---------- 至评卓学做题 relay (server-side) ----------
//
// Same relay pattern as the assignment-list sync, because lazynut
// answers CORS preflights with 403: the browser cannot call it
// directly. These actions only move the student's OWN answers
// between the app and lazynut — they never invent a question, an
// answer or a score. The credentials are used for the one login and
// dropped — never stored, never logged — and the answers are passed
// through verbatim. Whole call: 45 s timeout.
//
// Endpoints (all verified against the site's own frontend JS and by
// curl: without a token each answers 401, not 404):
//   GET  /assignments/{id}              → data.questions (the paper)
//   GET  /submissions/draft/{id}        → the saved draft, if any
//   POST /submissions/draft             → save a draft
//   POST /submissions                   → submit the paper
//   GET  /submissions/{id}              → one submission's detail
//   GET  /submissions/{id}/graded       → its grading result
//   POST /upload/homework-image         → multipart, field `file`
//   DELETE /upload/homework-image/{id}  → drop an uploaded image
// Full notes: ~/workspace/hu-gong-yi-ti/lazynut-api.md.
//
// Question normalization follows the site's own AssignmentDetail
// page: a paper's questions array may nest sub-questions (a shared
// stem with several small items); those are flattened into one row
// per small item, carrying parentQuestionId and the shared stem as
// `group`. Types: SINGLE / MULTI (choiceMode `multi` also counts) /
// FILL / SUBJECTIVE (default). Options come from options /
// optionsJson / options_json, flattened to plain strings; the
// client labels them A/B/C… itself. Items the site expects on
// submit/draft mirror its own builder: choice/fill items carry the
// answer as both answerText and ocrText (the site's builder sends
// ocrText), subjective items carry imageUrl + imageUrls + pageIndex,
// and the top-level images list is every subjective image in order.

type lazynutQuestionShape = {
  id: string,
  questionId: string,
  parentQuestionId: string,
  sourceQuestionId: string,
  order: number,
  group: string,
  question: string,
  type: "SINGLE" | "MULTI" | "FILL" | "SUBJECTIVE",
  options: string[],
  score: number | null,
  images: string[],
  answerStandard: string,

};

type lazynutDraftItemShape = {
  questionId: string,
  parentQuestionId: string,
  answerText: string,
  ocrText: string,
  imageUrl: string,
  imageUrls: string[],
  pageIndex: number,

};

type lazynutDraftShape = {
  status: string,
  items: lazynutDraftItemShape[],
  images: string[],
  note: string,
  updatedAt: string,

};

type lazynutSubmissionSummaryShape = {
  id: string,
  assignmentId: string,
  status: string,
  score: string,
  submittedAt: string,
  gradedAt: string,

};

type lazynutSubmissionItemShape = {
  questionId: string,
  answerText: string,
  imageUrl: string,
  imageUrls: string[],
  score: string,
  comment: string,

};

type lazynutSubmissionDetailShape = {
  id: string,
  assignmentId: string,
  status: string,
  score: string,
  submittedAt: string,
  gradedAt: string,
  note: string,
  items: lazynutSubmissionItemShape[],
  images: string[],
  graded: boolean,

};

type lazynutDetailResponse = {
  ok: boolean,
  message: string,
  assignment: {
    id: string,
    title: string,
    dueTime: string,
    startTime: string,
    classId: string,
    gradingTiming: string,
  },
  questions: lazynutQuestionShape[],
  draft: lazynutDraftShape | null,
  submission: lazynutSubmissionSummaryShape | null,

};

type lazynutUploadResponse = {
  ok: boolean,
  message: string,
  url: string,
  fileId: string,

};

type lazynutSaveResponse = {
  ok: boolean,
  message: string,
  submissionId: string,

};

type lazynutSubmissionResponse = {
  ok: boolean,
  message: string,
  submission: lazynutSubmissionDetailShape | null,

};

/** One answer item, exactly as the site's own submit/draft builder sends it. */
type lazynutAnswerItemShape = {
  questionId: string | number,
  parentQuestionId: string | number | undefined,
  answerText: string | undefined,
  ocrText: string | undefined,
  imageUrl: string | undefined,
  imageUrls: string[] | undefined,
  pageIndex: number | undefined,

};

type LazynutQuestion = lazynutQuestionShape;
type LazynutDetailResult = lazynutDetailResponse;
type LazynutUploadResult = lazynutUploadResponse;
type LazynutSaveResult = lazynutSaveResponse;
type LazynutSubmissionResult = lazynutSubmissionResponse;

const LZ_EMPTY_ASSIGNMENT = { id: "", title: "", dueTime: "", startTime: "", classId: "", gradingTiming: "" };

/** Login shared by the do-homework actions; lazynut's own message is surfaced verbatim. */
async function lzLoginOnce(
  username: string,
  password: string,
  school: string | undefined,
  signal: AbortSignal,
): Promise<{ token: string; userId: string } | { error: string }> {
  let loginRaw: unknown;
  try {
    loginRaw = await lzFetchJson(
      `${LZ_BASE}/auth/login`,
      {
        method: "POST",
        headers: LZ_HEADERS,
        body: JSON.stringify({
          username,
          password,
          ...(school ? { school } : {}),
        }),
      },
      signal,
    );
  } catch (e) {
    return { error: e instanceof Error ? e.message : "登录至评卓学失败" };
  }
  const loginEnv = lzEnvelope(loginRaw);
  if (!loginEnv) return { error: "至评卓学返回的内容不是预期的数据格式" };
  if (loginEnv.code !== 200) {
    const msg = loginEnv.message || "登录至评卓学失败";
    if (/验证|验证码|滑块/.test(msg)) {
      return { error: `${msg}：请先去至评卓学官网（https://www.lazynut.net/）登录一次，完成验证后再回来。` };
    }
    return { error: msg };
  }
  const loginData = lzIsObj(loginEnv.data) ? loginEnv.data : null;
  const token = loginData ? lzPick(loginData, ["token", "accessToken"]) : "";
  if (!token) return { error: "登录成功了，但至评卓学没有返回登录凭证（token）" };
  // The signed-in student's id, used to pick their own row out of a
  // sign-in record list (the list endpoint returns every student's row).
  // Best effort — empty when the login payload carries no id.
  let userId = "";
  if (loginData) {
    userId = lzPick(loginData, ["id", "userId", "studentId"]);
    if (!userId) {
      for (const k of ["user", "userInfo", "student"]) {
        const nested = loginData[k];
        if (lzIsObj(nested)) {
          userId = lzPick(nested, ["id", "userId", "studentId"]);
          if (userId) break;
        }
      }
    }
  }
  return { token, userId };
}

async function lzPostAuthed(path: string, token: string, body: unknown, signal: AbortSignal): Promise<unknown> {
  return lzFetchJson(
    `${LZ_BASE}${path}`,
    {
      method: "POST",
      headers: { ...LZ_HEADERS, Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    },
    signal,
  );
}

/** DELETE with a tolerant body parse: an empty body on HTTP 200 counts as success. */
async function lzDeleteAuthed(path: string, token: string, signal: AbortSignal): Promise<{ code: number; message: string }> {
  let res: Response;
  try {
    res = await fetch(`${LZ_BASE}${path}`, {
      method: "DELETE",
      headers: { ...LZ_HEADERS, Authorization: `Bearer ${token}` },
      signal,
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      throw new Error("至评卓学响应超时（45 秒），请稍后再试");
    }
    throw new Error("服务器连不上至评卓学：网络不通或对方暂时不可用，请稍后再试");
  }
  const text = await res.text();
  if (!text.trim()) return { code: res.ok ? 200 : res.status, message: "" };
  try {
    const env = lzEnvelope(JSON.parse(text) as unknown);
    if (env) return { code: env.code, message: env.message };
  } catch {
    // Non-JSON body: fall through to the HTTP status.
  }
  return { code: res.ok ? 200 : res.status, message: "" };
}

/** Multipart image upload: the JSON Content-Type must NOT be sent, or the boundary breaks. */
async function lzUploadHomeworkImage(token: string, file: File, signal: AbortSignal): Promise<unknown> {
  const form = new FormData();
  form.append("file", file, file.name);
  return lzFetchJson(
    `${LZ_BASE}/upload/homework-image`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    },
    signal,
  );
}

function lzNormQuestionType(raw: LzJson): LazynutQuestion["type"] {
  const t = lzPick(raw, ["questionType", "type"]).trim().toUpperCase();
  if (t === "MULTI" || t === "MULTIPLE" || t === "MULTIPLE_CHOICE" || t === "MULTI_SELECT") return "MULTI";
  if (t === "FILL") return "FILL";
  if (t === "SINGLE") {
    const mode = lzPick(raw, ["choiceMode"]).trim().toLowerCase();
    if (mode === "multi" || mode === "multiple") return "MULTI";
    if (mode === "single") return "SINGLE";
    // The site's own page also treats a SINGLE whose stem or standard
    // answer mentions 多选 as MULTI (see its choiceOptions module).
    const hay = `${lzPick(raw, ["question", "questionContent", "content", "stem", "title"])} ${lzPick(raw, ["answerStandard", "answer"])}`;
    if (/多\s*选/.test(hay)) return "MULTI";
    return "SINGLE";
  }
  return "SUBJECTIVE";
}

/** options / optionsJson / options_json → plain strings (label is the client's index letter). */
function lzNormOptions(raw: LzJson): string[] {
  let v: unknown = raw["options"] ?? raw["optionsJson"] ?? raw["options_json"];
  if (typeof v === "string") {
    const t = v.trim();
    if (!t) return [];
    try {
      v = JSON.parse(t) as unknown;
    } catch {
      return [];
    }
  }
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const entry of v) {
    if (typeof entry === "string") {
      if (entry.trim()) out.push(entry.trim());
    } else if (lzIsObj(entry)) {
      const s = lzPick(entry, ["content", "text", "value", "option"]);
      if (s) out.push(s);
    }
  }
  return out;
}

/** A question's stem images, as absolute URLs (the site serves them under /upload/minio/). */
function lzNormQuestionImages(raw: LzJson): string[] {
  const v: unknown = raw["questionImages"] ?? raw["images"] ?? raw["imageUrls"];
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const entry of v) {
    const s = typeof entry === "string" ? entry.trim() : lzIsObj(entry) ? lzPick(entry, ["url", "src"]) : "";
    if (!s) continue;
    out.push(s.startsWith("/") ? `https://www.lazynut.net${s}` : s);
  }
  return out;
}

function lzNormScore(raw: LzJson): number | null {
  const v = raw["score"] ?? raw["maxScore"];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function lzNormOneQuestion(
  raw: LzJson,
  parent: LzJson | null,
  order: number,
): LazynutQuestion {
  const id = lzStr(raw["id"] ?? raw["questionId"] ?? raw["sourceQuestionId"]) || String(order);
  const parentId = parent
    ? lzStr(parent["id"] ?? parent["questionId"] ?? parent["sourceQuestionId"])
    : lzStr(raw["parentQuestionId"]);
  return {
    id,
    questionId: lzStr(raw["questionId"] ?? raw["sourceQuestionId"] ?? raw["id"]) || id,
    parentQuestionId: parentId,
    sourceQuestionId: lzStr(raw["sourceQuestionId"]),
    order,
    group: parent ? lzPick(parent, ["question", "questionContent", "content", "stem", "title"]) : "",
    question: lzPick(raw, ["question", "questionContent", "content", "stem", "title"]),
    type: lzNormQuestionType(raw),
    options: lzNormOptions(raw),
    score: lzNormScore(raw),
    images: lzNormQuestionImages(raw),
    answerStandard: lzPick(raw, ["answerStandard", "answer"]),
  };
}

/** Flatten a paper's questions: sub-questions become their own rows, keeping the shared stem as `group`. */
function lzNormQuestions(data: unknown): LazynutQuestion[] {
  const rawList = Array.isArray(data) ? data.filter(lzIsObj) : [];
  const out: LazynutQuestion[] = [];
  let order = 0;
  for (const q of rawList) {
    const subs = Array.isArray(q["questions"]) ? q["questions"].filter(lzIsObj) : [];
    if (subs.length > 0) {
      for (const s of subs) {
        order += 1;
        out.push(lzNormOneQuestion(s, q, order));
      }
    } else {
      order += 1;
      out.push(lzNormOneQuestion(q, null, order));
    }
  }
  return out;
}

/** Split a possibly comma-joined image list the way the site's own page does. */
function lzSplitImages(v: unknown): string[] {
  if (Array.isArray(v)) {
    return v.flatMap((e) =>
      typeof e === "string" ? e.split(",").map((s) => s.trim()).filter(Boolean) : [],
    );
  }
  if (typeof v === "string") return v.split(",").map((s) => s.trim()).filter(Boolean);
  return [];
}

function lzNormDraftItem(raw: LzJson): lazynutDraftItemShape {
  const answer = lzPick(raw, ["answerText", "ocrText", "text"]);
  return {
    questionId: lzStr(raw["questionId"] ?? raw["sourceQuestionId"] ?? raw["id"]),
    parentQuestionId: lzStr(raw["parentQuestionId"]),
    answerText: answer,
    ocrText: answer,
    imageUrl: lzPick(raw, ["imageUrl", "answerImage"]),
    imageUrls: lzSplitImages(raw["imageUrls"] ?? raw["imageUrl"] ?? raw["answerImage"]),
    pageIndex: typeof raw["pageIndex"] === "number" ? raw["pageIndex"] : 0,
  };
}

function lzNormDraft(data: unknown): lazynutDraftShape | null {
  if (!lzIsObj(data)) return null;
  const items = Array.isArray(data["items"]) ? data["items"].filter(lzIsObj).map(lzNormDraftItem) : [];
  return {
    status: lzPick(data, ["status"]),
    items,
    images: lzSplitImages(data["images"]),
    note: lzStr(data["note"]),
    updatedAt: lzStr(data["updatedAt"] ?? data["createdAt"]),
  };
}

function lzNormSubmissionItem(raw: LzJson): lazynutSubmissionItemShape {
  const answer = lzPick(raw, ["answerText", "ocrText", "studentAnswer", "text"]);
  return {
    questionId: lzStr(raw["questionId"] ?? raw["sourceQuestionId"] ?? raw["id"]),
    answerText: answer,
    imageUrl: lzPick(raw, ["imageUrl", "answerImage"]),
    imageUrls: lzSplitImages(raw["imageUrls"] ?? raw["imageUrl"] ?? raw["answerImage"]),
    score: lzStr(raw["score"]),
    comment: lzPick(raw, ["comment", "feedback"]),
  };
}

function lzNormSubmissionDetail(data: unknown): lazynutSubmissionDetailShape | null {
  if (!lzIsObj(data)) return null;
  const items = Array.isArray(data["items"]) ? data["items"].filter(lzIsObj).map(lzNormSubmissionItem) : [];
  return {
    id: lzStr(data["id"]),
    assignmentId: lzStr(data["assignmentId"]),
    status: lzPick(data, ["status"]),
    score: lzStr(data["score"]),
    submittedAt: lzStr(data["submittedAt"] ?? data["createdAt"]),
    gradedAt: lzStr(data["gradedAt"]),
    note: lzStr(data["note"]),
    items,
    images: lzSplitImages(data["images"]),
    graded: false,
  };
}

/** Merge a /graded payload over the submission detail (score, status, per-item marks). */
function lzMergeGraded(
  base: lazynutSubmissionDetailShape,
  gradedData: unknown,
): lazynutSubmissionDetailShape {
  if (!lzIsObj(gradedData)) return base;
  const score = lzStr(gradedData["score"]);
  const status = lzPick(gradedData, ["status"]);
  const gradedItems = Array.isArray(gradedData["items"])
    ? gradedData["items"].filter(lzIsObj).map(lzNormSubmissionItem)
    : null;
  return {
    ...base,
    score: score || base.score,
    status: status || base.status,
    gradedAt: lzStr(gradedData["gradedAt"]) || base.gradedAt,
    items: gradedItems && gradedItems.length > 0 ? gradedItems : base.items,
    graded: true,
  };
}

async function relayLazynutAssignmentDetail(
  username: string,
  password: string,
  school: string | undefined,
  assignmentId: string,
  classId: string,
): Promise<LazynutDetailResult> {
  const fail = (message: string): LazynutDetailResult => ({
    ok: false,
    message,
    assignment: { ...LZ_EMPTY_ASSIGNMENT, id: assignmentId, classId },
    questions: [],
    draft: null,
    submission: null,
  });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), LZ_TIMEOUT_MS);
  try {
    const login = await lzLoginOnce(username, password, school, ctrl.signal);
    if ("error" in login) return fail(login.error);
    const token = login.token;

    // 1) The paper itself.
    let detailRaw: unknown;
    try {
      detailRaw = await lzGetAuthed(`/assignments/${encodeURIComponent(assignmentId)}`, token, ctrl.signal);
    } catch (e) {
      return fail(e instanceof Error ? e.message : "取作业题目失败");
    }
    const detailEnv = lzEnvelope(detailRaw);
    if (!detailEnv) return fail("至评卓学返回的内容不是预期的数据格式，题目没有取到");
    if (detailEnv.code !== 200) {
      return fail(detailEnv.message || "取作业题目失败");
    }
    const data = lzIsObj(detailEnv.data) ? detailEnv.data : {};
    const assignment = {
      id: lzStr(data["id"]) || assignmentId,
      title: lzPick(data, ["title"]) || "未命名作业",
      dueTime: lzStr(data["dueTime"]),
      startTime: lzStr(data["startTime"]),
      classId: lzStr(data["classId"]) || classId,
      gradingTiming: lzPick(data, ["gradingTiming"]),
    };
    const questions = lzNormQuestions(data["questions"]);

    // 2) Draft + my submissions in parallel; either failing just means "none".
    const [draftSettled, mySettled] = await Promise.allSettled([
      lzGetAuthed(`/submissions/draft/${encodeURIComponent(assignmentId)}`, token, ctrl.signal),
      lzGetAuthed(`/submissions/my?classId=${encodeURIComponent(classId)}`, token, ctrl.signal),
    ]);
    let draft: lazynutDraftShape | null = null;
    if (draftSettled.status === "fulfilled") {
      const env = lzEnvelope(draftSettled.value);
      if (env && env.code === 200) draft = lzNormDraft(env.data);
    }
    let submission: lazynutSubmissionSummaryShape | null = null;
    if (mySettled.status === "fulfilled") {
      const env = lzEnvelope(mySettled.value);
      if (env && env.code === 200 && Array.isArray(env.data)) {
        const rows = env.data.filter(lzIsObj).filter((r) => lzStr(r["assignmentId"]) === assignmentId);
        const latest = lzLatestByAssignment(rows).get(assignmentId);
        if (latest) {
          submission = {
            id: lzStr(latest["id"]),
            assignmentId,
            status: lzPick(latest, ["status"]),
            score: latest["score"] === null || latest["score"] === undefined ? "" : String(latest["score"]),
            submittedAt: lzStr(latest["submittedAt"]),
            gradedAt: lzStr(latest["gradedAt"]),
          };
        }
      }
    }

    return { ok: true, message: "", assignment, questions, draft, submission };
  } finally {
    clearTimeout(timer);
  }
}

function lzImageMime(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  if (ext === "gif") return "image/gif";
  return "image/jpeg";
}

async function relayLazynutUploadImage(
  username: string,
  password: string,
  school: string | undefined,
  imageBase64: string,
  filename: string,
): Promise<LazynutUploadResult> {
  const fail = (message: string): LazynutUploadResult => ({ ok: false, message, url: "", fileId: "" });

  const b64 = imageBase64.replace(/^data:[^;]+;base64,/, "").trim();
  if (!/^[A-Za-z0-9+/=]+$/.test(b64) || b64.length === 0) return fail("图片数据不对，传图没有成功");
  const buf = Buffer.from(b64, "base64");
  if (buf.length === 0) return fail("图片数据不对，传图没有成功");
  if (buf.length > 10 * 1024 * 1024) return fail("图片超过 10MB，传图没有成功");
  const safeName = filename.replace(/[\\/]/g, "_").slice(0, 120) || "answer.jpg";

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), LZ_TIMEOUT_MS);
  try {
    const login = await lzLoginOnce(username, password, school, ctrl.signal);
    if ("error" in login) return fail(login.error);
    let raw: unknown;
    try {
      raw = await lzUploadHomeworkImage(
        login.token,
        new File([buf], safeName, { type: lzImageMime(safeName) }),
        ctrl.signal,
      );
    } catch (e) {
      return fail(e instanceof Error ? e.message : "传图失败");
    }
    const env = lzEnvelope(raw);
    if (!env) return fail("至评卓学返回的内容不是预期的数据格式，图片没有传上去");
    if (env.code !== 200) return fail(env.message || "传图失败");
    const data = lzIsObj(env.data) ? env.data : null;
    const url = data ? lzPick(data, ["url"]) : "";
    const fileId = data ? lzStr(data["fileId"] ?? data["id"]) : "";
    if (!url) return fail("至评卓学没有返回图片地址，图片没有传上去");
    return { ok: true, message: "", url, fileId };
  } finally {
    clearTimeout(timer);
  }
}

async function relayLazynutDeleteImage(
  username: string,
  password: string,
  school: string | undefined,
  fileId: string,
): Promise<{ ok: boolean; message: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), LZ_TIMEOUT_MS);
  try {
    const login = await lzLoginOnce(username, password, school, ctrl.signal);
    if ("error" in login) return { ok: false, message: login.error };
    let res: { code: number; message: string };
    try {
      res = await lzDeleteAuthed(`/upload/homework-image/${encodeURIComponent(fileId)}`, login.token, ctrl.signal);
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : "删图失败" };
    }
    if (res.code !== 200) return { ok: false, message: res.message || "删图失败" };
    return { ok: true, message: "" };
  } finally {
    clearTimeout(timer);
  }
}

async function relayLazynutSave(
  username: string,
  password: string,
  school: string | undefined,
  body: {
    assignmentId: string;
    items: lazynutAnswerItemShape[];
    images: string[];
    note: string;
    discardedUploadFileIds: (string | number)[];
    isIncomplete?: boolean;
  },
  isSubmit: boolean,
): Promise<LazynutSaveResult> {
  const fail = (message: string): LazynutSaveResult => ({ ok: false, message, submissionId: "" });

  // Format check only — the answers themselves are passed through untouched.
  if (isSubmit && body.items.length === 0) {
    return fail("还没有作答，提交没有成功");
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), LZ_TIMEOUT_MS);
  try {
    const login = await lzLoginOnce(username, password, school, ctrl.signal);
    if ("error" in login) return fail(login.error);
    let raw: unknown;
    try {
      raw = await lzPostAuthed(
        isSubmit ? "/submissions" : "/submissions/draft",
        login.token,
        {
          assignmentId: body.assignmentId,
          items: body.items,
          images: body.images,
          note: body.note,
          ...(isSubmit ? { isIncomplete: body.isIncomplete ?? false } : {}),
          discardedUploadFileIds: body.discardedUploadFileIds,
        },
        ctrl.signal,
      );
    } catch (e) {
      return fail(e instanceof Error ? e.message : isSubmit ? "提交失败" : "保存草稿失败");
    }
    const env = lzEnvelope(raw);
    if (!env) return fail("至评卓学返回的内容不是预期的数据格式");
    if (env.code !== 200) return fail(env.message || (isSubmit ? "提交失败" : "保存草稿失败"));
    const data = lzIsObj(env.data) ? env.data : null;
    return {
      ok: true,
      message: "",
      submissionId: data ? lzStr(data["id"] ?? data["submissionId"]) : "",
    };
  } finally {
    clearTimeout(timer);
  }
}

async function relayLazynutSubmission(
  username: string,
  password: string,
  school: string | undefined,
  submissionId: string,
): Promise<LazynutSubmissionResult> {
  const fail = (message: string): LazynutSubmissionResult => ({ ok: false, message, submission: null });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), LZ_TIMEOUT_MS);
  try {
    const login = await lzLoginOnce(username, password, school, ctrl.signal);
    if ("error" in login) return fail(login.error);
    const token = login.token;
    let raw: unknown;
    try {
      raw = await lzGetAuthed(`/submissions/${encodeURIComponent(submissionId)}`, token, ctrl.signal);
    } catch (e) {
      return fail(e instanceof Error ? e.message : "取提交记录失败");
    }
    const env = lzEnvelope(raw);
    if (!env) return fail("至评卓学返回的内容不是预期的数据格式，提交记录没有取到");
    if (env.code !== 200) return fail(env.message || "取提交记录失败");
    let submission = lzNormSubmissionDetail(env.data);
    if (!submission) return fail("至评卓学没有返回这次提交的记录");
    // Grading result: 404 / not graded yet just means "not graded".
    try {
      const gradedRaw = await lzGetAuthed(`/submissions/${encodeURIComponent(submissionId)}/graded`, token, ctrl.signal);
      const gradedEnv = lzEnvelope(gradedRaw);
      if (gradedEnv && gradedEnv.code === 200) {
        submission = lzMergeGraded(submission, gradedEnv.data);
      }
    } catch {
      // Leave the submission ungraded; the client says so plainly.
    }
    return { ok: true, message: "", submission };
  } finally {
    clearTimeout(timer);
  }
}

// ---------- 至评卓学签到 relay (server-side) ----------
//
// Endpoints reverse-engineered from the official 至评卓学 Android App
// v1.0.90 (uni-app APK; full notes in ~/workspace/hu-gong-yi-ti/lazynut-api.md
// "签到" — the student web frontend has no sign-in page, the App does).
// Every path below was verified to exist: without a token each answers
// 401, not 404. Same relay pattern as the homework actions (CORS 403
// blocks the browser, so the server calls lazynut directly): the client
// sends the 至评卓学 username + password saved on the device (service
// "zhiping"; used for this one login only, never stored or logged), the
// server logs in once, calls the sign-in endpoint, and drops the
// credentials. This submits a REAL sign-in — the student's own tap /
// GPS / gesture / QR content, forwarded verbatim. Nothing is invented:
// a sign-in the teacher never started never appears, and a failed
// submit surfaces lazynut's own message verbatim (e.g. 手势密码错误).
// Whole call: 45 s timeout.

function lzNum(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

function lzBool(v: unknown): boolean {
  return v === true || v === "true" || v === 1 || v === "1";
}

type lazynutSignInLocationShape = {
  name: string,
  lat: number,
  lng: number,
  range: number,

};

type lazynutSignInActivityShape = {
  id: string,
  classId: string,
  className: string,
  activityType: string,
  signInType: string,
  status: string,
  title: string,
  myStatus: string,
  myLateMinutes: number | null,
  myRecordTime: string,
  actionRequired: boolean,

};

type lazynutSignInListResponse = {
  ok: boolean,
  message: string,
  pendingCount: number,
  activeCount: number,
  totalCount: number,
  activities: lazynutSignInActivityShape[],

};

type lazynutSignInDetailShape = {
  id: string,
  classId: string,
  className: string,
  title: string,
  signInType: string,
  status: string,
  myStatus: string,
  myLateMinutes: number | null,
  myRecordTime: string,
  locations: lazynutSignInLocationShape[],

};

type lazynutSignInDetailResponse = {
  ok: boolean,
  message: string,
  activity: lazynutSignInDetailShape | null,

};

type lazynutSignInRecordShape = {
  status: string,
  signInTime: string,
  lateMinutes: number | null,
  recordSource: string,

};

type lazynutSignInRecordsResponse = {
  ok: boolean,
  message: string,
  record: lazynutSignInRecordShape | null,

};

type lazynutSignInSubmitResponse = {
  ok: boolean,
  message: string,
  status: string,
  lateMinutes: number | null,
  signInTime: string,
  recordSource: string,

};

type LazynutSignInListResult = lazynutSignInListResponse;
type LazynutSignInDetailResult = lazynutSignInDetailResponse;
type LazynutSignInRecordsResult = lazynutSignInRecordsResponse;
type LazynutSignInSubmitResult = lazynutSignInSubmitResponse;
type LazynutSignInActivity = lazynutSignInActivityShape;

/** One activity row from /classes/activities/student/my, normalized. */
function lzNormSignInActivity(raw: LzJson, className: string): LazynutSignInActivity {
  const late = raw["myLateMinutes"];
  return {
    id: lzStr(raw["id"]),
    classId: lzStr(raw["classId"]),
    className: className || lzPick(raw, ["className", "courseName"]) || "",
    activityType: lzPick(raw, ["activityType"]) || "",
    signInType: lzPick(raw, ["signInType"]) || "NORMAL",
    status: lzPick(raw, ["status"]) || "",
    title: lzPick(raw, ["title", "name"]) || "签到",
    myStatus: lzPick(raw, ["myStatus"]) || "",
    myLateMinutes: late === null || late === undefined || late === "" ? null : lzNum(late),
    myRecordTime: lzStr(raw["myRecordTime"]),
    actionRequired: lzBool(raw["actionRequired"]),
  };
}

/** The three location shapes the detail endpoint may use, normalized to one list. */
function lzNormSignInLocations(data: LzJson): lazynutSignInLocationShape[] {
  const out: lazynutSignInLocationShape[] = [];
  const push = (raw: unknown) => {
    if (!lzIsObj(raw)) return;
    const lat = lzNum(raw["lat"] ?? raw["latitude"]);
    const lng = lzNum(raw["lng"] ?? raw["lon"] ?? raw["longitude"]);
    if (lat === 0 && lng === 0) return;
    const range = lzNum(raw["range"] ?? raw["radius"]);
    out.push({
      name: lzPick(raw, ["name", "locationName"]) || "签到点",
      lat,
      lng,
      range: range > 0 ? range : 100,
    });
  };
  const locs = data["locations"];
  if (Array.isArray(locs)) locs.forEach(push);
  const locJson = data["locationsJson"];
  if (typeof locJson === "string" && locJson.trim()) {
    try {
      const parsed = JSON.parse(locJson) as unknown;
      if (Array.isArray(parsed)) parsed.forEach(push);
    } catch {
      // Malformed locationsJson: fall through to the flat fields.
    }
  }
  if (out.length === 0) {
    push({
      lat: data["locationLat"] ?? data["lat"],
      lng: data["locationLng"] ?? data["lng"],
      range: data["locationRange"] ?? data["range"],
      name: data["locationName"] ?? data["name"],
    });
  }
  return out;
}

/** One sign-in record row, normalized. */
function lzNormSignInRecord(raw: LzJson): lazynutSignInRecordShape {
  const late = raw["lateMinutes"];
  return {
    status: lzPick(raw, ["status"]) || "",
    signInTime: lzStr(raw["signInTime"] ?? raw["createdAt"] ?? raw["recordTime"]),
    lateMinutes: late === null || late === undefined || late === "" ? null : lzNum(late),
    recordSource: lzPick(raw, ["recordSource", "source"]) || "",
  };
}

/** My own row out of a sign-in-records list, matched on the login user id. */
function lzMySignInRecord(rows: LzJson[], userId: string): lazynutSignInRecordShape | null {
  if (rows.length === 0 || !userId) return null;
  const mine = rows.find((r) => lzStr(r["studentId"] ?? r["userId"] ?? r["id"]) === userId);
  return mine ? lzNormSignInRecord(mine) : null;
}

async function relayLazynutSignInList(
  username: string,
  password: string,
  school: string | undefined,
): Promise<LazynutSignInListResult> {
  const fail = (message: string): LazynutSignInListResult => ({
    ok: false,
    message,
    pendingCount: 0,
    activeCount: 0,
    totalCount: 0,
    activities: [],
  });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), LZ_TIMEOUT_MS);
  try {
    const login = await lzLoginOnce(username, password, school, ctrl.signal);
    if ("error" in login) return fail(login.error);
    const token = login.token;

    // The activity list + the pending-count badge in parallel; the
    // class list is best-effort, only to fill in course names.
    const [listSettled, countSettled, classesSettled] = await Promise.allSettled([
      lzGetAuthed("/classes/activities/student/my", token, ctrl.signal),
      lzGetAuthed("/classes/activities/student/pending-count", token, ctrl.signal),
      lzGetAuthed("/classes/student/my", token, ctrl.signal),
    ]);
    if (listSettled.status === "rejected") {
      return fail(listSettled.reason instanceof Error ? listSettled.reason.message : "取签到列表失败");
    }
    const listEnv = lzEnvelope(listSettled.value);
    if (!listEnv) return fail("至评卓学返回的内容不是预期的数据格式，签到列表没有取到");
    if (listEnv.code !== 200) return fail(listEnv.message || "取签到列表失败");
    const listData = lzIsObj(listEnv.data) ? listEnv.data : {};
    const rows = Array.isArray(listEnv.data)
      ? listEnv.data.filter(lzIsObj)
      : Array.isArray(listData["activities"])
        ? (listData["activities"] as unknown[]).filter(lzIsObj)
        : [];
    const classNames = new Map<string, string>();
    if (classesSettled.status === "fulfilled") {
      const env = lzEnvelope(classesSettled.value);
      if (env && env.code === 200 && Array.isArray(env.data)) {
        for (const c of env.data.filter(lzIsObj)) {
          const name = lzPick(c, ["name", "courseName"]);
          if (lzStr(c["id"]) && name) classNames.set(lzStr(c["id"]), name);
        }
      }
    }
    const activities = rows
      .map((r) => lzNormSignInActivity(r, classNames.get(lzStr(r["classId"])) ?? ""))
      .filter((a) => a.id !== "");
    const pending = activities.filter(
      (a) => a.activityType === "SIGN_IN" && a.status === "ACTIVE" && a.myStatus === "",
    );
    const active = activities.filter((a) => a.activityType === "SIGN_IN" && a.status === "ACTIVE");
    let pendingCount = pending.length;
    if (countSettled.status === "fulfilled") {
      const env = lzEnvelope(countSettled.value);
      if (env && env.code === 200) {
        const n = typeof env.data === "number" ? env.data : lzNum(lzIsObj(env.data) ? env.data["pendingCount"] ?? env.data["count"] : 0);
        if (n > 0) pendingCount = n;
      }
    }
    return {
      ok: true,
      message: "",
      pendingCount,
      activeCount: active.length,
      totalCount: typeof listData["totalCount"] === "number" ? listData["totalCount"] : activities.length,
      activities,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function relayLazynutSignInDetail(
  username: string,
  password: string,
  school: string | undefined,
  classId: string,
  activityId: string,
): Promise<LazynutSignInDetailResult> {
  const fail = (message: string): LazynutSignInDetailResult => ({ ok: false, message, activity: null });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), LZ_TIMEOUT_MS);
  try {
    const login = await lzLoginOnce(username, password, school, ctrl.signal);
    if ("error" in login) return fail(login.error);
    let raw: unknown;
    try {
      raw = await lzGetAuthed(
        `/classes/${encodeURIComponent(classId)}/activities/${encodeURIComponent(activityId)}`,
        login.token,
        ctrl.signal,
      );
    } catch (e) {
      return fail(e instanceof Error ? e.message : "取签到详情失败");
    }
    const env = lzEnvelope(raw);
    if (!env) return fail("至评卓学返回的内容不是预期的数据格式，签到详情没有取到");
    if (env.code !== 200) return fail(env.message || "取签到详情失败");
    const data = lzIsObj(env.data) ? env.data : {};
    const late = data["myLateMinutes"];
    return {
      ok: true,
      message: "",
      activity: {
        id: lzStr(data["id"]) || activityId,
        classId: lzStr(data["classId"]) || classId,
        className: lzPick(data, ["className", "courseName"]) || "",
        title: lzPick(data, ["title", "name"]) || "签到",
        signInType: lzPick(data, ["signInType"]) || "NORMAL",
        status: lzPick(data, ["status"]) || "",
        myStatus: lzPick(data, ["myStatus"]) || "",
        myLateMinutes: late === null || late === undefined || late === "" ? null : lzNum(late),
        myRecordTime: lzStr(data["myRecordTime"]),
        locations: lzNormSignInLocations(data),
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

async function relayLazynutSignInRecords(
  username: string,
  password: string,
  school: string | undefined,
  classId: string,
  activityId: string,
): Promise<LazynutSignInRecordsResult> {
  const fail = (message: string): LazynutSignInRecordsResult => ({ ok: false, message, record: null });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), LZ_TIMEOUT_MS);
  try {
    const login = await lzLoginOnce(username, password, school, ctrl.signal);
    if ("error" in login) return fail(login.error);
    let raw: unknown;
    try {
      raw = await lzGetAuthed(
        `/classes/${encodeURIComponent(classId)}/activities/${encodeURIComponent(activityId)}/sign-in-records`,
        login.token,
        ctrl.signal,
      );
    } catch (e) {
      return fail(e instanceof Error ? e.message : "取签到记录失败");
    }
    const env = lzEnvelope(raw);
    if (!env) return fail("至评卓学返回的内容不是预期的数据格式，签到记录没有取到");
    if (env.code !== 200) return fail(env.message || "取签到记录失败");
    const rows = Array.isArray(env.data) ? env.data.filter(lzIsObj) : [];
    return { ok: true, message: "", record: lzMySignInRecord(rows, login.userId) };
  } finally {
    clearTimeout(timer);
  }
}

async function relayLazynutSignInSubmit(
  username: string,
  password: string,
  school: string | undefined,
  args: {
    classId: string;
    activityId: string;
    deviceId: string;
    lat: number | null;
    lng: number | null;
    qrContent: string | null;
    gesturePattern: string | null;
  },
): Promise<LazynutSignInSubmitResult> {
  const fail = (message: string): LazynutSignInSubmitResult => ({
    ok: false,
    message,
    status: "",
    lateMinutes: null,
    signInTime: "",
    recordSource: "",
  });

  // Format checks only — the gesture pattern itself is judged by
  // lazynut ("手势密码错误" comes back verbatim); nothing is corrected here.
  if (!args.deviceId.trim()) return fail("设备标识丢了，签到没有提交：关掉重开再试一次");
  if (args.gesturePattern !== null && !/^[0-8]{4,9}$/.test(args.gesturePattern)) {
    return fail("手势至少连 4 个点，签到没有提交");
  }
  if (args.lat !== null && (args.lat < -90 || args.lat > 90)) return fail("定位不对，签到没有提交");
  if (args.lng !== null && (args.lng < -180 || args.lng > 180)) return fail("定位不对，签到没有提交");

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), LZ_TIMEOUT_MS);
  try {
    const login = await lzLoginOnce(username, password, school, ctrl.signal);
    if ("error" in login) return fail(login.error);
    const token = login.token;

    // The body shape depends on the sign-in type; fields that do not
    // apply are left out, except GESTURE, which the App sends with
    // explicit nulls for qrContent / lat / lng.
    const body: Record<string, unknown> = { deviceId: args.deviceId };
    if (args.gesturePattern !== null) {
      body["qrContent"] = null;
      body["gesturePattern"] = args.gesturePattern;
      body["lat"] = null;
      body["lng"] = null;
    } else {
      if (args.qrContent !== null) body["qrContent"] = args.qrContent;
      if (args.lat !== null) body["lat"] = args.lat;
      if (args.lng !== null) body["lng"] = args.lng;
    }

    let raw: unknown;
    try {
      raw = await lzPostAuthed(
        `/classes/${encodeURIComponent(args.classId)}/activities/${encodeURIComponent(args.activityId)}/sign-in`,
        token,
        body,
        ctrl.signal,
      );
    } catch (e) {
      return fail(e instanceof Error ? e.message : "签到提交失败");
    }
    const env = lzEnvelope(raw);
    if (!env) return fail("至评卓学返回的内容不是预期的数据格式，签到没有提交");
    if (env.code !== 200) return fail(env.message || "签到没有成功");
    const data = lzIsObj(env.data) ? env.data : {};
    let status = lzPick(data, ["status"]);
    let lateMinutes: number | null =
      data["lateMinutes"] === null || data["lateMinutes"] === undefined ? null : lzNum(data["lateMinutes"]);
    let signInTime = lzStr(data["signInTime"]);
    let recordSource = lzPick(data, ["recordSource", "source"]);

    // Confirm against the record lazynut actually stored — the submit
    // response is not taken on trust alone.
    try {
      const recRaw = await lzGetAuthed(
        `/classes/${encodeURIComponent(args.classId)}/activities/${encodeURIComponent(args.activityId)}/sign-in-records`,
        token,
        ctrl.signal,
      );
      const recEnv = lzEnvelope(recRaw);
      if (recEnv && recEnv.code === 200 && Array.isArray(recEnv.data)) {
        const mine = lzMySignInRecord(recEnv.data.filter(lzIsObj), login.userId);
        if (mine && mine.status) {
          status = mine.status;
          lateMinutes = mine.lateMinutes;
          signInTime = mine.signInTime;
          recordSource = mine.recordSource;
        }
      }
    } catch {
      // The submit already succeeded; the stored record just could not
      // be re-read this time — the submit response still stands.
    }
    return { ok: true, message: "", status, lateMinutes, signInTime, recordSource };
  } finally {
    clearTimeout(timer);
  }
}

// ---------- 智慧树（知到）签到 relay (server-side) ----------
//
// Scope the owner approved on 2026-11-23 ("算了选一吧"): server relay
// ONLY to obtain a Polymas token for sign-in, and ONLY for the sign-in
// APIs below. This is an explicit exception to his earlier "不要用中转"
// (2026-11-23 13:35), which was about video/learning-page relay — the
// video relay stays dismantled and no video or learning-page traffic
// goes through this server.
//
// Flow (reversed 2026-11-23 from the official login page
// https://login.zhihuishu.com, bundle /assets/index-C5yo0atL.js and its
// lazy chunk index-D8JpkCJd.js):
//   1) The App renders Zhihuishu's own AbleCaptcha slider
//      (base2.zhihuishu.com/ableCaptcha/assets/ableCaptchaPCv2Common.js,
//      the same component the login page uses) and the owner slides it
//      himself; the App sends the one-time validate to
//      prepareZhihuishuSignInSession with the bound account (phone) and
//      the password saved on the device. The server never solves or
//      bypasses the captcha.
//   2) The server POSTs //user.zhihuishu.com/zhsuser/login/account with
//      {account, password, validate} encrypted as AES-CBC (key
//      "bdas85990328dfpl", IV "563216db1e1744c7" — both hard-coded in
//      Zhihuishu's own public login bundle, the same for every visitor;
//      base64 of the JSON, sent as a JSON string), which is the login
//      page's own $a() transform. Verified 2026-11-23 with a fake
//      account + fake validate: Zhihuishu answered
//      {"status":-4,"msg":"滑动验证码校验失败"}, i.e. it decrypted the
//      body and judged the captcha, so the request format is right. The
//      password is used for this one login only and then dropped — never
//      stored, never logged. Before the POST the server GETs
//      https://login.zhihuishu.com/ once so the POST carries the same
//      session cookies a browser would have; the POST follows redirects
//      manually so Set-Cookie is collected on every hop.
//   3) The server then does exactly what the login page does in the
//      browser (userStore goOnceLogin/LoginDirectly): it navigates to
//      passport.zhihuishu.com/login?pwd=<rt.pwd>&service=<cloudapi
//      oauth/login/ssoLogin?redirect=...>. The one-time password in
//      rt.pwd is what makes passport issue the CAS session — WITHOUT it
//      passport has nothing to authenticate, no CASTGC/CASLOGC cookies
//      are set, and getToken answers 401 "拒绝访问，未登录！". That was
//      the bug until 2026-11-23 23:40: the old code called the same URL
//      without pwd, so a correct password + a valid captcha still ended
//      in 401. The redirect chain is followed manually (3xx, meta
//      refresh, auto-submit form, JS location) and its end state is
//      reported in the prepare response diagnostics (stage,
//      loginStatus, tokenCode, hopCount, ssoLastStatus/Url/Ticket).
//      Then the server POSTs /teachingCenterAi/polymasApi/getToken with
//      NO body for the Polymas token. The token and the cookie jar live
//      ONLY in server memory (module-level, per account), never in the
//      database, never in logs; they are dropped after 60 minutes or on
//      the first 401. Steps 2-3 with a REAL password + validate were NOT
//      verifiable end-to-end in the sandbox (the real password lives
//      only on the owner's phone and a validate only comes from his own
//      slider) — the owner has to try it in the App; with a fake
//      validate the chain correctly stops at stage "login" with
//      status -4.
//   4) Sign-in APIs (host https://cloudapi.polymas.com, header
//      Authorization: <token>) — all verified to exist (401 without a
//      login, 2026-11-23): POST /student-app/api/sign/student (submit),
//      GET /student-app/api/sign/detail, /student-app/api/sign/student/
//      hasSigned, /student-app/api/sign/check/finish,
//      /student-app/api/sign/stu/record/stu-detail, GET
//      /teacher-app/qrcode/info (resolve a scanned QR sceneKey).
//      Discovery of live sign-ins is the one unproven step: the
//      classroom H5 has no "list live sign-ins" endpoint (sign-ins
//      arrive over IM), so the relay tries the three activityTask/list
//      candidates the Flutter side names and reports which one answered
//      (see relayZhihuishuSignInList). If none of them lists sign-ins,
//      the App honestly shows "暂无签到" — no fake sign-in button is
//      ever rendered.
//   5) Nothing is ever faked: only teacher-started sign-ins are shown
//      and submitted, with the student's own tap / GPS / gesture / QR /
//      password; a submit is confirmed by re-reading the stored record
//      before the App shows success, and any failure returns
//      Zhihuishu/Polymas's own message verbatim. Two formats could NOT
//      be verified from the official JS: the password-submit field name
//      (sent as signPassword — if Polymas rejects it, its message is
//      shown as-is) and the photo-submit format (photo sign-in is NOT
//      submitted from the App; the page says so and points at 知到 App).

const ZHS_LOGIN_URL = "https://user.zhihuishu.com/zhsuser/login/account";
const ZHS_POLYMAS = "https://cloudapi.polymas.com";
const ZHS_TIMEOUT_MS = 60000;
const ZHS_UA =
  "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36";
const ZHS_HEADERS: Record<string, string> = {
  "Content-Type": "application/json;charset=UTF-8",
  Origin: "https://login.zhihuishu.com",
  Referer: "https://login.zhihuishu.com/",
  "User-Agent": ZHS_UA,
};

type zhsSignInActivityShape = {
  id: string,
  signId: string,
  title: string,
  courseName: string,
  signType: string,
  status: string,
  signed: boolean,
  finished: boolean,
  term: string,
  courseId: string,
  lessonId: string,

};

type zhsSignInListResponse = {
  ok: boolean,
  message: string,
  needsLogin: boolean,
  activities: zhsSignInActivityShape[],
  discovery: {
    path: string,
    totalRows: number,
    signLikeCount: number,
    tried: string[],
  },

};

type zhsSignInLocationShape = {
  lng: number,
  lat: number,
  range: number,

};

type zhsSignInDetailShape = {
  signId: string,
  title: string,
  signType: string,
  signTypeNum: number,
  status: string,
  endTime: string,
  isFinish: boolean,
  signPasswordSwitch: boolean,
  location: zhsSignInLocationShape | null,
  term: string,
  courseId: string,
  lessonId: string,
  signed: boolean,

};

type zhsSignInDetailResponse = {
  ok: boolean,
  message: string,
  needsLogin: boolean,
  activity: zhsSignInDetailShape | null,

};

type zhsSignInRecordShape = {
  signed: boolean,
  signInTime: string,

};

type zhsSignInRecordsResponse = {
  ok: boolean,
  message: string,
  needsLogin: boolean,
  record: zhsSignInRecordShape | null,

};

type zhsSignInSubmitResponse = {
  ok: boolean,
  message: string,
  needsLogin: boolean,
  status: string,
  signInTime: string,
  gestureResult: string,
  gestureCountdownSeconds: number | null,
  gestureRemaining: number | null,

};

type zhsQrResolveResponse = {
  ok: boolean,
  message: string,
  needsLogin: boolean,
  signId: string,
  lessonId: string,

};

type zhsPrepareResponse = {
  ok: boolean,
  message: string,
  sessionReady: boolean,
  // Diagnostics (no secrets: only stage codes, status codes and URLs
  // with the query string stripped — never cookie values, tickets or
  // passwords). Added 2026-11-23 when the SSO hop kept failing.
  stage: "login" | "sso" | "token" | "done",
  loginStatus: number | null,
  tokenCode: number | string | null,
  hopCount: number,
  ssoLastStatus: number | null,
  ssoLastUrl: string,
  ssoSawTicket: boolean,
  isSkipPolymas: boolean,
  hasOncePwd: boolean,
  preGetStatus: number | null,

};

/** Diagnostics carried through zhsLoginOnce (same fields as above). */
type ZhsLoginDiag = {
  stage: "login" | "sso" | "token" | "done",
  loginStatus: number | null,
  tokenCode: number | string | null,
  hopCount: number,
  ssoLastStatus: number | null,
  ssoLastUrl: string,
  ssoSawTicket: boolean,
  isSkipPolymas: boolean,
  hasOncePwd: boolean,
  preGetStatus: number | null,

};

function zhsEmptyDiag(): ZhsLoginDiag {
  return {
    stage: "login",
    loginStatus: null,
    tokenCode: null,
    hopCount: 0,
    ssoLastStatus: null,
    ssoLastUrl: "",
    ssoSawTicket: false,
    isSkipPolymas: false,
    hasOncePwd: false,
    preGetStatus: null,
  };
}

type ZhsSignInListResult = zhsSignInListResponse;
type ZhsSignInDetailResult = zhsSignInDetailResponse;
type ZhsSignInRecordsResult = zhsSignInRecordsResponse;
type ZhsSignInSubmitResult = zhsSignInSubmitResponse;
type ZhsQrResolveResult = zhsQrResolveResponse;
type ZhsPrepareResult = zhsPrepareResponse;
type ZhsSignInActivity = zhsSignInActivityShape;

type ZhsJson = Record<string, unknown>;

function zhsIsObj(v: unknown): v is ZhsJson {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function zhsStr(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  return "";
}

function zhsPick(obj: ZhsJson, keys: string[]): string {
  for (const k of keys) {
    const s = zhsStr(obj[k]);
    if (s !== "") return s;
  }
  return "";
}

function zhsNum(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/** Sign-in type: 1=QRCODE, 2=GESTURE, 3=PASSWORD, 4=LOCATION, 5=PHOTO. */
const ZHS_SIGN_TYPE_BY_NUM: Record<number, string> = {
  1: "QRCODE",
  2: "GESTURE",
  3: "PASSWORD",
  4: "LOCATION",
  5: "PHOTO",
};
const ZHS_SIGN_NUM_BY_NAME: Record<string, number> = {
  QRCODE: 1,
  GESTURE: 2,
  PASSWORD: 3,
  LOCATION: 4,
  PHOTO: 5,
};

function zhsNormSignType(v: unknown): { name: string; num: number } {
  if (typeof v === "number" && ZHS_SIGN_TYPE_BY_NUM[v]) {
    return { name: ZHS_SIGN_TYPE_BY_NUM[v]!, num: v };
  }
  const s = zhsStr(v).toUpperCase();
  if (ZHS_SIGN_NUM_BY_NAME[s]) return { name: s, num: ZHS_SIGN_NUM_BY_NAME[s]! };
  const n = Number(s);
  if (Number.isFinite(n) && n !== 0 && ZHS_SIGN_TYPE_BY_NUM[n]) {
    return { name: ZHS_SIGN_TYPE_BY_NUM[n]!, num: n };
  }
  return { name: "", num: 0 };
}

/** Minimal cookie jar: collects Set-Cookie across the login + SSO hops. */
class ZhsCookieJar {
  private cookies = new Map<string, string>();

  collect(res: Response): void {
    const headers = res.headers as Headers & { getSetCookie?: () => string[] };
    let raw: string[] = [];
    if (typeof headers.getSetCookie === "function") {
      try {
        raw = headers.getSetCookie();
      } catch {
        raw = [];
      }
    }
    if (raw.length === 0) {
      const single = res.headers.get("set-cookie");
      if (single) raw = [single];
    }
    for (const line of raw) {
      const pair = (line.split(";")[0] ?? "").trim();
      const eqAt = pair.indexOf("=");
      if (eqAt <= 0) continue;
      const name = pair.slice(0, eqAt).trim();
      const value = pair.slice(eqAt + 1).trim();
      if (name) this.cookies.set(name, value);
    }
  }

  header(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

type ZhsSession = { token: string; userId: string; jar: ZhsCookieJar; createdAt: number };

/** Polymas token + cookie jar, server memory only — never the database, never logs. */
const ZHS_SESSIONS = new Map<string, ZhsSession>();
const ZHS_SESSION_TTL_MS = 60 * 60 * 1000;

function zhsGetSession(account: string): ZhsSession | null {
  const s = ZHS_SESSIONS.get(account);
  if (!s) return null;
  if (Date.now() - s.createdAt > ZHS_SESSION_TTL_MS) {
    ZHS_SESSIONS.delete(account);
    return null;
  }
  return s;
}

function zhsDropSession(account: string): void {
  ZHS_SESSIONS.delete(account);
}

async function zhsReadJson(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/**
 * Pure-TS AES-128 (encrypt only) — action code may not import Node host
 * modules, so the 智慧树 login encryption cannot use node:crypto. Only
 * what zhsEncryptLoginBody needs: single-block encrypt + CBC + PKCS#7.
 * Verified byte-for-byte against openssl (FIPS-197 vector + a CBC sample
 * with the login key/IV below).
 */
const AES_SBOX: readonly number[] = [
  0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5, 0x30, 0x01, 0x67, 0x2b, 0xfe, 0xd7, 0xab, 0x76,
  0xca, 0x82, 0xc9, 0x7d, 0xfa, 0x59, 0x47, 0xf0, 0xad, 0xd4, 0xa2, 0xaf, 0x9c, 0xa4, 0x72, 0xc0,
  0xb7, 0xfd, 0x93, 0x26, 0x36, 0x3f, 0xf7, 0xcc, 0x34, 0xa5, 0xe5, 0xf1, 0x71, 0xd8, 0x31, 0x15,
  0x04, 0xc7, 0x23, 0xc3, 0x18, 0x96, 0x05, 0x9a, 0x07, 0x12, 0x80, 0xe2, 0xeb, 0x27, 0xb2, 0x75,
  0x09, 0x83, 0x2c, 0x1a, 0x1b, 0x6e, 0x5a, 0xa0, 0x52, 0x3b, 0xd6, 0xb3, 0x29, 0xe3, 0x2f, 0x84,
  0x53, 0xd1, 0x00, 0xed, 0x20, 0xfc, 0xb1, 0x5b, 0x6a, 0xcb, 0xbe, 0x39, 0x4a, 0x4c, 0x58, 0xcf,
  0xd0, 0xef, 0xaa, 0xfb, 0x43, 0x4d, 0x33, 0x85, 0x45, 0xf9, 0x02, 0x7f, 0x50, 0x3c, 0x9f, 0xa8,
  0x51, 0xa3, 0x40, 0x8f, 0x92, 0x9d, 0x38, 0xf5, 0xbc, 0xb6, 0xda, 0x21, 0x10, 0xff, 0xf3, 0xd2,
  0xcd, 0x0c, 0x13, 0xec, 0x5f, 0x97, 0x44, 0x17, 0xc4, 0xa7, 0x7e, 0x3d, 0x64, 0x5d, 0x19, 0x73,
  0x60, 0x81, 0x4f, 0xdc, 0x22, 0x2a, 0x90, 0x88, 0x46, 0xee, 0xb8, 0x14, 0xde, 0x5e, 0x0b, 0xdb,
  0xe0, 0x32, 0x3a, 0x0a, 0x49, 0x06, 0x24, 0x5c, 0xc2, 0xd3, 0xac, 0x62, 0x91, 0x95, 0xe4, 0x79,
  0xe7, 0xc8, 0x37, 0x6d, 0x8d, 0xd5, 0x4e, 0xa9, 0x6c, 0x56, 0xf4, 0xea, 0x65, 0x7a, 0xae, 0x08,
  0xba, 0x78, 0x25, 0x2e, 0x1c, 0xa6, 0xb4, 0xc6, 0xe8, 0xdd, 0x74, 0x1f, 0x4b, 0xbd, 0x8b, 0x8a,
  0x70, 0x3e, 0xb5, 0x66, 0x48, 0x03, 0xf6, 0x0e, 0x61, 0x35, 0x57, 0xb9, 0x86, 0xc1, 0x1d, 0x9e,
  0xe1, 0xf8, 0x98, 0x11, 0x69, 0xd9, 0x8e, 0x94, 0x9b, 0x1e, 0x87, 0xe9, 0xce, 0x55, 0x28, 0xdf,
  0x8c, 0xa1, 0x89, 0x0d, 0xbf, 0xe6, 0x42, 0x68, 0x41, 0x99, 0x2d, 0x0f, 0xb0, 0x54, 0xbb, 0x16,
];
const AES_RCON: readonly number[] = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36];

function aes128ExpandKey(key: Uint8Array): Uint8Array {
  const w = new Uint8Array(176);
  w.set(key.subarray(0, 16));
  for (let i = 4; i < 44; i++) {
    let t0 = w[(i - 1) * 4] ?? 0;
    let t1 = w[(i - 1) * 4 + 1] ?? 0;
    let t2 = w[(i - 1) * 4 + 2] ?? 0;
    let t3 = w[(i - 1) * 4 + 3] ?? 0;
    if (i % 4 === 0) {
      const r = AES_RCON[i / 4 - 1] ?? 0;
      const s0 = AES_SBOX[t1] ?? 0;
      const s1 = AES_SBOX[t2] ?? 0;
      const s2 = AES_SBOX[t3] ?? 0;
      const s3 = AES_SBOX[t0] ?? 0;
      t0 = s0 ^ r;
      t1 = s1;
      t2 = s2;
      t3 = s3;
    }
    w[i * 4] = (w[(i - 4) * 4] ?? 0) ^ t0;
    w[i * 4 + 1] = (w[(i - 4) * 4 + 1] ?? 0) ^ t1;
    w[i * 4 + 2] = (w[(i - 4) * 4 + 2] ?? 0) ^ t2;
    w[i * 4 + 3] = (w[(i - 4) * 4 + 3] ?? 0) ^ t3;
  }
  return w;
}

function aesXtime(x: number): number {
  return ((x << 1) ^ (x & 0x80 ? 0x1b : 0)) & 0xff;
}

function aes128EncryptBlock(roundKeys: Uint8Array, input: Uint8Array): Uint8Array {
  const s = new Uint8Array(16);
  for (let i = 0; i < 16; i++) s[i] = (input[i] ?? 0) ^ (roundKeys[i] ?? 0);
  for (let round = 1; round <= 10; round++) {
    for (let i = 0; i < 16; i++) s[i] = AES_SBOX[s[i] ?? 0] ?? 0;
    // ShiftRows (state is column-major: index = row + 4 * col).
    const t = new Uint8Array(s);
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) {
        s[r + 4 * c] = t[r + 4 * ((c + r) % 4)] ?? 0;
      }
    }
    if (round < 10) {
      for (let c = 0; c < 4; c++) {
        const a0 = s[4 * c] ?? 0;
        const a1 = s[4 * c + 1] ?? 0;
        const a2 = s[4 * c + 2] ?? 0;
        const a3 = s[4 * c + 3] ?? 0;
        s[4 * c] = aesXtime(a0) ^ (aesXtime(a1) ^ a1) ^ a2 ^ a3;
        s[4 * c + 1] = a0 ^ aesXtime(a1) ^ (aesXtime(a2) ^ a2) ^ a3;
        s[4 * c + 2] = a0 ^ a1 ^ aesXtime(a2) ^ (aesXtime(a3) ^ a3);
        s[4 * c + 3] = (aesXtime(a0) ^ a0) ^ a1 ^ a2 ^ aesXtime(a3);
      }
    }
    for (let i = 0; i < 16; i++) s[i] = (s[i] ?? 0) ^ (roundKeys[round * 16 + i] ?? 0);
  }
  return s;
}

function aes128CbcEncryptPkcs7(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Uint8Array {
  const roundKeys = aes128ExpandKey(key);
  const padLen = 16 - (data.length % 16);
  const padded = new Uint8Array(data.length + padLen);
  padded.set(data);
  padded.fill(padLen, data.length);
  const out = new Uint8Array(padded.length);
  let prev: Uint8Array = iv;
  for (let off = 0; off < padded.length; off += 16) {
    const block = new Uint8Array(16);
    for (let i = 0; i < 16; i++) block[i] = (padded[off + i] ?? 0) ^ (prev[i] ?? 0);
    const enc = aes128EncryptBlock(roundKeys, block);
    out.set(enc, off);
    prev = enc;
  }
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(bin);
}

/**
 * The login page's own $a() transform: AES-CBC-encrypt the JSON body
 * (key/IV hard-coded in Zhihuishu's public login bundle), base64 it,
 * send it as a JSON string.
 */
function zhsEncryptLoginBody(body: Record<string, unknown>): string {
  const enc = new TextEncoder();
  const key = enc.encode("bdas85990328dfpl");
  const iv = enc.encode("563216db1e1744c7");
  const encrypted = aes128CbcEncryptPkcs7(key, iv, enc.encode(JSON.stringify(body)));
  return JSON.stringify(bytesToBase64(encrypted));
}

type ZhsHtmlHop = { method: "GET" | "POST"; url: string; body?: string };

function zhsResolveUrl(u: string, base: string): string | null {
  try {
    return new URL(u, base).toString();
  } catch {
    return null;
  }
}

/** A 200 HTML page's next hop, if it redirects: meta refresh, an
 * auto-submit ticket-transfer form, or a JS location assignment that
 * is clearly an SSO continuation. A plain CAS *login* form (lt /
 * execution / _eventId + username/password fields) is a dead end, not
 * a redirect — it must never be POSTed — and JS location assignments
 * inside click handlers (e.g. a DownloadApp link) are not redirects
 * either, so both are ignored. Returns null when the page is a dead end. */
function zhsNextHopFromHtml(html: string, base: string): ZhsHtmlHop | null {
  // 1) <meta http-equiv="refresh" content="0;url=...">
  const meta = html.match(/<meta[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*>/i);
  if (meta) {
    const content = meta[0].match(/content\s*=\s*["']([^"']*)["']/i)?.[1] ?? "";
    const u = content.match(/url\s*=\s*['"]?\s*([^'";\s]+)/i)?.[1];
    if (u) {
      const resolved = zhsResolveUrl(u, base);
      if (resolved) return { method: "GET", url: resolved };
    }
  }
  // 2) A form is a redirect only when it carries a ticket (CAS/SAML
  // ticket transfer) or the page auto-submits a hidden-only form.
  const formOpen = html.match(/<form[^>]*>/i);
  if (formOpen && formOpen.index !== undefined) {
    const tag = formOpen[0];
    const action = tag.match(/action\s*=\s*["']([^"']+)["']/i)?.[1];
    if (action) {
      const method = (tag.match(/method\s*=\s*["']([^"']+)["']/i)?.[1] ?? "get").toLowerCase();
      const url = zhsResolveUrl(action, base);
      if (url) {
        const closeAt = html.toLowerCase().indexOf("</form>", formOpen.index);
        const scope = closeAt >= 0 ? html.slice(formOpen.index, closeAt) : html.slice(formOpen.index);
        const inputs: Array<[string, string]> = [];
        const inputRe = /<input[^>]*>/gi;
        let m: RegExpExecArray | null;
        while ((m = inputRe.exec(scope)) !== null) {
          const name = m[0].match(/name\s*=\s*["']([^"']*)["']/i)?.[1];
          if (name === undefined) continue;
          const value = m[0].match(/value\s*=\s*["']([^"']*)["']/i)?.[1] ?? "";
          inputs.push([name, value]);
        }
        const names = inputs.map(([n]) => n.toLowerCase());
        const isTicketForm = names.includes("ticket") || names.includes("samlresponse");
        const hasVisibleField = /<input[^>]*type\s*=\s*["']?(text|password|tel|email|number)["']?/i.test(scope);
        const hasAutoSubmit = /\.submit\s*\(\s*\)/.test(html);
        if (isTicketForm || (hasAutoSubmit && !hasVisibleField)) {
          const qs = inputs.map(([n, v]) => `${encodeURIComponent(n)}=${encodeURIComponent(v)}`).join("&");
          if (method === "post") return { method: "POST", url, body: qs };
          return { method: "GET", url: qs ? url + (url.includes("?") ? "&" : "?") + qs : url };
        }
      }
    }
  }
  // 3) JS redirect, only when the target is clearly an SSO continuation
  // (carries a ticket, points at ssoLogin, or carries a service param).
  const js =
    html.match(/(?:window\.)?location(?:\.href)?\s*=\s*["']([^"']+)["']/i) ??
    html.match(/location\.replace\(\s*["']([^"']+)["']\s*\)/i);
  if (js?.[1]) {
    const resolved = zhsResolveUrl(js[1], base);
    if (resolved && /(ticket=|ssoLogin|service=)/.test(resolved)) return { method: "GET", url: resolved };
  }
  return null;
}

type ZhsFollowResult = { hops: number; lastStatus: number | null; lastUrl: string; sawTicket: boolean };

/**
 * Follow redirects manually (passport CAS -> cloudapi ssoLogin ->
 * target), collecting cookies on every hop. Returns where the chain
 * ended instead of void, so the caller can diagnose a dead SSO hop.
 * A 200 HTML page is followed one more hop when it redirects via meta
 * refresh, an auto-submit form, or a JS location assignment. The
 * returned URL has its query string stripped (it may carry a ticket).
 */
async function zhsFetchFollow(jar: ZhsCookieJar, url: string, signal: AbortSignal): Promise<ZhsFollowResult> {
  const stripQuery = (u: string): string => {
    try {
      const parsed = new URL(u);
      return `${parsed.origin}${parsed.pathname}`;
    } catch {
      return u;
    }
  };
  let method: "GET" | "POST" = "GET";
  let current = url;
  let body: string | undefined;
  let lastStatus: number | null = null;
  let hops = 0;
  let sawTicket = false;
  for (let hop = 0; hop < 10; hop++) {
    let res: Response;
    try {
      res = await fetch(current, {
        method,
        headers: {
          ...ZHS_HEADERS,
          Cookie: jar.header(),
          ...(method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
        },
        body: method === "POST" ? body : undefined,
        redirect: "manual",
        signal,
      });
    } catch {
      return { hops, lastStatus, lastUrl: stripQuery(current), sawTicket };
    }
    jar.collect(res);
    lastStatus = res.status;
    hops++;
    if (current.includes("ticket=")) sawTicket = true;
    const loc = res.headers.get("location");
    if (loc && loc.includes("ticket=")) sawTicket = true;
    if (
      (res.status === 301 || res.status === 302 || res.status === 303 || res.status === 307 || res.status === 308) &&
      loc
    ) {
      const next = zhsResolveUrl(loc, current);
      if (!next) return { hops, lastStatus, lastUrl: stripQuery(current), sawTicket };
      current = next;
      method = "GET";
      body = undefined;
      continue;
    }
    if (res.status === 200) {
      const ct = res.headers.get("content-type") ?? "";
      if (ct.includes("text/html")) {
        let html = "";
        try {
          html = await res.text();
        } catch {
          return { hops, lastStatus, lastUrl: stripQuery(current), sawTicket };
        }
        const next = zhsNextHopFromHtml(html, current);
        if (next) {
          current = next.url;
          method = next.method;
          body = next.body;
          continue;
        }
      }
    }
    return { hops, lastStatus, lastUrl: stripQuery(current), sawTicket };
  }
  return { hops, lastStatus, lastUrl: stripQuery(current), sawTicket };
}

/**
 * Full login chain, exactly like the login page does in the browser
 * (verified 2026-11-23 against the public bundle
 * /assets/index-C5yo0atL.js + lazy chunk index-D8JpkCJd.js, userStore
 * goOnceLogin/LoginDirectly):
 *   0) GET the login page first so the login POST carries the same
 *      session cookies a browser would have;
 *   1) POST login/account (encrypted body + user-slid validate) ->
 *      {status:1, rt:{pwd (one-time password), cacheId, uuid, ...}};
 *   2) navigate to passport.zhihuishu.com/login?pwd=<rt.pwd>&service=
 *      <cloudapi ssoLogin?redirect=...> — the one-time pwd is what
 *      makes passport issue the CAS session (the old code called the
 *      same URL WITHOUT pwd, so no session was ever created and
 *      getToken answered 401 "拒绝访问，未登录！");
 *   3) POST getToken with no body for the Polymas token.
 * The password is used for this one login only and goes out of scope
 * when this returns. Returns the token, the user id (best-effort,
 * needed for gesture/QR submits), the cookie jar and diagnostics.
 */
async function zhsLoginOnce(
  account: string,
  password: string,
  validate: string,
  signal: AbortSignal,
): Promise<{ token: string; userId: string; jar: ZhsCookieJar; diag: ZhsLoginDiag } | { error: string; diag: ZhsLoginDiag }> {
  const jar = new ZhsCookieJar();
  const diag = zhsEmptyDiag();

  // 0) Pre-GET the login page (best-effort): collect its session cookies
  // into the same jar the login POST will use.
  try {
    const pre = await fetch("https://login.zhihuishu.com/", {
      method: "GET",
      headers: ZHS_HEADERS,
      redirect: "manual",
      signal,
    });
    jar.collect(pre);
    diag.preGetStatus = pre.status;
  } catch {
    // Non-fatal: the login POST may still work without it.
  }

  // 1) Account login (manual redirect so Set-Cookie is collected on
  // every hop instead of being dropped by the default follower).
  let loginRaw: unknown;
  try {
    let res = await fetch(ZHS_LOGIN_URL, {
      method: "POST",
      headers: { ...ZHS_HEADERS, Cookie: jar.header() },
      body: zhsEncryptLoginBody({ account, password, validate }),
      redirect: "manual",
      signal,
    });
    jar.collect(res);
    let hops = 0;
    while (
      (res.status === 301 || res.status === 302 || res.status === 303 || res.status === 307 || res.status === 308) &&
      res.headers.get("location") &&
      hops < 3
    ) {
      const next = zhsResolveUrl(res.headers.get("location")!, ZHS_LOGIN_URL);
      if (!next) break;
      res = await fetch(next, {
        method: "GET",
        headers: { ...ZHS_HEADERS, Cookie: jar.header() },
        redirect: "manual",
        signal,
      });
      jar.collect(res);
      hops++;
    }
    loginRaw = await zhsReadJson(res);
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      return { error: "智慧树登录超时（60 秒），请稍后再试", diag };
    }
    return { error: "服务器连不上智慧树登录接口：网络不通或对方暂时不可用，请稍后再试", diag };
  }
  if (!zhsIsObj(loginRaw)) {
    return { error: "智慧树登录接口返回的内容不是预期的数据格式，登录没有完成", diag };
  }
  const status = loginRaw["status"];
  diag.loginStatus = typeof status === "number" ? status : null;
  const rt = zhsIsObj(loginRaw["rt"]) ? loginRaw["rt"] : {};
  const oncePwd = zhsStr(rt["pwd"]);
  diag.hasOncePwd = oncePwd !== "";
  diag.isSkipPolymas = loginRaw["isSkipPolymas"] === true || rt["isSkipPolymas"] === true;
  if (status !== 1) {
    const msg = zhsStr(loginRaw["msg"] ?? loginRaw["message"]);
    if (msg) return { error: msg, diag };
    if (status === -13) {
      return { error: "这次登录触发了智慧树的安全验证，需要短信验证：请先去智慧树官网或知到 App 登录一次，通过验证后再回来", diag };
    }
    if (status === -5) {
      return { error: "智慧树说这个密码太简单了：请先去官网改一个更复杂的密码再回来", diag };
    }
    return { error: "智慧树登录没通过：请检查账号密码后重试", diag };
  }

  // 2) CAS SSO hop, the same navigation the login page does in the
  // browser: passport with the one-time password, then cloudapi ssoLogin.
  diag.stage = "sso";
  const service = encodeURIComponent(
    `${ZHS_POLYMAS}/oauth/login/ssoLogin?redirect=${encodeURIComponent("https://www.zhihuishu.com")}`,
  );
  const passportUrl = oncePwd
    ? `https://passport.zhihuishu.com/login?pwd=${encodeURIComponent(oncePwd)}&service=${service}`
    : `https://passport.zhihuishu.com/login?service=${service}`;
  const follow = await zhsFetchFollow(jar, passportUrl, signal);
  diag.hopCount = follow.hops;
  diag.ssoLastStatus = follow.lastStatus;
  diag.ssoLastUrl = follow.lastUrl;
  diag.ssoSawTicket = follow.sawTicket;

  // 3) Exchange the session for a Polymas token. The real browser flows
  // (login page bundle + Polymas H5 bundle) call this with axios .get and
  // no params; the POST variant 500s ("操作失败"), so mirror the GET.
  diag.stage = "token";
  let tokRaw: unknown;
  try {
    const res = await fetch(`${ZHS_POLYMAS}/teachingCenterAi/polymasApi/getToken`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Origin: "https://www.zhihuishu.com",
        Referer: "https://www.zhihuishu.com/",
        "User-Agent": ZHS_UA,
        Cookie: jar.header(),
      },
      signal,
    });
    jar.collect(res);
    tokRaw = await zhsReadJson(res);
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      return { error: "智慧树换 token 超时（60 秒），请稍后再试", diag };
    }
    return { error: "服务器连不上智慧树课堂接口：网络不通或对方暂时不可用，请稍后再试", diag };
  }
  const tokCodeRaw = zhsIsObj(tokRaw) ? tokRaw["code"] : undefined;
  diag.tokenCode = typeof tokCodeRaw === "number" || typeof tokCodeRaw === "string" ? tokCodeRaw : null;
  const token = zhsIsObj(tokRaw) ? zhsStr(tokRaw["data"]) : "";
  if ((diag.tokenCode !== 200 && diag.tokenCode !== "200") || !token) {
    const m = zhsIsObj(tokRaw) ? zhsStr(tokRaw["msg"] ?? tokRaw["message"]) : "";
    return { error: m || "登录成功了，但没换到智慧树课堂的 token，签到没法继续", diag };
  }

  // 4) User id, best-effort (gesture/QR submits carry it).
  let userId = "";
  try {
    const info = await zhsPolymasFetch(
      { token, userId: "", jar, createdAt: Date.now() },
      "GET",
      "/teachingCenterAi/user/getLoginUserInfo",
      undefined,
      signal,
    );
    const d = zhsIsObj(info.data) ? info.data : {};
    userId = zhsPick(d, ["userId", "id", "stuNid", "studentId"]);
  } catch {
    // Leave userId empty; submits omit the field and Polymas judges.
  }
  diag.stage = "done";
  return { token, userId, jar, diag };
}

type ZhsPolymasResult = { code: number | string; msg: string; data: unknown; httpStatus: number };

async function zhsPolymasFetch(
  session: ZhsSession,
  method: "GET" | "POST",
  path: string,
  body: Record<string, unknown> | undefined,
  signal: AbortSignal,
): Promise<ZhsPolymasResult> {
  let res: Response;
  try {
    res = await fetch(`${ZHS_POLYMAS}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json;charset=UTF-8",
        Authorization: session.token,
        Cookie: session.jar.header(),
        Origin: "https://classroom-h5.polymas.com",
        Referer: "https://classroom-h5.polymas.com/",
        "User-Agent": ZHS_UA,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      throw new Error("智慧树课堂接口响应超时（60 秒），请稍后再试");
    }
    throw new Error("服务器连不上智慧树课堂接口：网络不通或对方暂时不可用，请稍后再试");
  }
  session.jar.collect(res);
  const raw = await zhsReadJson(res);
  if (!zhsIsObj(raw)) {
    throw new Error(`智慧树课堂接口返回的内容不是预期的数据格式（HTTP ${res.status}），这次操作没有完成`);
  }
  return {
    code: raw["code"] as number | string,
    msg: zhsStr(raw["msg"] ?? raw["message"]),
    data: raw["data"],
    httpStatus: res.status,
  };
}

function zhsIsExpiredCode(code: number | string): boolean {
  return code === 401 || code === "401";
}

/** One row out of a task-list response, whatever envelope it arrived in. */
function zhsRowsOf(data: unknown): ZhsJson[] {
  if (Array.isArray(data)) return data.filter(zhsIsObj);
  if (!zhsIsObj(data)) return [];
  for (const k of ["list", "activities", "tasks", "items", "records", "data"]) {
    const v = data[k];
    if (Array.isArray(v)) return v.filter(zhsIsObj);
  }
  return [data];
}

/** A task row -> a sign-in candidate, or null when it is not sign-in-like. */
function zhsNormTaskRow(raw: ZhsJson): ZhsSignInActivity | null {
  const id = zhsPick(raw, ["activityTaskId", "id", "taskId"]);
  const signId = zhsPick(raw, ["signId", "bizId", "signInId"]);
  if (!id && !signId) return null;
  const typeRaw = raw["signType"] ?? raw["type"] ?? raw["taskType"] ?? raw["activityType"] ?? raw["interactionType"] ?? "";
  const { name } = zhsNormSignType(typeRaw);
  const title = zhsPick(raw, ["title", "name", "taskName", "courseName"]) || "签到";
  const haystack = `${title} ${zhsStr(typeRaw)} ${zhsStr(raw["activityType"])}`;
  const looksLikeSignIn = Boolean(signId) || /签到|sign/i.test(haystack) || name !== "" || zhsStr(typeRaw) === "";
  if (!looksLikeSignIn) return null;
  return {
    id: id || signId,
    signId: signId || id,
    title,
    courseName: zhsPick(raw, ["courseName", "courseTitle"]) || "",
    signType: name,
    status: zhsPick(raw, ["status", "state"]) || "",
    signed: false,
    finished: false,
    term: zhsStr(raw["term"] ?? ""),
    courseId: zhsStr(raw["courseId"] ?? ""),
    lessonId: zhsStr(raw["lessonId"] ?? ""),
  };
}

/** My sign-in record for one signId, best-effort. Null = no record found. */
async function zhsFetchRecord(
  session: ZhsSession,
  signId: string,
  signal: AbortSignal,
): Promise<{ signed: boolean; signInTime: string } | null> {
  const raw = await zhsPolymasFetch(
    session,
    "GET",
    `/student-app/api/sign/stu/record/stu-detail?signId=${encodeURIComponent(signId)}`,
    undefined,
    signal,
  );
  if (raw.code !== 200 && raw.code !== "200") return null;
  const rec = Array.isArray(raw.data)
    ? raw.data.find(zhsIsObj) ?? null
    : zhsIsObj(raw.data)
      ? raw.data
      : null;
  if (!rec) return null;
  const signInTime = zhsStr(rec["signInTime"] ?? rec["signTime"] ?? rec["createTime"] ?? rec["time"]);
  const signed =
    Boolean(signInTime) ||
    rec["hasSigned"] === true ||
    zhsStr(rec["status"]).toUpperCase() === "SUCCESS" ||
    zhsStr(rec["signStatus"]) === "1";
  if (!signed && !signInTime) return null;
  return { signed, signInTime };
}

// ---------- 智慧树验证码资源中转 (added 2026-11-23) ----------
//
// The owner's phone (US network) cannot reach NetEase 易盾's hosts at
// all — the AbleCaptcha scripts on base2.zhihuishu.com load, but
// load.min.js (cstaticdun.126.net), the captcha API (c.dun.163.com /
// c.dun.163yun.com — verified reachable from THIS server on
// 2026-11-23: /api/v2/getconf answered a proper JSONP param error)
// and the slider images (necaptcha.nosdn.127.net) never arrive, so the
// slider never opens (his screenshot: the dialog's 15 s watchdog
// fired). This relay fetches ONLY captcha resources server-side and
// hands them to the App, which injects them locally (scripts inline,
// JSONP executed in-page, images as data URLs, XHR answered from the
// relayed body). The captcha itself is still 智慧树/易盾's own and
// the owner still slides it himself — nothing is solved, faked, or
// bypassed; a failed fetch returns an honest error and the client
// falls back to loading the resource directly. The allowlist is
// exact hosts only, so this is not a general proxy: the two AbleCaptcha
// scripts, 易盾 static/API/collect hosts, and the slider-image CDN.
// Nothing is stored or logged; responses pass through byte-for-byte
// (text decoded as UTF-8, binary as base64).

type zhsCaptchaResourceResponse = {
  ok: boolean,
  message: string,
  status: number,
  contentType: string,
  encoding: "text" | "base64",
  body: string,

};

type ZhsCaptchaResourceResult = zhsCaptchaResourceResponse;

const ZHS_CAPTCHA_EXACT_HOSTS = new Set([
  "base2.zhihuishu.com",
  "collector2c.zhihuishu.com",
  "cstaticdun.126.net",
  "cstaticdun1.126.net",
  "cstatic.dun.163yun.com",
  "c.dun.163.com",
  "c.dun.163yun.com",
  "c-v6.dun.163.com",
  "c-v6.dun.163yun.com",
  "ac.dun.163.com",
  "ac.dun.163yun.com",
  "ac-v6.dun.163.com",
  "ac-v6.dun.163yun.com",
  "da.dun.163.com",
  "da.dun.163yun.com",
  "ir.dun.163.com",
  "ir.dun.163yun.com",
  "ir-sdk.dun.163.com",
  "ir-sdk.dun.163yun.com",
  "nstool.netease.com",
  // Slider-image hosts named by getconf's imageServer field (verified
  // in a live getconf response through this relay, 2026-11-23).
  "necaptcha-nosdn.126.net",
  "necaptcha.nosdn.126.net",
]);

function zhsCaptchaUrlAllowed(raw: string): URL | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const host = u.hostname.toLowerCase();
  if (ZHS_CAPTCHA_EXACT_HOSTS.has(host)) return u;
  if (host === "nosdn.127.net" || host.endsWith(".nosdn.127.net")) return u;
  // The SDK's error collector loads ip.js from a random only-d-* subdomain.
  if (host.endsWith(".nstool.netease.com")) return u;
  return null;
}

async function relayZhihuishuCaptchaResource(
  rawUrl: string,
  method: "GET" | "POST",
  body: string | null,
  contentType: string | null,
): Promise<ZhsCaptchaResourceResult> {
  const fail = (message: string): ZhsCaptchaResourceResult => ({
    ok: false,
    message,
    status: 0,
    contentType: "",
    encoding: "text",
    body: "",
  });
  const u = zhsCaptchaUrlAllowed(rawUrl);
  if (!u) return fail("这个地址不在验证码中转的范围里，已拦下");
  const ctrl = new AbortController();
  // 15 s: the SDK walks several fallback hosts per resource, so one
  // hanging host must fail fast enough for the next one to be tried.
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(u.toString(), {
      method,
      headers: {
        "User-Agent": ZHS_UA,
        Referer: "https://login.zhihuishu.com/",
        Accept: "*/*",
        ...(method === "POST" && body !== null
          ? { "Content-Type": contentType || "application/x-www-form-urlencoded" }
          : {}),
      },
      body: method === "POST" && body !== null ? body : undefined,
      signal: ctrl.signal,
    });
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length > 3 * 1024 * 1024) return fail("验证码资源太大了，中转没有送过去");
    const ct = res.headers.get("content-type") ?? "";
    const isText =
      ct.includes("javascript") ||
      ct.includes("json") ||
      ct.startsWith("text/") ||
      ct === "" ||
      /\.(?:js|css|json|html?)(?:[?#]|$)/i.test(u.pathname + u.search);
    if (isText && !ct.startsWith("image/")) {
      return {
        ok: true,
        message: "",
        status: res.status,
        contentType: ct,
        encoding: "text",
        body: new TextDecoder("utf-8").decode(buf),
      };
    }
    return {
      ok: true,
      message: "",
      status: res.status,
      contentType: ct,
      encoding: "base64",
      body: bytesToBase64(buf),
    };
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      return fail("服务器拉验证码资源超时了");
    }
    return fail("服务器连不上验证码服务（易盾），中转没拉到资源");
  } finally {
    clearTimeout(timer);
  }
}

async function relayZhihuishuPrepare(
  account: string,
  password: string,
  validate: string,
): Promise<ZhsPrepareResult> {
  const fail = (message: string, diag: ZhsLoginDiag): ZhsPrepareResult => {
    // Diagnostic log only: stage/status codes, never passwords, validate values, cookies or tokens.
    console.log("[zhs-prepare] fail:", message, JSON.stringify(diag));
    return { ok: false, message, sessionReady: false, ...diag };
  };
  if (!validate.trim()) return fail("验证码结果丢了：请重新滑一次验证码再试", zhsEmptyDiag());
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ZHS_TIMEOUT_MS);
  try {
    const res = await zhsLoginOnce(account, password, validate, ctrl.signal);
    if ("error" in res) return fail(res.error, res.diag);
    ZHS_SESSIONS.set(account, { token: res.token, userId: res.userId, jar: res.jar, createdAt: Date.now() });
    console.log("[zhs-prepare] ok:", JSON.stringify(res.diag));
    return { ok: true, message: "", sessionReady: true, ...res.diag };
  } finally {
    clearTimeout(timer);
  }
}

const ZHS_TASK_LIST_PATHS = [
  "/student-app/student/activityTask/list",
  "/student-course/activityTask/list",
  "/base-service/api/student/h5/activityTaskList",
];

async function relayZhihuishuSignInList(account: string): Promise<ZhsSignInListResult> {
  const fail = (message: string, needsLogin: boolean, tried: string[]): ZhsSignInListResult => ({
    ok: false,
    message,
    needsLogin,
    activities: [],
    discovery: { path: "", totalRows: 0, signLikeCount: 0, tried },
  });
  const session = zhsGetSession(account);
  if (!session) {
    return fail("智慧树还没登录：点「刷新」，滑一次验证码登录后再看签到", true, []);
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ZHS_TIMEOUT_MS);
  try {
    const tried: string[] = [];
    const rows: ZhsJson[] = [];
    let workedPath = "";
    const results = await Promise.allSettled(
      ZHS_TASK_LIST_PATHS.map((p) => zhsPolymasFetch(session, "POST", p, {}, ctrl.signal)),
    );
    results.forEach((r, i) => {
      const p = ZHS_TASK_LIST_PATHS[i]!;
      if (r.status === "rejected") {
        tried.push(`${p}: ${r.reason instanceof Error ? r.reason.message : "请求失败"}`);
        return;
      }
      tried.push(`${p}: code ${String(r.value.code)} http ${r.value.httpStatus} msg ${r.value.msg || ""}`);
      if (r.value.code !== 200 && r.value.code !== "200") return;
      if (!workedPath) workedPath = p;
      rows.push(...zhsRowsOf(r.value.data));
    });
    if (!workedPath) {
      // Diagnostic log only: endpoint paths + response codes, no tokens or cookies.
      console.log("[zhs-signin-list] no path worked:", JSON.stringify(tried));
      if (results.some((r) => r.status === "fulfilled" && zhsIsExpiredCode(r.value.code))) {
        zhsDropSession(account);
        return fail("智慧树登录过期了（token 被拒）：点「刷新」重新滑一次验证码，再看签到", true, tried);
      }
      return fail(
        "智慧树登录成功了，但三个活动列表接口都没返回可用的列表，暂时看不到进行中的签到——老师发起签到时，请去知到 App 群聊里点签到卡片",
        false,
        tried,
      );
    }
    const byKey = new Map<string, ZhsSignInActivity>();
    for (const row of rows) {
      const a = zhsNormTaskRow(row);
      if (!a) continue;
      const key = `${a.signId}|${a.id}`;
      if (!byKey.has(key)) byKey.set(key, a);
    }
    const activities = [...byKey.values()];
    // Best-effort: mark finished / already-signed rows so the card can
    // split pending from signed. A failed check leaves the flags off.
    await Promise.allSettled(
      activities
        .filter((a) => a.signId)
        .map(async (a) => {
          try {
            const [fin, has] = await Promise.all([
              zhsPolymasFetch(
                session,
                "GET",
                `/student-app/api/sign/check/finish?signId=${encodeURIComponent(a.signId)}`,
                undefined,
                ctrl.signal,
              ),
              zhsPolymasFetch(
                session,
                "GET",
                `/student-app/api/sign/student/hasSigned?signId=${encodeURIComponent(a.signId)}`,
                undefined,
                ctrl.signal,
              ),
            ]);
            if ((fin.code === 200 || fin.code === "200") && fin.data === true) a.finished = true;
            if ((has.code === 200 || has.code === "200") && has.data === true) a.signed = true;
          } catch {
            // leave the flags off
          }
        }),
    );
    console.log("[zhs-signin-list] ok:", workedPath, "rows:", rows.length, "activities:", activities.length);
    return {
      ok: true,
      message: "",
      needsLogin: false,
      activities,
      discovery: { path: workedPath, totalRows: rows.length, signLikeCount: activities.length, tried },
    };
  } finally {
    clearTimeout(timer);
  }
}

async function relayZhihuishuSignInDetail(
  account: string,
  signId: string,
  term: string | undefined,
  courseId: string | undefined,
  lessonId: string | undefined,
): Promise<ZhsSignInDetailResult> {
  const fail = (message: string, needsLogin: boolean): ZhsSignInDetailResult => ({
    ok: false,
    message,
    needsLogin,
    activity: null,
  });
  const session = zhsGetSession(account);
  if (!session) {
    return fail("智慧树还没登录：回到首页点「刷新」，滑一次验证码登录后再看签到", true);
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ZHS_TIMEOUT_MS);
  try {
    let raw: ZhsPolymasResult;
    try {
      raw = await zhsPolymasFetch(
        session,
        "GET",
        `/student-app/api/sign/detail?signId=${encodeURIComponent(signId)}`,
        undefined,
        ctrl.signal,
      );
    } catch (e) {
      return fail(e instanceof Error ? e.message : "取签到详情失败", false);
    }
    if (zhsIsExpiredCode(raw.code)) {
      zhsDropSession(account);
      return fail("智慧树登录过期了（token 被拒）：回到首页点「刷新」重新滑一次验证码，再看签到", true);
    }
    if (raw.code !== 200 && raw.code !== "200") {
      return fail(raw.msg || "取签到详情失败", false);
    }
    const data = zhsIsObj(raw.data) ? raw.data : {};
    const { name, num } = zhsNormSignType(data["signType"]);
    let location: { lng: number; lat: number; range: number } | null = null;
    const lsi = data["locationSignInfo"];
    let locObj: unknown = lsi;
    if (typeof lsi === "string" && lsi.trim()) {
      try {
        locObj = JSON.parse(lsi) as unknown;
      } catch {
        locObj = null;
      }
    }
    if (zhsIsObj(locObj)) {
      const lng = zhsNum(locObj["longitude"] ?? locObj["lng"]);
      const lat = zhsNum(locObj["latitude"] ?? locObj["lat"]);
      const range = zhsNum(locObj["maxDistance"] ?? locObj["distance"] ?? locObj["range"]);
      if (lng !== 0 || lat !== 0) {
        location = { lng, lat, range: range > 0 ? range : 300 };
      }
    }
    const isFinish = data["isFinish"] === true || zhsStr(data["status"]) === "FINISHED";
    let signed = false;
    try {
      const has = await zhsPolymasFetch(
        session,
        "GET",
        `/student-app/api/sign/student/hasSigned?signId=${encodeURIComponent(signId)}`,
        undefined,
        ctrl.signal,
      );
      if ((has.code === 200 || has.code === "200") && has.data === true) signed = true;
    } catch {
      // leave signed off
    }
    return {
      ok: true,
      message: "",
      needsLogin: false,
      activity: {
        signId,
        title: zhsPick(data, ["title", "name"]) || "签到",
        signType: name,
        signTypeNum: num,
        status: isFinish ? "ENDED" : "ACTIVE",
        endTime: zhsStr(data["endTime"]),
        isFinish,
        signPasswordSwitch: data["signPasswordSwitch"] === true,
        location,
        term: zhsStr(data["term"]) || term || "",
        courseId: zhsStr(data["courseId"]) || courseId || "",
        lessonId: zhsStr(data["lessonId"]) || lessonId || "",
        signed,
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

async function relayZhihuishuSignInRecords(account: string, signId: string): Promise<ZhsSignInRecordsResult> {
  const fail = (message: string, needsLogin: boolean): ZhsSignInRecordsResult => ({
    ok: false,
    message,
    needsLogin,
    record: null,
  });
  const session = zhsGetSession(account);
  if (!session) {
    return fail("智慧树还没登录：回到首页点「刷新」，滑一次验证码登录后再看签到", true);
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ZHS_TIMEOUT_MS);
  try {
    let record: { signed: boolean; signInTime: string } | null = null;
    try {
      record = await zhsFetchRecord(session, signId, ctrl.signal);
    } catch (e) {
      return fail(e instanceof Error ? e.message : "取签到记录失败", false);
    }
    return { ok: true, message: "", needsLogin: false, record };
  } finally {
    clearTimeout(timer);
  }
}

async function relayZhihuishuQrResolve(account: string, sceneKey: string): Promise<ZhsQrResolveResult> {
  const fail = (message: string, needsLogin: boolean): ZhsQrResolveResult => ({
    ok: false,
    message,
    needsLogin,
    signId: "",
    lessonId: "",
  });
  const session = zhsGetSession(account);
  if (!session) {
    return fail("智慧树还没登录：回到首页点「刷新」，滑一次验证码登录后再扫码", true);
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ZHS_TIMEOUT_MS);
  try {
    let raw: ZhsPolymasResult;
    try {
      raw = await zhsPolymasFetch(
        session,
        "GET",
        `/teacher-app/qrcode/info?sceneKey=${encodeURIComponent(sceneKey)}`,
        undefined,
        ctrl.signal,
      );
    } catch (e) {
      return fail(e instanceof Error ? e.message : "二维码解析失败", false);
    }
    if (zhsIsExpiredCode(raw.code)) {
      zhsDropSession(account);
      return fail("智慧树登录过期了（token 被拒）：回到首页点「刷新」重新滑一次验证码，再扫码", true);
    }
    if (raw.code !== 200 && raw.code !== "200") {
      return fail(raw.msg || "二维码解析失败", false);
    }
    const param = zhsIsObj(raw.data) && zhsIsObj(raw.data["param"]) ? raw.data["param"] : {};
    const signId = zhsPick(param, ["signId", "bizId"]);
    if (!signId) {
      return fail("这个二维码里没有认出签到：请确认扫的是老师发的签到二维码", false);
    }
    return {
      ok: true,
      message: "",
      needsLogin: false,
      signId,
      lessonId: zhsPick(param, ["lessonId"]),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function relayZhihuishuSignInSubmit(
  account: string,
  args: {
    signId: string;
    signType: string;
    term: string;
    courseId: string;
    lessonId: string;
    lat: number | null;
    lng: number | null;
    address: string | null;
    gesture: string | null;
    passwordText: string | null;
  },
): Promise<ZhsSignInSubmitResult> {
  const fail = (message: string, needsLogin: boolean): ZhsSignInSubmitResult => ({
    ok: false,
    message,
    needsLogin,
    status: "",
    signInTime: "",
    gestureResult: "",
    gestureCountdownSeconds: null,
    gestureRemaining: null,
  });

  // Format checks only — the sign-in itself is judged by Polymas.
  if (args.signType === "PHOTO") {
    return fail("拍照签到还没法在 App 里交：照片提交格式没验证过，请去知到 App 群聊里点签到卡片拍照签到", false);
  }
  if (args.signType === "GESTURE") {
    const g = args.gesture ?? "";
    if (!/^[1-9]{4,9}$/.test(g) || new Set(g.split("")).size !== g.length) {
      return fail("手势至少连 4 个不同的点，签到没有提交", false);
    }
  }
  if (args.signType === "LOCATION") {
    if (args.lat === null || args.lng === null) return fail("先取一下定位，再点提交", false);
    if (args.lat < -90 || args.lat > 90 || args.lng < -180 || args.lng > 180) {
      return fail("定位不对，签到没有提交", false);
    }
  }
  if (args.signType === "PASSWORD" && !(args.passwordText ?? "").trim()) {
    return fail("先输入老师给的签到口令，再点提交", false);
  }

  const session = zhsGetSession(account);
  if (!session) {
    return fail("智慧树还没登录：回到首页点「刷新」，滑一次验证码登录后再签到", true);
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ZHS_TIMEOUT_MS);
  try {
    const body: Record<string, unknown> = {
      signId: args.signId,
      isTeacher: false,
      operateType: "SIGN_IN",
      signIn: true,
      signType: args.signType,
      term: args.term,
      courseId: args.courseId,
      lessonId: args.lessonId,
    };
    if (args.signType === "LOCATION") {
      body["locationSignInfo"] = {
        longitude: String(args.lng),
        latitude: String(args.lat),
        address: args.address ?? "",
      };
    }
    if (args.signType === "GESTURE") {
      if (session.userId) body["userId"] = session.userId;
      body["remark"] = "";
      body["signGesture"] = args.gesture;
    }
    if (args.signType === "QRCODE") {
      if (session.userId) body["userId"] = session.userId;
      body["remark"] = "";
    }
    if (args.signType === "PASSWORD") {
      if (session.userId) body["userId"] = session.userId;
      body["remark"] = "";
      // Field name not verified against the official JS (the password
      // form lives in a lazy chunk that was not captured); signPassword
      // matches the detail's signPasswordSwitch naming. If Polymas
      // rejects it, its message is returned verbatim below.
      body["signPassword"] = args.passwordText;
    }

    let raw: ZhsPolymasResult;
    try {
      raw = await zhsPolymasFetch(session, "POST", "/student-app/api/sign/student", body, ctrl.signal);
    } catch (e) {
      return fail(e instanceof Error ? e.message : "签到提交失败", false);
    }
    if (zhsIsExpiredCode(raw.code)) {
      zhsDropSession(account);
      return fail("智慧树登录过期了（token 被拒）：回到首页点「刷新」重新滑一次验证码，再签到", true);
    }
    if (raw.code !== 200 && raw.code !== "200") {
      return fail(raw.msg || "签到没有成功", false);
    }

    // Gesture responses carry their own result code in data.type:
    // "0" = success (value = sign-in time), "1" = wrong + locked with
    // countdownSeconds, "2" = wrong + remaining attempts in value.
    let gestureResult = "";
    let gestureCountdownSeconds: number | null = null;
    let gestureRemaining: number | null = null;
    let signInTime = "";
    if (args.signType === "GESTURE" && zhsIsObj(raw.data)) {
      const t = zhsStr(raw.data["type"]);
      if (t === "1") {
        gestureResult = "wrong-locked";
        gestureCountdownSeconds = zhsNum(raw.data["countdownSeconds"]) || null;
        const mins = gestureCountdownSeconds !== null ? Math.max(1, Math.ceil(gestureCountdownSeconds / 60)) : 0;
        return {
          ...fail(
            mins > 0 ? `手势错了，请 ${mins} 分钟后再试` : "手势错了，暂时被锁定了，请过一会儿再试",
            false,
          ),
          gestureResult,
          gestureCountdownSeconds,
          gestureRemaining,
        };
      }
      if (t === "2") {
        gestureResult = "wrong-retry";
        gestureRemaining = zhsNum(raw.data["value"]) || null;
        return {
          ...fail(
            gestureRemaining !== null ? `手势错了，你还有 ${gestureRemaining} 次机会` : "手势错了，请再试一次",
            false,
          ),
          gestureResult,
          gestureCountdownSeconds,
          gestureRemaining,
        };
      }
      if (t === "0") {
        gestureResult = "ok";
        signInTime = zhsStr(raw.data["value"]);
      }
    }
    if (!signInTime && zhsIsObj(raw.data)) {
      signInTime = zhsStr(raw.data["signInTime"] ?? raw.data["signTime"]);
    }

    // Confirm against the record Polymas actually stored — the submit
    // response is not taken on trust alone.
    try {
      const rec = await zhsFetchRecord(session, args.signId, ctrl.signal);
      if (rec && rec.signed) signInTime = rec.signInTime || signInTime;
    } catch {
      // The submit already succeeded; the stored record just could not
      // be re-read this time — the submit response still stands.
    }
    return {
      ok: true,
      message: "",
      needsLogin: false,
      status: "SUCCESS",
      signInTime,
      gestureResult,
      gestureCountdownSeconds,
      gestureRemaining,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---------- actions ----------

// The 拓强 backend (http://app.tqdianbiao.com/App2/) is HTTP-only and
// sends no CORS headers, so the phone browser cannot call it directly —
// same relay pattern as 教务. Protocol verified live 2026-11-23 (full
// notes: ~/workspace/tuoqiang/api-notes.md §4 + §13): every call is a
// form POST { data: Base64(compact JSON + common fields), _sign:
// md5(data + "__SIGN__" + uuid) }; the response envelope's data is
// Base64 of the payload envelope { state, msg, data } and is
// signature-checked before use. Action code may not import Node host
// modules, so MD5 is the pure-TS implementation below (verified against
// the RFC 1321 test vectors, incl. multi-block and UTF-8 inputs) and
// Base64 is UTF-8-safe btoa/atob.
//
// Query flow (stateless per call, nothing about the query is stored):
// fresh uuid `scan-<16 hex>` → AppAccount/anonymous {version:2025} →
// throwaway account + token → getUserlist to resolve the internal
// meterId by 表号/客户号 (after a best-effort getUnBindUserList +
// bindCustormers pass) → if still unresolved and the caller supplied
// 姓名+手机号, one addUserByPhone bind attempt, then getUserlist again
// → AppMain/detail → balance parsed from the「使用详情」card. There is
// NO scan-code→balance endpoint (§13.1): an unbound meter honestly
// returns needBind. Query-only — no recharge / 合闸 / 拉闸 calls exist
// here. The anonymous account is discarded when the call ends.

function md5Hex(input: string): string {
  const S: number[] = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];
  const K: number[] = [];
  for (let i = 0; i < 64; i++) K.push(Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296));
  const bytes = new TextEncoder().encode(input);
  const bitLen = bytes.length * 8;
  const withPad: number[] = [...bytes, 0x80];
  while (withPad.length % 64 !== 56) withPad.push(0);
  for (let i = 0; i < 8; i++) withPad.push(Math.floor(bitLen / 2 ** (8 * i)) % 256);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const rotl = (x: number, s: number) => ((x << s) | (x >>> (32 - s))) >>> 0;
  for (let off = 0; off < withPad.length; off += 64) {
    const M: number[] = [];
    for (let j = 0; j < 16; j++) {
      const p = off + j * 4;
      M.push(((withPad[p] ?? 0) | ((withPad[p + 1] ?? 0) << 8) | ((withPad[p + 2] ?? 0) << 16) | ((withPad[p + 3] ?? 0) << 24)) >>> 0);
    }
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F: number, g: number;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      const tmp = D; D = C; C = B;
      B = (B + rotl((A + F + (K[i] ?? 0) + (M[g] ?? 0)) >>> 0, S[i] ?? 0)) >>> 0;
      A = tmp;
    }
    a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
  }
  const hex = (n: number) =>
    [0, 8, 16, 24].map((s) => ((n >>> s) & 0xff).toString(16).padStart(2, "0")).join("");
  return hex(a0) + hex(b0) + hex(c0) + hex(d0);
}

function b64EncodeUtf8(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function b64DecodeUtf8(b64: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

const TQ_BASE = "http://app.tqdianbiao.com/App2/";
const TQ_TIMEOUT_MS = 20000;

type TqEnvelope = { state: number; msg: string; data: unknown };

function tqObj(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

async function tqPost(
  path: string,
  payload: Record<string, unknown>,
  uuid: string,
  token: string,
): Promise<TqEnvelope> {
  const full = {
    ...payload,
    deviceType: "browser",
    platform: "Linux",
    uuid,
    av: "",
    rv: "",
    nv: 1,
    app_token: token,
    cookie: "",
  };
  const data = b64EncodeUtf8(JSON.stringify(full));
  const sign = md5Hex(`${data}__SIGN__${uuid}`);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TQ_TIMEOUT_MS);
  try {
    const res = await fetch(TQ_BASE + path, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ data, _sign: sign }).toString(),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let outer: Record<string, unknown> | null = null;
    try {
      outer = tqObj(JSON.parse(text) as unknown);
    } catch {
      outer = null;
    }
    if (!outer) throw new Error("拓强接口返回的内容看不懂，这次没查成");
    if (typeof outer.data === "string") {
      if (typeof outer._sign === "string" && md5Hex(`${outer.data}__SIGN__${uuid}`) !== outer._sign) {
        throw new Error("拓强接口返回的签名对不上，这次结果先不用");
      }
      let inner: unknown = null;
      try {
        inner = JSON.parse(b64DecodeUtf8(outer.data)) as unknown;
      } catch {
        inner = null;
      }
      const innerObj = tqObj(inner);
      if (innerObj && "state" in innerObj) {
        return {
          state: typeof innerObj.state === "number" ? innerObj.state : 0,
          msg: typeof innerObj.msg === "string" ? innerObj.msg : "",
          data: innerObj.data ?? null,
        };
      }
      return {
        state: typeof outer.state === "number" ? outer.state : 0,
        msg: typeof outer.msg === "string" ? outer.msg : "",
        data: inner,
      };
    }
    return {
      state: typeof outer.state === "number" ? outer.state : 0,
      msg: typeof outer.msg === "string" ? outer.msg : "",
      data: outer.data ?? null,
    };
  } finally {
    clearTimeout(timer);
  }
}

function tqParseCode(raw: string): { meterNo: string; customerId: string } | null {
  const s = raw.trim();
  const inText = s.match(/(\d{6,}\.\d+\.[0-9a-fA-F]+)/);
  const code = inText ? (inText[1] ?? s) : s;
  const parts = code.split(".");
  const first = parts[0] ?? "";
  const second = parts[1] ?? "";
  if (parts.length >= 2 && /^\d+$/.test(first) && /^\d+$/.test(second)) {
    return { meterNo: first, customerId: second };
  }
  if (/^\d{6,}$/.test(code)) return { meterNo: code, customerId: "" };
  return null;
}

function tqRandomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return [...arr].map((b) => b.toString(16).padStart(2, "0")).join("");
}

type elecResponse = {
  ok: boolean,
  status: "ok" | "needBind" | "error",
  message: string,
  balanceText: string,
  syncTime: string,
  totalKwh: string,
  meterNo: string,

};

type ElecResult = elecResponse;

async function relayElecBalance(
  codeRaw: string,
  name: string,
  phone: string,
): Promise<ElecResult> {
  const fail = (status: "needBind" | "error", message: string): ElecResult => ({
    ok: false,
    status,
    message,
    balanceText: "",
    syncTime: "",
    totalKwh: "",
    meterNo: "",
  });
  const parsed = tqParseCode(codeRaw);
  if (!parsed) {
    return fail("error", "这个码认不出来：扫电表上的二维码，或者直接填表号再查。");
  }
  const uuid = `scan-${tqRandomHex(8)}`;
  try {
    const login = await tqPost("AppAccount/anonymous", { version: 2025 }, uuid, "");
    if (login.state !== 0) {
      return fail("error", login.msg || "拓强那边登录没成功，再试一次");
    }
    const ld = tqObj(login.data) ?? {};
    const token = typeof ld.token === "string" ? ld.token : "";
    const account = typeof ld.appAccount === "string" ? ld.appAccount : "";
    if (!token || !account) {
      return fail("error", "拓强那边没返回登录凭证，再试一次");
    }

    const findMeter = async (): Promise<{ meterId: string; customerId: string; type: string } | null> => {
      const env = await tqPost("AppMain/getUserlist", { account }, uuid, token);
      if (env.state !== 0 || !Array.isArray(env.data)) return null;
      for (const userRow of env.data) {
        const items = tqObj(userRow)?.items;
        if (!Array.isArray(items)) continue;
        for (const item of items) {
          const o = tqObj(item);
          if (!o) continue;
          const address = String(o.address ?? "");
          const cust = String(o.customerid ?? "");
          if (address === parsed.meterNo || (parsed.customerId !== "" && cust === parsed.customerId)) {
            return {
              meterId: String(o.id ?? ""),
              customerId: cust,
              type: String(o.partern_type ?? "0"),
            };
          }
        }
      }
      return null;
    };

    let meter = await findMeter();
    if (!meter) {
      // Best-effort: pull whatever is bindable onto the throwaway account.
      await tqPost("AppMain/getUnBindUserList", {}, uuid, token).catch(() => null);
      await tqPost("AppMain/bindCustormers", {}, uuid, token).catch(() => null);
      meter = await findMeter();
    }
    if (!meter && name.trim() !== "" && phone.trim() !== "") {
      const bind = await tqPost(
        "AppMain/addUserByPhone",
        { label: parsed.meterNo, name: name.trim(), phone: phone.trim() },
        uuid,
        token,
      );
      if (bind.state !== 0) {
        return fail("needBind", bind.msg || "按姓名和手机号没绑上这块表，核对一下再试");
      }
      meter = await findMeter();
    }
    if (!meter) {
      return fail(
        "needBind",
        "这块表还没绑到任何能查的账号上，光凭扫码查不到余额。填户主姓名和手机号可以绑一次再查；或者直接去微信小程序《我的水电管家》扫码看余额，那边是你微信绑好的。",
      );
    }

    const detail = await tqPost(
      "AppMain/detail",
      { customerId: meter.customerId, meterId: meter.meterId, type: meter.type },
      uuid,
      token,
    );
    if (detail.state !== 0) {
      return fail("error", detail.msg || "拓强那边没返回这块表的详情，再试一次");
    }
    let balanceText = "";
    let syncTime = "";
    let totalKwh = "";
    let meterNo = parsed.meterNo;
    if (Array.isArray(detail.data)) {
      for (const cardRaw of detail.data) {
        const card = tqObj(cardRaw);
        if (!card || !Array.isArray(card.items)) continue;
        const kv = new Map<string, string>();
        for (const pair of card.items) {
          if (Array.isArray(pair) && pair.length >= 2) {
            kv.set(String(pair[0]), String(pair[1]));
          }
        }
        if (card.name === "使用详情") {
          balanceText = kv.get("当前剩余金额") ?? "";
          syncTime = kv.get("剩余金额同步时间") ?? "";
          totalKwh = kv.get("当前总电量") ?? "";
        }
        if (card.name === "电表信息") {
          const no = kv.get("表号");
          if (no) meterNo = no;
        }
      }
    }
    if (!balanceText) {
      return fail("error", "拓强那边返回了详情，但里面没有「当前剩余金额」这一项，这次先不显示");
    }
    return {
      ok: true,
      status: "ok",
      message: "查到了",
      balanceText,
      syncTime,
      totalKwh,
      meterNo,
    };
  } catch (e) {
    return fail("error", e instanceof Error ? e.message : "查电费没成功，再试一次");
  }
}

export {
  relayJiaowuSync,
  relayGrades,
  relayIdleClassrooms,
  relayIdleClassroomOptions,
  relayLazynutAssignments,
  relayLazynutAssignmentDetail,
  relayLazynutUploadImage,
  relayLazynutDeleteImage,
  relayLazynutSave,
  relayLazynutSubmission,
  relayLazynutSignInList,
  relayLazynutSignInDetail,
  relayLazynutSignInRecords,
  relayLazynutSignInSubmit,
  relayZhihuishuCaptchaResource,
  relayZhihuishuPrepare,
  relayZhihuishuSignInList,
  relayZhihuishuSignInDetail,
  relayZhihuishuSignInRecords,
  relayZhihuishuQrResolve,
  relayZhihuishuSignInSubmit,
  relayElecBalance,
};
